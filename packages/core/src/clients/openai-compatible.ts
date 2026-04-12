/**
 * OpenAI-compatible base client for stateless providers.
 *
 * Shared by OpenRouter and Llama.cpp — both speak the `/v1/chat/completions` protocol.
 * Handles:
 *   - IAssistantClient interface implementation
 *   - AssistantRequestOptions → ToolLoopConfig translation
 *   - Context-window management (auto-summarization)
 *   - Rate limiting with exponential backoff
 *   - Tool filtering (allowed_tools / denied_tools)
 *   - System prompt injection
 *   - Structured output (response_format)
 *
 * Subclasses (OpenRouterClient, LlamaCppClient) configure provider-specific
 * endpoints, headers, and output format overrides.
 */

import type { AssistantRequestOptions, IAssistantClient, MessageChunk } from '../types';
import {
  executeToolLoop,
  type ChatMessage,
  type ToolLoopConfig,
  type ProviderEndpointConfig,
} from './tool-loop';
import { ContextWindowManager } from './context-window';
import { toolDefinitions, type ToolDefinition } from './tool-definitions';
import { McpToolProvider, type McpServerConfig } from './mcp-client';
import { loadSkills, type SkillContext } from './skill-loader';

import { createLogger } from '@archon/paths';

const log = createLogger('client.openai-compatible');

// ─── Types ───────────────────────────────────────────────────────────────────

/** Configuration for the OpenAI-compatible base client. */
export interface OpenAICompatibleClientConfig {
  /** Full URL for the chat/completions endpoint. */
  endpointUrl: string;
  /** API key for Authorization header. Optional (e.g., local llama.cpp). */
  apiKey?: string;
  /** Additional headers sent with every request. */
  headers?: Record<string, string>;
  /** Provider name returned by getType(). */
  providerName: string;
  /** Default model name when not specified per-request. */
  defaultModel?: string;
}

/** Rate-limit retry configuration. */
interface RateLimitConfig {
  /** Maximum number of retries on 429 responses. Default: 5. */
  maxRetries: number;
  /** Initial backoff delay in milliseconds. Default: 1000. */
  initialDelayMs: number;
  /** Maximum backoff delay in milliseconds. Default: 60000. */
  maxDelayMs: number;
}

const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  maxRetries: 5,
  initialDelayMs: 1000,
  maxDelayMs: 60_000,
};

// ─── Client ─────────────────────────────────────────────────────────────────

export class OpenAICompatibleClient implements IAssistantClient {
  protected readonly endpointUrl: string;
  protected readonly apiKey: string | undefined;
  protected readonly headers: Record<string, string>;
  protected readonly providerName: string;
  protected readonly defaultModel: string;
  protected readonly rateLimitConfig: RateLimitConfig;

  constructor(config: OpenAICompatibleClientConfig) {
    this.endpointUrl = config.endpointUrl;
    this.apiKey = config.apiKey;
    this.headers = config.headers ?? {};
    this.providerName = config.providerName;
    this.defaultModel = config.defaultModel ?? 'default';
    this.rateLimitConfig = { ...DEFAULT_RATE_LIMIT };
  }

  getType(): string {
    return this.providerName;
  }

  async *sendQuery(
    prompt: string,
    cwd: string,
    _resumeSessionId?: string,
    options?: AssistantRequestOptions
  ): AsyncGenerator<MessageChunk> {
    const model = options?.model ?? this.defaultModel;

    // ── Build messages (systemPrompt goes to tool loop config) ──
    const messages: ChatMessage[] = [];
    // Include systemPrompt in messages for accurate context window estimation,
    // then pass it to the tool loop config for proper handling
    if (options?.systemPrompt) {
      messages.push({ role: 'system', content: options.systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    // ── Build full tool list (filtering delegated to tool loop) ──
    const tools = this.resolveTools(options);

    // ── Build endpoint config ──
    const endpoint = this.buildEndpoint();

    // ── Build extra body (provider-specific fields, NOT outputFormat) ──
    const extraBody = this.buildExtraBody(options);

    // ── MCP lifecycle: connect before loop, shutdown after ──
    let mcpProvider: McpToolProvider | undefined;
    if (options?.mcpConfigs && Object.keys(options.mcpConfigs).length > 0) {
      mcpProvider = new McpToolProvider(options.mcpConfigs as Record<string, McpServerConfig>);
      await mcpProvider.connect();
      log.info(
        { mcpToolCount: mcpProvider.getToolDefinitions().length, provider: this.providerName },
        'openai-compatible.mcp_connected'
      );
    }

    // ── Load skills ──
    let skillContext: SkillContext | undefined;
    if (options?.skills && options.skills.length > 0) {
      skillContext = await loadSkills(options.skills, cwd);
      log.info(
        {
          skillCount: options.skills.length,
          promptAdditions: skillContext.systemPromptAdditions.length,
          toolAllowlist: skillContext.toolAllowlist.length,
          provider: this.providerName,
        },
        'openai-compatible.skills_loaded'
      );
    }

    // ── Context window management ──
    const ctxManager = new ContextWindowManager({ model, endpoint });
    let finalMessages = messages;
    if (ctxManager.shouldSummarize(messages, tools)) {
      log.info(
        { model, messageCount: messages.length, provider: this.providerName },
        'openai-compatible.context_summarize_started'
      );
      const { messages: summarized } = await ctxManager.summarize(messages, tools);
      finalMessages = summarized;
    }

    try {
      // ── Execute with rate-limit retry ──
      yield* this.executeWithRetry({
        endpoint,
        messages: finalMessages,
        tools,
        cwd,
        model,
        abortSignal: options?.abortSignal,
        extraBody: Object.keys(extraBody).length > 0 ? extraBody : undefined,
        // Feature params delegated to tool loop
        allowedTools: options?.tools,
        deniedTools: options?.disallowedTools,
        outputFormat: options?.outputFormat ? { schema: options.outputFormat.schema } : undefined,
        outputFormatStyle: this.getOutputFormatStyle(),
        // MCP + Skills integration
        mcpProvider,
        skillContext,
      });
    } finally {
      // ── MCP lifecycle: shutdown after loop ──
      if (mcpProvider) {
        await mcpProvider.shutdown().catch((err: unknown) => {
          log.warn(
            { error: (err as Error).message, provider: this.providerName },
            'openai-compatible.mcp_shutdown_error'
          );
        });
      }
    }
  }

  // ─── Protected hooks for subclasses ─────────────────────────────────────

  /**
   * Build the provider endpoint config. Subclasses can override to add
   * provider-specific headers (e.g., OpenRouter's HTTP-Referer, X-Title).
   */
  protected buildEndpoint(): ProviderEndpointConfig {
    return {
      url: this.endpointUrl,
      apiKey: this.apiKey,
      headers: { ...this.headers },
    };
  }

  /**
   * Build extra body fields for the request. Subclasses can override to
   * add provider-specific request body fields.
   *
   * Note: outputFormat is handled by the tool loop via outputFormat/outputFormatStyle
   * config fields — do not add response_format here.
   */
  protected buildExtraBody(_options?: AssistantRequestOptions): Record<string, unknown> {
    return {};
  }

  /**
   * Return the output format style for this provider.
   * - `'response_format'` (default): OpenAI-standard response_format
   * - `'grammar'`: Llama.cpp-native GBNF grammar
   *
   * Subclasses override to change how outputFormat is mapped.
   */
  protected getOutputFormatStyle(): 'response_format' | 'grammar' {
    return 'response_format';
  }

  /**
   * Resolve the canonical tool definitions.
   * Returns the full set — filtering by allowedTools/deniedTools is
   * handled by the tool loop.
   */
  protected resolveTools(options?: AssistantRequestOptions): ToolDefinition[] {
    // Empty tools array (explicitly disabled) → pass empty list
    if (options?.tools?.length === 0) {
      return [];
    }
    return [...toolDefinitions];
  }

  // ─── Private implementation ─────────────────────────────────────────────

  /**
   * Execute the tool loop with exponential backoff on rate limit (HTTP 429).
   */
  private async *executeWithRetry(config: ToolLoopConfig): AsyncGenerator<MessageChunk> {
    let attempt = 0;
    const { maxRetries, initialDelayMs, maxDelayMs } = this.rateLimitConfig;

    while (true) {
      try {
        yield* executeToolLoop(config);
        return;
      } catch (err) {
        const error = err as Error;

        // Only retry on rate limit errors
        if (!this.isRateLimitError(error) || attempt >= maxRetries) {
          throw error;
        }

        attempt++;
        const delay = Math.min(initialDelayMs * 2 ** (attempt - 1), maxDelayMs);
        const jitter = Math.floor(Math.random() * delay * 0.1);

        log.warn(
          {
            attempt,
            maxRetries,
            delayMs: delay + jitter,
            provider: this.providerName,
            error: error.message,
          },
          'openai-compatible.rate_limit_retry'
        );

        yield {
          type: 'rate_limit',
          rateLimitInfo: {
            attempt,
            maxRetries,
            delayMs: delay + jitter,
            provider: this.providerName,
          },
        };

        await this.sleep(delay + jitter, config.abortSignal);
      }
    }
  }

  /**
   * Check if an error is a rate limit error (HTTP 429).
   */
  private isRateLimitError(error: Error): boolean {
    return error.message.includes('HTTP 429');
  }

  /**
   * Sleep with abort signal support.
   */
  private sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (abortSignal?.aborted) {
        reject(new Error('Aborted during rate limit backoff'));
        return;
      }

      const timer = setTimeout(resolve, ms);

      abortSignal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new Error('Aborted during rate limit backoff'));
        },
        { once: true }
      );
    });
  }
}
