/**
 * Codex SDK wrapper
 * Provides async generator interface for streaming Codex responses.
 *
 * Dual-path dispatch:
 *   - SDK path: Uses @openai/codex-sdk directly (for basic workflows)
 *   - Tool-loop path: Uses Archon's agentic tool loop via OpenAI API
 *     (for features the SDK doesn't support: allowed_tools, denied_tools,
 *      hooks, skills, systemPrompt, effort, thinking, maxBudgetUsd,
 *      fallbackModel, betas, sandbox, mcpConfigs)
 *
 * With Bun runtime, we can directly import ESM packages without the
 * dynamic import workaround that was needed for CommonJS/Node.js.
 */
import {
  Codex,
  type ThreadOptions,
  type TurnOptions,
  type TurnCompletedEvent,
} from '@openai/codex-sdk';
import {
  type AssistantRequestOptions,
  type IAssistantClient,
  type MessageChunk,
  type TokenUsage,
} from '../types';
import { createLogger } from '@archon/paths';
import { executeToolLoop, type ChatMessage, type ToolLoopConfig } from './tool-loop';
import { toolDefinitions } from './tool-definitions';
import { McpToolProvider, type McpServerConfig } from './mcp-client';
import { loadSkills, type SkillContext } from './skill-loader';
import { ContextWindowManager } from './context-window';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('client.codex');
  return cachedLog;
}

// Singleton Codex instance
let codexInstance: Codex | null = null;

/**
 * Get or create Codex SDK instance
 * Synchronous now that we have direct ESM import
 */
function getCodex(): Codex {
  if (!codexInstance) {
    codexInstance = new Codex();
  }
  return codexInstance;
}

/**
 * Build thread options for Codex SDK
 * Extracted to avoid duplication across thread creation paths
 */
function buildThreadOptions(cwd: string, options?: AssistantRequestOptions): ThreadOptions {
  return {
    workingDirectory: cwd,
    skipGitRepoCheck: true,
    sandboxMode: 'danger-full-access', // Full filesystem access (needed for git worktree operations)
    networkAccessEnabled: true, // Allow network calls (GitHub CLI, HTTP requests)
    approvalPolicy: 'never', // Auto-approve all operations without user confirmation
    model: options?.model,
    modelReasoningEffort: options?.modelReasoningEffort,
    webSearchMode: options?.webSearchMode,
    additionalDirectories: options?.additionalDirectories,
  };
}

const CODEX_MODEL_FALLBACKS: Record<string, string> = {
  'gpt-5.3-codex': 'gpt-5.2-codex',
};

function isModelAccessError(errorMessage: string): boolean {
  const m = errorMessage.toLowerCase();
  const hasModel = m.includes('model');
  const hasAvailabilitySignal =
    m.includes('not available') || m.includes('not found') || m.includes('access denied');
  return hasModel && hasAvailabilitySignal;
}

function buildModelAccessMessage(model?: string): string {
  const normalizedModel = model?.trim();
  const selectedModel = normalizedModel || 'the configured model';
  const suggested = normalizedModel ? CODEX_MODEL_FALLBACKS[normalizedModel] : undefined;

  const fixLine = suggested
    ? `To fix: update your model in ~/.archon/config.yaml:\n  assistants:\n    codex:\n      model: ${suggested}`
    : 'To fix: update your model in ~/.archon/config.yaml to one your account can access.';

  const workflowLine = suggested
    ? `Or set it per-workflow with \`model: ${suggested}\` in workflow YAML.`
    : 'Or set it per-workflow with a valid `model:` in workflow YAML.';

  return `❌ Model "${selectedModel}" is not available for your account.\n\n${fixLine}\n\n${workflowLine}`;
}

/** Max retries for transient failures (3 = 4 total attempts).
 *  Mirrors ClaudeClient retry logic — Codex process crashes are similarly intermittent. */
const MAX_SUBPROCESS_RETRIES = 3;

/** Delay between retries in milliseconds */
const RETRY_BASE_DELAY_MS = 2000;

/** Patterns indicating rate limiting in error messages */
const RATE_LIMIT_PATTERNS = ['rate limit', 'too many requests', '429', 'overloaded'];

/** Patterns indicating auth issues in error messages */
const AUTH_PATTERNS = [
  'credit balance',
  'unauthorized',
  'authentication',
  'invalid token',
  '401',
  '403',
];

/** Patterns indicating a transient process crash (worth retrying) */
const SUBPROCESS_CRASH_PATTERNS = ['exited with code', 'killed', 'signal', 'codex exec'];

/** OpenAI chat/completions endpoint used by the tool-loop fallback path. */
const OPENAI_CHAT_ENDPOINT = 'https://api.openai.com/v1/chat/completions';

/**
 * Features the Codex SDK v0.116.0 supports natively:
 *   model, modelReasoningEffort, webSearchMode, additionalDirectories,
 *   outputFormat (as outputSchema), abortSignal
 *
 * Features requiring the tool-loop fallback:
 *   tools (allowed_tools), disallowedTools (denied_tools), hooks,
 *   mcpConfigs, skills, systemPrompt, effort, thinking, maxBudgetUsd,
 *   fallbackModel, betas, sandbox
 */
function needsToolLoopFallback(options?: AssistantRequestOptions): boolean {
  if (!options) return false;
  return !!(
    options.tools !== undefined ||
    options.disallowedTools !== undefined ||
    options.hooks ||
    options.mcpConfigs ||
    options.skills ||
    options.systemPrompt ||
    options.effort ||
    options.thinking ||
    options.maxBudgetUsd !== undefined ||
    options.fallbackModel ||
    options.betas ||
    options.sandbox
  );
}

function classifyCodexError(
  errorMessage: string
): 'rate_limit' | 'auth' | 'crash' | 'model_access' | 'unknown' {
  if (isModelAccessError(errorMessage)) return 'model_access';
  const m = errorMessage.toLowerCase();
  if (RATE_LIMIT_PATTERNS.some(p => m.includes(p))) return 'rate_limit';
  if (AUTH_PATTERNS.some(p => m.includes(p))) return 'auth';
  if (SUBPROCESS_CRASH_PATTERNS.some(p => m.includes(p))) return 'crash';
  return 'unknown';
}

function extractUsageFromCodexEvent(event: TurnCompletedEvent): TokenUsage {
  if (!event.usage) {
    getLog().warn({ eventType: event.type }, 'codex.usage_null_on_turn_completed');
    return { input: 0, output: 0 };
  }
  return {
    input: event.usage.input_tokens,
    output: event.usage.output_tokens,
  };
}

/**
 * Codex AI assistant client
 * Implements generic IAssistantClient interface
 */
export class CodexClient implements IAssistantClient {
  private readonly retryBaseDelayMs: number;

  constructor(options?: { retryBaseDelayMs?: number }) {
    this.retryBaseDelayMs = options?.retryBaseDelayMs ?? RETRY_BASE_DELAY_MS;
  }

  /**
   * Send a query to Codex and stream responses.
   *
   * Dispatch logic:
   *   - If the request uses features the Codex SDK doesn't support natively,
   *     route through Archon's tool loop (calling OpenAI API with the Codex model).
   *   - Otherwise, use the native Codex SDK path.
   *
   * @param prompt - User message or prompt
   * @param cwd - Working directory for Codex
   * @param resumeSessionId - Optional thread ID to resume
   */
  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    options?: AssistantRequestOptions
  ): AsyncGenerator<MessageChunk> {
    // ── Dispatch: tool-loop fallback for unsupported features ──
    if (needsToolLoopFallback(options)) {
      getLog().info(
        {
          features: getUnsupportedFeatures(options),
          model: options?.model,
        },
        'codex.tool_loop_dispatch'
      );
      yield* this.sendQueryViaToolLoop(prompt, cwd, options);
      return;
    }

    getLog().debug({ model: options?.model }, 'codex.sdk_dispatch');

    const codex = getCodex();
    const threadOptions = buildThreadOptions(cwd, options);

    // Check if already aborted before starting
    if (options?.abortSignal?.aborted) {
      throw new Error('Query aborted');
    }

    // Track if we fell back from a failed resume (to notify user)
    let sessionResumeFailed = false;

    // Get or create thread (synchronous operations!)
    let thread;
    if (resumeSessionId) {
      getLog().debug({ sessionId: resumeSessionId }, 'resuming_thread');
      try {
        // NOTE: resumeThread is synchronous, not async
        // IMPORTANT: Must pass options when resuming!
        thread = codex.resumeThread(resumeSessionId, threadOptions);
      } catch (error) {
        getLog().error({ err: error, sessionId: resumeSessionId }, 'resume_thread_failed');
        // Fall back to creating new thread
        try {
          thread = codex.startThread(threadOptions);
        } catch (startError) {
          const err = startError as Error;
          if (isModelAccessError(err.message)) {
            throw new Error(buildModelAccessMessage(options?.model));
          }
          throw new Error(`Codex query failed: ${err.message}`);
        }
        sessionResumeFailed = true;
      }
    } else {
      getLog().debug({ cwd }, 'starting_new_thread');
      // NOTE: startThread is synchronous, not async
      try {
        thread = codex.startThread(threadOptions);
      } catch (error) {
        const err = error as Error;
        if (isModelAccessError(err.message)) {
          throw new Error(buildModelAccessMessage(options?.model));
        }
        throw new Error(`Codex query failed: ${err.message}`);
      }
    }

    // Notify user if session resume failed (don't silently lose context)
    if (sessionResumeFailed) {
      yield {
        type: 'system',
        content: '⚠️ Could not resume previous session. Starting fresh conversation.',
      };
    }

    let lastTodoListSignature: string | undefined;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_SUBPROCESS_RETRIES; attempt++) {
      // Check abort signal before each attempt
      if (options?.abortSignal?.aborted) {
        throw new Error('Query aborted');
      }

      // On retries, create a fresh thread (crashed thread is invalid)
      if (attempt > 0) {
        getLog().debug({ cwd, attempt }, 'starting_new_thread');
        try {
          thread = codex.startThread(threadOptions);
        } catch (startError) {
          const err = startError as Error;
          if (isModelAccessError(err.message)) {
            throw new Error(buildModelAccessMessage(options?.model));
          }
          throw new Error(`Codex query failed: ${err.message}`);
        }
      }

      try {
        // Build per-turn options (structured output schema, abort signal)
        const turnOptions: TurnOptions = {};
        if (options?.outputFormat) {
          turnOptions.outputSchema = options.outputFormat.schema;
        }
        if (options?.abortSignal) {
          turnOptions.signal = options.abortSignal;
        }

        // Run streamed query (this IS async)
        const result = await thread.runStreamed(prompt, turnOptions);

        // Process streaming events
        for await (const event of result.events) {
          // Check abort signal between events
          if (options?.abortSignal?.aborted) {
            getLog().info('query_aborted_between_events');
            break;
          }

          // Log progress for item.started (visibility fix for Codex appearing to hang)
          if (event.type === 'item.started') {
            const item = event.item;
            getLog().debug(
              { eventType: event.type, itemType: item.type, itemId: item.id },
              'item_started'
            );
          }

          // Handle error events
          if (event.type === 'error') {
            getLog().error({ message: event.message }, 'stream_error');
            // Don't send MCP timeout errors (they're optional)
            if (!event.message.includes('MCP client')) {
              yield { type: 'system', content: `⚠️ ${event.message}` };
            }
            continue;
          }

          // Handle turn failed events
          if (event.type === 'turn.failed') {
            const errorObj = event.error as { message?: string } | undefined;
            const errorMessage = errorObj?.message ?? 'Unknown error';
            getLog().error({ errorMessage }, 'turn_failed');
            yield {
              type: 'system',
              content: `❌ Turn failed: ${errorMessage}`,
            };
            break;
          }

          // Handle item.completed events - map to MessageChunk types
          if (event.type === 'item.completed') {
            const item = event.item;

            // Log progress with context for debugging
            const logContext: Record<string, unknown> = {
              eventType: event.type,
              itemType: item.type,
              itemId: item.id,
            };
            if (item.type === 'command_execution' && item.command) {
              logContext.command = item.command;
            }
            getLog().debug(logContext, 'item_completed');

            switch (item.type) {
              case 'agent_message':
                // Agent text response
                if (item.text) {
                  yield { type: 'assistant', content: item.text };
                }
                break;

              case 'command_execution':
                // Tool/command execution. The Codex SDK only emits item.completed
                // once the command has fully run, so we emit the start + result
                // back-to-back to close the UI's tool card immediately. Without
                // the paired tool_result, the card spins forever until lock release.
                if (item.command) {
                  yield { type: 'tool', toolName: item.command };
                  const exitSuffix =
                    item.exit_code != null && item.exit_code !== 0
                      ? `\n[exit code: ${item.exit_code}]`
                      : '';
                  yield {
                    type: 'tool_result',
                    toolName: item.command,
                    toolOutput: (item.aggregated_output ?? '') + exitSuffix,
                  };
                } else {
                  getLog().warn({ itemId: item.id }, 'command_execution_missing_command');
                }
                break;

              case 'reasoning':
                // Agent reasoning/thinking
                if (item.text) {
                  yield { type: 'thinking', content: item.text };
                }
                break;

              case 'web_search':
                if (item.query) {
                  const searchToolName = `🔍 Searching: ${item.query}`;
                  yield { type: 'tool', toolName: searchToolName };
                  // Web search items only fire on completion, so close the card immediately.
                  yield { type: 'tool_result', toolName: searchToolName, toolOutput: '' };
                } else {
                  getLog().debug({ itemId: item.id }, 'web_search_missing_query');
                }
                break;

              case 'todo_list':
                if (Array.isArray(item.items) && item.items.length > 0) {
                  const normalizedItems = item.items.map(t => ({
                    text: typeof t.text === 'string' ? t.text : '(unnamed task)',
                    completed: t.completed ?? false,
                  }));
                  const signature = JSON.stringify(normalizedItems);
                  if (signature !== lastTodoListSignature) {
                    lastTodoListSignature = signature;
                    const taskList = normalizedItems
                      .map(t => `${t.completed ? '✅' : '⬜'} ${t.text}`)
                      .join('\n');
                    yield { type: 'system', content: `📋 Tasks:\n${taskList}` };
                  }
                } else {
                  getLog().debug({ itemId: item.id }, 'todo_list_empty_or_invalid');
                }
                break;

              case 'file_change': {
                const statusIcon = item.status === 'failed' ? '❌' : '✅';
                const rawError = 'error' in item ? (item as { error?: unknown }).error : undefined;
                const fileErrorMessage =
                  typeof rawError === 'string'
                    ? rawError
                    : typeof rawError === 'object' && rawError !== null && 'message' in rawError
                      ? String((rawError as { message: unknown }).message)
                      : undefined;

                if (Array.isArray(item.changes) && item.changes.length > 0) {
                  const changeList = item.changes
                    .map(c => {
                      const icon = c.kind === 'add' ? '➕' : c.kind === 'delete' ? '➖' : '📝';
                      return `${icon} ${c.path ?? '(unknown file)'}`;
                    })
                    .join('\n');
                  const errorSuffix =
                    item.status === 'failed' && fileErrorMessage ? `\n${fileErrorMessage}` : '';
                  yield {
                    type: 'system',
                    content: `${statusIcon} File changes:\n${changeList}${errorSuffix}`,
                  };
                } else if (item.status === 'failed') {
                  getLog().warn(
                    { itemId: item.id, status: item.status },
                    'file_change_failed_no_changes'
                  );
                  const failMsg = fileErrorMessage
                    ? `❌ File change failed: ${fileErrorMessage}`
                    : '❌ File change failed';
                  yield { type: 'system', content: failMsg };
                } else {
                  getLog().debug(
                    { itemId: item.id, status: item.status },
                    'file_change_no_changes'
                  );
                }
                break;
              }

              case 'mcp_tool_call': {
                const toolInfo =
                  item.server && item.tool
                    ? `${item.server}/${item.tool}`
                    : (item.tool ?? item.server ?? 'MCP tool');
                const mcpToolName = `🔌 MCP: ${toolInfo}`;

                // Always emit start+result so the UI card closes. item.completed
                // fires once the call is final (completed or failed).
                yield { type: 'tool', toolName: mcpToolName };

                if (item.status === 'failed') {
                  getLog().warn(
                    { server: item.server, tool: item.tool, error: item.error, itemId: item.id },
                    'mcp_tool_call_failed'
                  );
                  const errMsg = item.error?.message
                    ? `❌ Error: ${item.error.message}`
                    : '❌ Error: MCP tool failed';
                  yield { type: 'tool_result', toolName: mcpToolName, toolOutput: errMsg };
                } else {
                  // status === 'completed' (or 'in_progress', which shouldn't reach
                  // item.completed but is closed defensively).
                  let toolOutput = '';
                  if (item.result?.content) {
                    if (Array.isArray(item.result.content)) {
                      toolOutput = JSON.stringify(item.result.content);
                    } else {
                      getLog().warn(
                        {
                          itemId: item.id,
                          server: item.server,
                          tool: item.tool,
                          resultType: typeof item.result.content,
                        },
                        'mcp_tool_call_unexpected_result_shape'
                      );
                    }
                  }
                  yield { type: 'tool_result', toolName: mcpToolName, toolOutput };
                }
                break;
              }

              // Other item types are ignored (like file edits, etc.)
            }
          }

          // Handle turn.completed event
          if (event.type === 'turn.completed') {
            getLog().debug('turn_completed');
            // Yield result with thread ID for persistence
            const usage = extractUsageFromCodexEvent(event);
            yield {
              type: 'result',
              sessionId: thread.id ?? undefined,
              tokens: usage,
            };
            // CRITICAL: Break out of event loop - turn is complete!
            // Without this, the loop waits for stream to end (causes 90s timeout)
            break;
          }
        }
        return; // Success - exit retry loop
      } catch (error) {
        const err = error as Error;

        // Don't retry aborted queries
        if (options?.abortSignal?.aborted) {
          throw new Error('Query aborted');
        }

        const errorClass = classifyCodexError(err.message);
        getLog().error(
          { err, errorClass, attempt, maxRetries: MAX_SUBPROCESS_RETRIES },
          'query_error'
        );

        // Model access errors are never retryable
        if (errorClass === 'model_access') {
          throw new Error(buildModelAccessMessage(options?.model));
        }

        // Auth errors won't resolve on retry
        if (errorClass === 'auth') {
          const enrichedError = new Error(`Codex auth error: ${err.message}`);
          enrichedError.cause = error;
          throw enrichedError;
        }

        // Retry transient failures (rate limit, crash)
        if (
          attempt < MAX_SUBPROCESS_RETRIES &&
          (errorClass === 'rate_limit' || errorClass === 'crash')
        ) {
          const delayMs = this.retryBaseDelayMs * Math.pow(2, attempt);
          getLog().info({ attempt, delayMs, errorClass }, 'retrying_query');
          await new Promise(resolve => setTimeout(resolve, delayMs));
          lastError = err;
          continue;
        }

        // Final failure - enrich and throw
        const enrichedError = new Error(`Codex ${errorClass}: ${err.message}`);
        enrichedError.cause = error;
        throw enrichedError;
      }
    }

    // Should not reach here, but handle defensively
    throw lastError ?? new Error('Codex query failed after retries');
  }

  /**
   * Tool-loop fallback path for features the Codex SDK doesn't support natively.
   * Calls the OpenAI chat/completions API directly with the Codex model ID.
   */
  private async *sendQueryViaToolLoop(
    prompt: string,
    cwd: string,
    options?: AssistantRequestOptions
  ): AsyncGenerator<MessageChunk> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        'Codex tool-loop fallback requires OPENAI_API_KEY environment variable to call the OpenAI API directly.'
      );
    }

    const model = options?.model ?? 'codex-mini-latest';

    // ── Build messages ──
    const messages: ChatMessage[] = [];
    if (options?.systemPrompt) {
      messages.push({ role: 'system', content: options.systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    // ── Resolve tools (full canonical set — filtering delegated to tool loop) ──
    const tools = options?.tools?.length === 0 ? [] : [...toolDefinitions];

    // ── MCP lifecycle: connect before loop, shutdown after ──
    let mcpProvider: McpToolProvider | undefined;
    if (options?.mcpConfigs && Object.keys(options.mcpConfigs).length > 0) {
      mcpProvider = new McpToolProvider(options.mcpConfigs as Record<string, McpServerConfig>);
      await mcpProvider.connect();
      getLog().info(
        { mcpToolCount: mcpProvider.getToolDefinitions().length },
        'codex.tool_loop_mcp_connected'
      );
    }

    // ── Load skills ──
    let skillContext: SkillContext | undefined;
    if (options?.skills && options.skills.length > 0) {
      skillContext = await loadSkills(options.skills, cwd);
      getLog().info({ skillCount: options.skills.length }, 'codex.tool_loop_skills_loaded');
    }

    // ── Context window management ──
    const endpoint = {
      url: OPENAI_CHAT_ENDPOINT,
      apiKey,
    };
    const ctxManager = new ContextWindowManager({ model, endpoint });
    let finalMessages = messages;
    if (ctxManager.shouldSummarize(messages, tools)) {
      getLog().info({ model, messageCount: messages.length }, 'codex.tool_loop_context_summarize');
      const { messages: summarized } = await ctxManager.summarize(messages, tools);
      finalMessages = summarized;
    }

    // ── Build tool loop config ──
    const loopConfig: ToolLoopConfig = {
      endpoint,
      messages: finalMessages,
      tools,
      cwd,
      model,
      abortSignal: options?.abortSignal,
      allowedTools: options?.tools,
      deniedTools: options?.disallowedTools,
      outputFormat: options?.outputFormat ? { schema: options.outputFormat.schema } : undefined,
      outputFormatStyle: 'response_format',
      mcpProvider,
      skillContext,
    };

    // ── Map hooks from AssistantRequestOptions format to ToolLoopHooks ──
    if (options?.hooks) {
      loopConfig.hooks = options.hooks;
    }

    try {
      // ── Emit system message tagging tool-loop path ──
      yield {
        type: 'system',
        content: `[codex:tool-loop] Using Archon tool loop for features: ${getUnsupportedFeatures(options).join(', ')}`,
      };

      yield* executeToolLoop(loopConfig);
    } finally {
      if (mcpProvider) {
        await mcpProvider.shutdown().catch((err: unknown) => {
          getLog().warn({ error: (err as Error).message }, 'codex.tool_loop_mcp_shutdown_error');
        });
      }
    }
  }

  /**
   * Get the assistant type identifier
   */
  getType(): string {
    return 'codex';
  }
}

/**
 * Returns the list of feature names that require the tool-loop fallback.
 * Used for logging/observability.
 */
function getUnsupportedFeatures(options?: AssistantRequestOptions): string[] {
  if (!options) return [];
  const features: string[] = [];
  if (options.tools !== undefined) features.push('allowed_tools');
  if (options.disallowedTools !== undefined) features.push('denied_tools');
  if (options.hooks) features.push('hooks');
  if (options.mcpConfigs) features.push('mcp');
  if (options.skills) features.push('skills');
  if (options.systemPrompt) features.push('systemPrompt');
  if (options.effort) features.push('effort');
  if (options.thinking) features.push('thinking');
  if (options.maxBudgetUsd !== undefined) features.push('maxBudgetUsd');
  if (options.fallbackModel) features.push('fallbackModel');
  if (options.betas) features.push('betas');
  if (options.sandbox) features.push('sandbox');
  return features;
}
