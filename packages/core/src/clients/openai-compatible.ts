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
import { toolDefinitions, filterToolsByName, type ToolDefinition } from './tool-definitions';

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

    // ── Build messages ──
    const messages: ChatMessage[] = [];
    if (options?.systemPrompt) {
      messages.push({ role: 'system', content: options.systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    // ── Build tool list ──
    const tools = this.resolveTools(options);

    // ── Build endpoint config ──
    const endpoint = this.buildEndpoint();

    // ── Build extra body (response_format, etc.) ──
    const extraBody = this.buildExtraBody(options);

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

    // ── Execute with rate-limit retry ──
    yield* this.executeWithRetry({
      endpoint,
      messages: finalMessages,
      tools,
      cwd,
      model,
      abortSignal: options?.abortSignal,
      extraBody: Object.keys(extraBody).length > 0 ? extraBody : undefined,
    });
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
   * change output format handling (e.g., Llama.cpp uses GBNF grammar
   * instead of response_format).
   */
  protected buildExtraBody(options?: AssistantRequestOptions): Record<string, unknown> {
    const extra: Record<string, unknown> = {};
    if (options?.outputFormat) {
      extra.response_format = {
        type: 'json_schema',
        json_schema: options.outputFormat.schema,
      };
    }
    return extra;
  }

  /**
   * Resolve the tool definitions based on allowed_tools / denied_tools options.
   * Subclasses generally don't need to override this.
   */
  protected resolveTools(options?: AssistantRequestOptions): ToolDefinition[] {
    // Empty tools array (explicitly disabled) → pass empty list
    if (options?.tools?.length === 0) {
      return [];
    }

    let tools: ToolDefinition[];

    // Apply allowed_tools filter (whitelist)
    if (options?.tools && options.tools.length > 0) {
      tools = filterToolsByName(options.tools);
    } else {
      tools = [...toolDefinitions];
    }

    // Apply denied_tools filter (blocklist) on the current set
    if (options?.disallowedTools && options.disallowedTools.length > 0) {
      const denySet = new Set(options.disallowedTools);
      tools = tools.filter(def => !denySet.has(def.function.name));
    }

    return tools;
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
