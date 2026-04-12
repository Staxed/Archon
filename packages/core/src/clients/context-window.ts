/**
 * Context-window manager for stateless (OpenAI-compatible) providers.
 *
 * Estimates token usage for outgoing requests and automatically summarizes
 * oldest conversation turns when the estimated token count exceeds the
 * model's context window × reservation threshold.
 *
 * Does NOT affect Claude/Codex SDK paths — those SDKs manage their own context.
 */

import type { ChatMessage, ProviderEndpointConfig } from './tool-loop';
import type { ToolDefinition } from './tool-definitions';
import { createLogger } from '@archon/paths';

const log = createLogger('context-window');

// ─── Types ───────────────────────────────────────────────────────────────────

/** Known model context window sizes (in tokens). */
const MODEL_WINDOW_SIZES: ReadonlyMap<string, number> = new Map([
  // OpenAI / OpenRouter models
  ['gpt-4o', 128_000],
  ['gpt-4o-mini', 128_000],
  ['gpt-4-turbo', 128_000],
  ['gpt-4', 8_192],
  ['gpt-3.5-turbo', 16_385],
  // Anthropic via OpenRouter
  ['anthropic/claude-sonnet-4-20250514', 200_000],
  ['anthropic/claude-3.5-sonnet', 200_000],
  ['anthropic/claude-3-haiku', 200_000],
  // Meta Llama
  ['meta-llama/llama-4-scout', 128_000],
  ['meta-llama/llama-4-maverick', 128_000],
  ['meta-llama/llama-3.1-70b-instruct', 128_000],
  ['meta-llama/llama-3.1-8b-instruct', 128_000],
]);

/** Default context window for unknown models. Conservative 16K. */
const DEFAULT_WINDOW_SIZE = 16_384;

/** Characters per token estimate for conservative fallback. */
const CHARS_PER_TOKEN = 3.5;

/** Configuration for the context-window manager. */
export interface ContextWindowConfig {
  /** Model name for window-size lookup. */
  model: string;
  /** Override for context window size (in tokens). */
  contextWindowSize?: number;
  /**
   * Fraction of context window that triggers summarization.
   * Default: 0.75 (summarize when estimated tokens exceed 75% of window).
   */
  reservationThreshold?: number;
  /**
   * Number of recent turns to preserve verbatim (never summarize).
   * Default: 10.
   */
  preserveRecentTurns?: number;
  /** Provider endpoint for making summarization API calls. */
  endpoint: ProviderEndpointConfig;
  /** API key for summarization calls (uses endpoint.apiKey if not provided). */
  apiKey?: string;
}

/** Error thrown when summarization fails. */
export class ContextWindowSummarizationError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'ContextWindowSummarizationError';
  }
}

/** Metadata attached to summary messages for tracking. */
export interface SummaryMetadata {
  /** IDs or indices of the turns that were summarized. */
  summarizedTurnIndices: number[];
  /** Estimated token count of the original turns. */
  originalTokenEstimate: number;
  /** Estimated token count of the summary. */
  summaryTokenEstimate: number;
}

// ─── Token Estimation ───────────────────────────────────────────────────────

/**
 * Estimate the token count of a string using a conservative character-based heuristic.
 * Returns a ceiling estimate (errs on the side of overestimating).
 */
export function estimateStringTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Estimate the token count of a single ChatMessage.
 * Accounts for role overhead, content, tool call arguments, and tool call IDs.
 */
export function estimateMessageTokens(message: ChatMessage): number {
  // Base overhead per message (role, separators): ~4 tokens
  let tokens = 4;

  if (message.content) {
    tokens += estimateStringTokens(message.content);
  }

  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      // Function name + JSON overhead
      tokens += estimateStringTokens(tc.function.name) + 3;
      tokens += estimateStringTokens(tc.function.arguments);
    }
  }

  if (message.tool_call_id) {
    tokens += estimateStringTokens(message.tool_call_id);
  }

  if (message.name) {
    tokens += estimateStringTokens(message.name);
  }

  return tokens;
}

/**
 * Estimate the token count of tool definitions in the request.
 */
export function estimateToolTokens(tools: ToolDefinition[]): number {
  let tokens = 0;
  for (const tool of tools) {
    // Function name + description + JSON schema serialization overhead
    tokens += estimateStringTokens(tool.function.name);
    tokens += estimateStringTokens(tool.function.description);
    tokens += estimateStringTokens(JSON.stringify(tool.function.parameters));
    tokens += 10; // structural overhead per tool
  }
  return tokens;
}

/**
 * Estimate the total token count of an outgoing request.
 */
export function estimateRequestTokens(
  messages: readonly ChatMessage[],
  tools: readonly ToolDefinition[]
): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateMessageTokens(msg);
  }
  total += estimateToolTokens(tools as ToolDefinition[]);
  // Request-level overhead (model, stream flag, etc.)
  total += 10;
  return total;
}

// ─── Context Window Manager ─────────────────────────────────────────────────

/**
 * Get the known context window size for a model.
 * Falls back to DEFAULT_WINDOW_SIZE for unknown models.
 */
export function getModelWindowSize(model: string): number {
  // Direct lookup
  const direct = MODEL_WINDOW_SIZES.get(model);
  if (direct !== undefined) return direct;

  // Try without vendor prefix (e.g., "anthropic/claude-3-haiku" → "claude-3-haiku")
  const slashIdx = model.indexOf('/');
  if (slashIdx !== -1) {
    const suffix = model.slice(slashIdx + 1);
    const suffixMatch = MODEL_WINDOW_SIZES.get(suffix);
    if (suffixMatch !== undefined) return suffixMatch;
  }

  return DEFAULT_WINDOW_SIZE;
}

export class ContextWindowManager {
  private readonly windowSize: number;
  private readonly threshold: number;
  private readonly preserveRecent: number;
  private readonly endpoint: ProviderEndpointConfig;
  private readonly model: string;

  constructor(config: ContextWindowConfig) {
    this.windowSize = config.contextWindowSize ?? getModelWindowSize(config.model);
    this.threshold = config.reservationThreshold ?? 0.75;
    this.preserveRecent = config.preserveRecentTurns ?? 10;
    this.endpoint = config.endpoint;
    this.model = config.model;
  }

  /**
   * Estimate the token count of an outgoing request.
   */
  estimateTokens(messages: readonly ChatMessage[], tools: readonly ToolDefinition[]): number {
    return estimateRequestTokens(messages, tools);
  }

  /**
   * Check whether the estimated token count exceeds the summarization threshold.
   */
  shouldSummarize(messages: readonly ChatMessage[], tools: readonly ToolDefinition[]): boolean {
    const estimated = this.estimateTokens(messages, tools);
    const limit = Math.floor(this.windowSize * this.threshold);
    return estimated > limit;
  }

  /**
   * Summarize the oldest contiguous turns in the message array, preserving
   * the system prompt and recent turns verbatim.
   *
   * Returns a new messages array with a synthetic summary message replacing
   * the summarized turns, plus metadata about what was summarized.
   *
   * @throws ContextWindowSummarizationError if summarization fails
   */
  async summarize(
    messages: readonly ChatMessage[],
    tools: readonly ToolDefinition[]
  ): Promise<{ messages: ChatMessage[]; metadata: SummaryMetadata }> {
    // Separate system messages at the start
    let systemEndIdx = 0;
    while (systemEndIdx < messages.length && messages[systemEndIdx]?.role === 'system') {
      systemEndIdx++;
    }
    const systemMessages = messages.slice(0, systemEndIdx);
    const conversationMessages = messages.slice(systemEndIdx);

    // Determine which turns to preserve (recent N non-system turns)
    const preserveCount = Math.min(this.preserveRecent, conversationMessages.length);
    const turnsToSummarize = conversationMessages.slice(
      0,
      conversationMessages.length - preserveCount
    );
    const turnsToPreserve = conversationMessages.slice(conversationMessages.length - preserveCount);

    if (turnsToSummarize.length === 0) {
      throw new ContextWindowSummarizationError(
        'Cannot summarize: no turns available to summarize after preserving recent messages. ' +
          `Total messages: ${messages.length}, system: ${systemEndIdx}, ` +
          `preserve recent: ${this.preserveRecent}`
      );
    }

    const originalTokenEstimate = turnsToSummarize.reduce(
      (sum, msg) => sum + estimateMessageTokens(msg),
      0
    );

    // Build the summarization prompt
    const turnText = turnsToSummarize
      .map(msg => {
        const prefix = `[${msg.role}${msg.name ? ` (${msg.name})` : ''}]`;
        const content = msg.content ?? '';
        const toolInfo = msg.tool_calls
          ? ` [tool_calls: ${msg.tool_calls.map(tc => tc.function.name).join(', ')}]`
          : '';
        return `${prefix} ${content}${toolInfo}`;
      })
      .join('\n');

    const summarizationPrompt = [
      {
        role: 'system' as const,
        content:
          'You are a conversation summarizer. Summarize the following conversation turns ' +
          'into a concise summary that preserves all important context, decisions, tool ' +
          'results, file paths, code changes, and error information. The summary will be ' +
          'used to continue the conversation, so include all details that would be needed ' +
          'to understand the current state. Be concise but thorough. Output ONLY the summary text.',
      },
      {
        role: 'user' as const,
        content: `Summarize these ${turnsToSummarize.length} conversation turns:\n\n${turnText}`,
      },
    ];

    // Track summarized turn indices (relative to original messages array)
    const summarizedTurnIndices: number[] = [];
    for (let i = 0; i < turnsToSummarize.length; i++) {
      summarizedTurnIndices.push(systemEndIdx + i);
    }

    log.info(
      {
        turnsToSummarize: turnsToSummarize.length,
        turnsToPreserve: turnsToPreserve.length,
        originalTokenEstimate,
        model: this.model,
      },
      'context-window.summarize_started'
    );

    // Call the provider to generate the summary
    let summaryText: string;
    try {
      summaryText = await this.callProvider(summarizationPrompt);
    } catch (err) {
      const error = err as Error;
      log.error(
        { error: error.message, errorType: error.constructor.name, err },
        'context-window.summarize_failed'
      );
      throw new ContextWindowSummarizationError(
        `Summarization API call failed: ${error.message}`,
        error
      );
    }

    if (!summaryText.trim()) {
      throw new ContextWindowSummarizationError(
        'Summarization returned empty response. ' +
          `Model: ${this.model}, turns summarized: ${turnsToSummarize.length}`
      );
    }

    const summaryTokenEstimate = estimateStringTokens(summaryText);

    // Build the synthetic summary message
    const summaryMessage: ChatMessage = {
      role: 'system',
      content: `[Summary of ${turnsToSummarize.length} earlier conversation turns]\n\n${summaryText}`,
    };

    // Reconstruct: system messages + summary + preserved recent turns
    const newMessages: ChatMessage[] = [...systemMessages, summaryMessage, ...turnsToPreserve];

    const metadata: SummaryMetadata = {
      summarizedTurnIndices,
      originalTokenEstimate,
      summaryTokenEstimate,
    };

    // Verify the new messages are actually smaller
    const newEstimate = estimateRequestTokens(newMessages, tools);
    const oldEstimate = estimateRequestTokens(messages as ChatMessage[], tools);

    if (newEstimate >= oldEstimate) {
      throw new ContextWindowSummarizationError(
        `Summarization did not reduce token count. Before: ~${oldEstimate}, After: ~${newEstimate}. ` +
          `Model: ${this.model}. Summary may be too verbose or conversation too short to benefit.`
      );
    }

    log.info(
      {
        turnsToSummarize: turnsToSummarize.length,
        originalTokenEstimate,
        summaryTokenEstimate,
        beforeTotal: oldEstimate,
        afterTotal: newEstimate,
        reduction: oldEstimate - newEstimate,
      },
      'context-window.summarize_completed'
    );

    return { messages: newMessages, metadata };
  }

  /**
   * Call the provider API to generate a summary.
   * Uses a simple non-streaming call since summaries are short.
   */
  private async callProvider(messages: ChatMessage[]): Promise<string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.endpoint.apiKey) {
      headers.Authorization = `Bearer ${this.endpoint.apiKey}`;
    }
    if (this.endpoint.headers) {
      Object.assign(headers, this.endpoint.headers);
    }

    const body = {
      model: this.model,
      messages,
      stream: false,
    };

    const response = await fetch(this.endpoint.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(
        `Summarization provider returned HTTP ${response.status}: ${errorText.slice(0, 500)}`
      );
    }

    const data = (await response.json()) as {
      choices?: { message?: { content?: string | null } }[];
    };

    const content = data.choices?.[0]?.message?.content;
    if (content === null || content === undefined) {
      throw new Error('Summarization response contained no content');
    }

    return content;
  }
}
