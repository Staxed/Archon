/**
 * Codex SDK wrapper
 * Provides async generator interface for streaming Codex responses.
 *
 * Runs the Codex CLI on the user's ChatGPT subscription (the login in
 * $CODEX_HOME/auth.json). It never uses an API key and never goes through the LLM
 * gateway; API-key variables are removed from the CLI's environment.
 *
 * Every workflow node option maps onto Codex itself (each verified by a live run in
 * the archon sandbox, codex 0.157):
 *   systemPrompt   -> model_instructions_file (replaces Codex's base instructions,
 *                     as Claude's string systemPrompt replaces its preset)
 *   skills         -> preloaded into developer_instructions (as Claude preloads them)
 *   mcp            -> mcp_servers.<name> config (stdio and streamable HTTP)
 *   effort         -> model_reasoning_effort; thinking: disabled -> `low` (Codex
 *                     models cannot turn reasoning off; said so in a system message)
 *   sandbox        -> sandbox_mode workspace-write (+ writable roots, network on/off)
 *   allowed/denied tools, hooks, and the worktree path guard
 *                  -> Archon's CLI hook dispatcher (hook-dispatcher.ts, cli-hooks.ts)
 *   maxBudgetUsd   -> Archon prices the rollout's token counts mid-turn and stops
 *   fallbackModel  -> Archon retries on a model-access error
 *   betas          -> refused (Anthropic-only)
 */
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Codex,
  type CodexOptions,
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
import { loadSkills } from './skill-loader';
import {
  codexHookTrustOverride,
  ensureCodexDispatcher,
  prepareHookRun,
  unsupportedHookEvents,
} from './cli-hooks';
import {
  mapSandboxForCodex,
  modelRates,
  noRatesError,
  priceTokens,
  refusedClaudeOnlyOptions,
  type PricedTokens,
} from './subscription-options';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('client.codex');
  return cachedLog;
}

const CODEX_MODEL_FALLBACKS: Record<string, string> = {
  'gpt-5.3-codex': 'gpt-5.2-codex',
};

function isModelAccessError(errorMessage: string): boolean {
  const m = errorMessage.toLowerCase();
  const hasModel = m.includes('model');
  const hasAvailabilitySignal =
    m.includes('not available') ||
    m.includes('not found') ||
    m.includes('access denied') ||
    // ChatGPT accounts: "The 'x' model is not supported when using Codex with a
    // ChatGPT account." Anchored on the model coming first, so an unsupported
    // parameter ("'none' is not supported with the 'y' model") does not match.
    /model[^.]{0,40}(is not supported|does not exist)/.test(m);
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

/** A model-access failure, kept distinct so fallbackModel can retry on it. */
class CodexModelAccessError extends Error {}

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

/** API-key variables a subscription run must never see (Codex would bill the key). */
const API_KEY_ENV = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL'];

/** Claude effort levels Codex accepts as model_reasoning_effort. */
const CODEX_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/** MCP server names become dotted config keys; a dot in the name would split the key. */
const MCP_NAME_RE = /^[A-Za-z0-9_-]+$/;

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

/**
 * OpenAI counts cached tokens INSIDE input_tokens. Archon's usage rows follow the
 * Claude shape (input excludes cache), so `input` is the uncached part and `total`
 * keeps everything, cached included: total - input - output = cached input. The SDK
 * path runs on the ChatGPT subscription and reports no cost; Dashed prices it from
 * these tokens and the model.
 */
function extractUsageFromCodexEvent(
  event: TurnCompletedEvent,
  threadId?: string | null
): TokenUsage {
  if (!event.usage) {
    getLog().warn({ eventType: event.type }, 'codex.usage_null_on_turn_completed');
    return { input: 0, output: 0 };
  }
  const cached = event.usage.cached_input_tokens ?? 0;
  const model = threadId ? findRolloutModel(threadId) : undefined;
  return {
    input: Math.max(event.usage.input_tokens - cached, 0),
    output: event.usage.output_tokens,
    total: event.usage.input_tokens + event.usage.output_tokens,
    ...(model ? { model } : {}),
  };
}

function codexHomeDir(codexHome?: string): string {
  return codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
}

/**
 * The thread's rollout file: $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<thread id>.jsonl
 * (dated by local time when the thread started). Only the two most recent day
 * folders are searched. Never throws.
 */
export function findRolloutFile(threadId: string, codexHome?: string): string | undefined {
  const sessions = join(codexHomeDir(codexHome), 'sessions');
  try {
    const days: string[] = [];
    const newest = (dir: string): string[] =>
      readdirSync(dir)
        .filter(n => /^\d+$/.test(n))
        .sort()
        .reverse();
    for (const y of newest(sessions)) {
      for (const m of newest(join(sessions, y))) {
        for (const d of newest(join(sessions, y, m))) {
          days.push(join(sessions, y, m, d));
          if (days.length >= 2) break;
        }
        if (days.length >= 2) break;
      }
      if (days.length >= 2) break;
    }
    for (const day of days) {
      const file = readdirSync(day).find(n => n.endsWith(`-${threadId}.jsonl`));
      if (file) return join(day, file);
    }
  } catch (err) {
    getLog().debug({ err, threadId }, 'codex.rollout_lookup_failed');
  }
  return undefined;
}

/**
 * The model Codex actually ran, read from the thread's rollout file. The SDK's
 * events never name it, and with no `model` configured Codex picks its own default,
 * which Archon would otherwise record as 'default'. Each turn writes a
 * `turn_context` record carrying the model. A thread resumed days later falls back
 * to the configured model. Never throws.
 */
export function findRolloutModel(threadId: string, codexHome?: string): string | undefined {
  const file = findRolloutFile(threadId, codexHome);
  if (!file) return undefined;
  try {
    let model: string | undefined;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('"turn_context"')) continue;
      try {
        const rec = JSON.parse(line) as { type?: string; payload?: { model?: unknown } };
        if (rec.type === 'turn_context' && typeof rec.payload?.model === 'string') {
          model = rec.payload.model;
        }
      } catch {
        // a partly written last line; the earlier turn_context still counts
      }
    }
    return model;
  } catch (err) {
    getLog().debug({ err, threadId }, 'codex.rollout_model_lookup_failed');
    return undefined;
  }
}

/**
 * Spend of one Codex turn so far, from the rollout: Codex appends a `token_count`
 * record after every model call (`last_token_usage`, OpenAI shape: cached tokens
 * inside input_tokens) and a `turn_context` record naming the model. Reads only
 * the bytes appended since the turn started, so a resumed thread's earlier turns
 * are not counted again.
 */
export class RolloutSpend {
  readonly tokens: PricedTokens = { uncached: 0, cached: 0, output: 0 };
  model: string | undefined;
  private file: string | undefined;
  private offset: number | undefined;
  private partial = '';

  constructor(
    private readonly configuredModel: string | undefined,
    private readonly codexHome?: string
  ) {
    this.model = configuredModel;
  }

  /** Remember where the thread's rollout ends before the turn (resumed threads). */
  markStart(threadId: string | null | undefined): void {
    if (!threadId || this.offset !== undefined) return;
    const file = findRolloutFile(threadId, this.codexHome);
    if (!file) return;
    try {
      this.file = file;
      this.offset = statSync(file).size;
    } catch {
      // not there yet: a new thread, read from the start
    }
  }

  /** Read what the rollout gained since the last poll. Never throws. */
  poll(threadId: string | null | undefined): void {
    if (!threadId) return;
    this.file ??= findRolloutFile(threadId, this.codexHome);
    if (!this.file) return;
    let text: string;
    try {
      const buf = readFileSync(this.file);
      const from = this.offset ?? 0;
      if (buf.length <= from) return;
      text = this.partial + buf.subarray(from).toString('utf8');
      this.offset = buf.length;
    } catch {
      return;
    }
    const lines = text.split('\n');
    this.partial = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.includes('"token_count"') && !line.includes('"turn_context"')) continue;
      try {
        const rec = JSON.parse(line) as {
          type?: string;
          payload?: {
            type?: string;
            model?: unknown;
            info?: {
              last_token_usage?: {
                input_tokens?: number;
                cached_input_tokens?: number;
                output_tokens?: number;
              };
            } | null;
          };
        };
        if (rec.type === 'turn_context' && typeof rec.payload?.model === 'string') {
          this.model = rec.payload.model;
        } else if (rec.payload?.type === 'token_count' && rec.payload.info?.last_token_usage) {
          const u = rec.payload.info.last_token_usage;
          const cached = u.cached_input_tokens ?? 0;
          this.tokens.uncached += Math.max((u.input_tokens ?? 0) - cached, 0);
          this.tokens.cached += cached;
          this.tokens.output += u.output_tokens ?? 0;
        }
      } catch {
        // skip a malformed line
      }
    }
  }

  /**
   * Whether the spend so far passes `budget`. Nothing is priced before the first
   * model call lands (the rollout names the model in the same turn), so an unset
   * `model` resolves to Codex's real default before it matters.
   */
  exceeds(budget: number): boolean {
    const t = this.tokens;
    if (t.uncached + t.cached + t.output === 0) return false;
    return this.cost() > budget;
  }

  /** Cost so far; throws when the model has no price. */
  cost(): number {
    const rates = modelRates(this.model ?? this.configuredModel);
    if (!rates) throw noRatesError('Codex', this.model ?? this.configuredModel);
    return priceTokens(rates, this.tokens);
  }

  usage(): TokenUsage {
    return {
      input: this.tokens.uncached,
      output: this.tokens.output,
      total: this.tokens.uncached + this.tokens.cached + this.tokens.output,
      ...(this.model ? { model: this.model } : {}),
    };
  }
}

/** Everything one Codex call needs besides the prompt: built once, cleaned up after. */
interface CodexRun {
  codexOptions: CodexOptions;
  threadOptions: ThreadOptions;
  notes: string[];
  cleanup: () => void;
}

function writeInstructionsFile(text: string): string {
  const dir = join(tmpdir(), 'archon-codex-instructions');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${randomUUID()}.md`);
  writeFileSync(path, text, { mode: 0o600 });
  return path;
}

type McpConfigs = NonNullable<AssistantRequestOptions['mcpConfigs']>;

export function mapMcpForCodex(mcp: McpConfigs): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, server] of Object.entries(mcp)) {
    if (!MCP_NAME_RE.test(name)) {
      throw new Error(
        `Codex MCP server name "${name}" must use only letters, digits, "-" and "_" (it becomes a config key).`
      );
    }
    if ('url' in server) {
      if (server.type === 'sse') {
        throw new Error(
          `Codex does not support SSE MCP servers ("${name}"); use a streamable HTTP endpoint (type: http) or a stdio server.`
        );
      }
      out[name] = {
        url: server.url,
        ...(server.headers && Object.keys(server.headers).length > 0
          ? { http_headers: server.headers }
          : {}),
      };
    } else {
      out[name] = {
        command: server.command,
        ...(server.args ? { args: server.args } : {}),
        ...(server.env && Object.keys(server.env).length > 0 ? { env: server.env } : {}),
      };
    }
  }
  return out;
}

function subscriptionEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !API_KEY_ENV.includes(k)) env[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) {
    if (!API_KEY_ENV.includes(k)) env[k] = v;
  }
  return env;
}

function webSearchAllowed(options?: AssistantRequestOptions): boolean {
  if (options?.disallowedTools?.includes('WebSearch')) return false;
  if (options?.tools !== undefined && !options.tools.includes('WebSearch')) return false;
  return true;
}

/**
 * Translate a node's options into a Codex instance and thread options, or throw a
 * clear refusal. Refusals come first, before anything is written.
 */
async function buildCodexRun(
  cwd: string,
  model: string | undefined,
  options?: AssistantRequestOptions
): Promise<CodexRun> {
  const refused = refusedClaudeOnlyOptions(options);
  if (options?.hooks && Object.keys(options.hooks).length > 0) {
    refused.push('in-process hooks (pass the YAML hooks as hookSpecs)');
  }
  const badEvents = unsupportedHookEvents('codex', options?.hookSpecs);
  if (badEvents.length > 0) refused.push(`hook events Codex never fires: ${badEvents.join(', ')}`);
  if (refused.length > 0) {
    throw new Error(
      `Codex provider cannot honour ${refused.join('; ')}. Remove them from this node or run it on Claude; Archon never falls back to an API key for a subscription provider.`
    );
  }
  const sandbox = mapSandboxForCodex(options?.sandbox, cwd);
  if (options?.maxBudgetUsd !== undefined && model && !modelRates(model)) {
    throw noRatesError('Codex', model);
  }
  const mcp = options?.mcpConfigs ? mapMcpForCodex(options.mcpConfigs) : {};

  const notes: string[] = [];
  const config: Record<string, unknown> = { ...sandbox.config };
  if (Object.keys(mcp).length > 0) config.mcp_servers = mcp;

  if (options?.skills && options.skills.length > 0) {
    const skills = await loadSkills(options.skills, cwd);
    if (skills.systemPromptAdditions.length > 0) {
      config.developer_instructions =
        `Skills preloaded for this task (${options.skills.join(', ')}). Follow them when relevant.\n\n` +
        skills.systemPromptAdditions.join('\n\n---\n\n');
    }
  }

  let effort: ThreadOptions['modelReasoningEffort'] = options?.modelReasoningEffort;
  if (options?.effort && CODEX_EFFORTS.has(options.effort)) {
    effort = options.effort as ThreadOptions['modelReasoningEffort'];
  } else if (options?.thinking?.type === 'disabled' && !options.effort) {
    effort = 'low';
    notes.push(
      'thinking: disabled → Codex reasoning effort "low" (Codex models cannot turn reasoning off).'
    );
  }

  const cleanups: (() => void)[] = [];
  const cleanup = (): void => {
    for (const c of cleanups.splice(0)) {
      try {
        c();
      } catch (err) {
        getLog().debug({ err }, 'codex.run_cleanup_failed');
      }
    }
  };
  try {
    if (options?.systemPrompt) {
      const file = writeInstructionsFile(options.systemPrompt);
      cleanups.push(() => {
        rmSync(file, { force: true });
      });
      config.model_instructions_file = file;
    }
    const trust = ensureCodexDispatcher();
    const hookRun = prepareHookRun({
      version: 1,
      provider: 'codex',
      cwd,
      pathGuard: true,
      ...(options?.tools !== undefined ? { allowedTools: options.tools } : {}),
      ...(options?.disallowedTools !== undefined ? { deniedTools: options.disallowedTools } : {}),
      ...(options?.hookSpecs ? { hooks: options.hookSpecs } : {}),
    });
    cleanups.push(hookRun.cleanup);

    const codexOptions: CodexOptions = {
      ...(Object.keys(config).length > 0 ? { config: config as CodexOptions['config'] } : {}),
      configOverrides: [codexHookTrustOverride(trust)],
      env: subscriptionEnv({ ...(options?.env ?? {}), ...hookRun.env }),
    };
    const threadOptions: ThreadOptions = {
      workingDirectory: cwd,
      skipGitRepoCheck: true,
      sandboxMode: sandbox.sandboxMode,
      networkAccessEnabled: sandbox.networkAccessEnabled,
      approvalPolicy: 'never', // Auto-approve all operations without user confirmation
      model,
      modelReasoningEffort: effort,
      webSearchMode: webSearchAllowed(options) ? options?.webSearchMode : 'disabled',
      additionalDirectories: options?.additionalDirectories,
    };
    return { codexOptions, threadOptions, notes, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
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
    // Check if already aborted before starting
    if (options?.abortSignal?.aborted) {
      throw new Error('Query aborted');
    }
    try {
      yield* this.runWithModel(prompt, cwd, resumeSessionId, options, options?.model);
    } catch (error) {
      const fallback = options?.fallbackModel;
      if (!(error instanceof CodexModelAccessError) || !fallback || fallback === options?.model) {
        throw error;
      }
      getLog().info({ model: options?.model, fallback }, 'codex.fallback_model');
      yield {
        type: 'system',
        content: `⚠️ Model "${options?.model ?? 'default'}" is not available; retrying with fallback model "${fallback}".`,
      };
      yield* this.runWithModel(prompt, cwd, resumeSessionId, options, fallback);
    }
  }

  private async *runWithModel(
    prompt: string,
    cwd: string,
    resumeSessionId: string | undefined,
    options: AssistantRequestOptions | undefined,
    model: string | undefined
  ): AsyncGenerator<MessageChunk> {
    const run = await buildCodexRun(cwd, model, options);
    try {
      for (const note of run.notes) yield { type: 'system', content: `ℹ️ ${note}` };
      yield* this.stream(prompt, resumeSessionId, options, model, run);
    } finally {
      run.cleanup();
    }
  }

  private async *stream(
    prompt: string,
    resumeSessionId: string | undefined,
    options: AssistantRequestOptions | undefined,
    model: string | undefined,
    run: CodexRun
  ): AsyncGenerator<MessageChunk> {
    getLog().debug({ model }, 'codex.sdk_dispatch');
    const codex = new Codex(run.codexOptions);
    const threadOptions = run.threadOptions;

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
            throw new CodexModelAccessError(buildModelAccessMessage(model));
          }
          throw new Error(`Codex query failed: ${err.message}`);
        }
        sessionResumeFailed = true;
      }
    } else {
      getLog().debug({ cwd: threadOptions.workingDirectory }, 'starting_new_thread');
      // NOTE: startThread is synchronous, not async
      try {
        thread = codex.startThread(threadOptions);
      } catch (error) {
        const err = error as Error;
        if (isModelAccessError(err.message)) {
          throw new CodexModelAccessError(buildModelAccessMessage(model));
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
    const budget = options?.maxBudgetUsd;

    for (let attempt = 0; attempt <= MAX_SUBPROCESS_RETRIES; attempt++) {
      // Check abort signal before each attempt
      if (options?.abortSignal?.aborted) {
        throw new Error('Query aborted');
      }

      // On retries, create a fresh thread (crashed thread is invalid)
      if (attempt > 0) {
        getLog().debug({ cwd: threadOptions.workingDirectory, attempt }, 'starting_new_thread');
        try {
          thread = codex.startThread(threadOptions);
        } catch (startError) {
          const err = startError as Error;
          if (isModelAccessError(err.message)) {
            throw new CodexModelAccessError(buildModelAccessMessage(model));
          }
          throw new Error(`Codex query failed: ${err.message}`);
        }
      }

      const spend = budget !== undefined ? new RolloutSpend(model) : undefined;
      spend?.markStart(thread.id);
      const budgetStop = new AbortController();
      let overBudget = false;

      try {
        // Build per-turn options (structured output schema, abort signal)
        const turnOptions: TurnOptions = {};
        if (options?.outputFormat) {
          turnOptions.outputSchema = options.outputFormat.schema;
        }
        if (options?.abortSignal && spend) {
          turnOptions.signal = AbortSignal.any([options.abortSignal, budgetStop.signal]);
        } else if (options?.abortSignal) {
          turnOptions.signal = options.abortSignal;
        } else if (spend) {
          turnOptions.signal = budgetStop.signal;
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

          // Enforce maxBudgetUsd from the rollout's per-call token counts
          if (spend && budget !== undefined) {
            spend.poll(thread.id);
            if (spend.exceeds(budget)) {
              overBudget = true;
              budgetStop.abort();
              break;
            }
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
            // Throw so the failure is classified below (auth, rate limit, ...) and the
            // node FAILS. Ending quietly here made a run with no ChatGPT login (every
            // request 401) finish as "completed" with a zero usage row, which would
            // hide an expired subscription login.
            throw new Error(errorMessage);
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
            const usage = extractUsageFromCodexEvent(event, thread.id);
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
        if (overBudget && spend && budget !== undefined) {
          yield* budgetExceeded(spend, budget, thread.id);
        }
        return; // Success - exit retry loop
      } catch (error) {
        const err = error as Error;

        // The budget stop kills the CLI; that shows up here as an abort
        if (overBudget && spend && budget !== undefined) {
          yield* budgetExceeded(spend, budget, thread.id);
          return;
        }

        // Don't retry aborted queries
        if (options?.abortSignal?.aborted) {
          throw new Error('Query aborted');
        }

        const errorClass = classifyCodexError(err.message);
        getLog().error(
          { err, errorClass, attempt, maxRetries: MAX_SUBPROCESS_RETRIES },
          'query_error'
        );

        // Model access errors are never retryable (fallbackModel is handled by the caller)
        if (errorClass === 'model_access') {
          throw new CodexModelAccessError(buildModelAccessMessage(model));
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
   * Get the assistant type identifier
   */
  getType(): string {
    return 'codex';
  }
}

/** The result Claude's SDK gives for a spend cap: an error result the executor fails the node on. */
function* budgetExceeded(
  spend: RolloutSpend,
  budget: number,
  threadId: string | null
): Generator<MessageChunk> {
  const cost = spend.cost();
  getLog().warn({ cost, budget, model: spend.model }, 'codex.max_budget_exceeded');
  yield {
    type: 'system',
    content: `❌ Stopped: this node's usage reached $${cost.toFixed(4)} (API-equivalent), over its maxBudgetUsd of $${budget.toFixed(2)}.`,
  };
  yield {
    type: 'result',
    sessionId: threadId ?? undefined,
    tokens: spend.usage(),
    cost,
    isError: true,
    errorSubtype: 'error_max_budget_usd',
  };
}
