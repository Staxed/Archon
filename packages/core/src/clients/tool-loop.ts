/**
 * Agentic tool-execution loop for OpenAI-compatible (stateless) providers.
 *
 * Core algorithm:
 *   1. Send messages + tools to the provider endpoint
 *   2. Parse the response for tool_calls
 *   3. If no tool_calls → emit result and exit
 *   4. If tool_calls → execute each tool → append results → repeat from 1
 *
 * The loop is provider-agnostic: it receives endpoint config and message format.
 * Tool dispatch uses the canonical tool implementations (read, write, edit, bash, glob, grep, web-fetch, web-search).
 */

import type { ToolDefinition } from './tool-definitions';
import type { MessageChunk } from '../types';
import { createLogger } from '@archon/paths';

import { readTool } from './tools/read';
import { writeTool } from './tools/write';
import { editTool } from './tools/edit';
import { bashTool } from './tools/bash';
import { globTool } from './tools/glob';
import { grepTool } from './tools/grep';
import { webFetchTool } from './tools/web-fetch';
import { webSearchTool } from './tools/web-search';

const log = createLogger('tool-loop');

// ─── Types ───────────────────────────────────────────────────────────────────

/** OpenAI chat/completions message format. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  /** Present on assistant messages that contain tool calls. */
  tool_calls?: ToolCall[];
  /** Present on tool-result messages. */
  tool_call_id?: string;
  /** Tool name, required when role is 'tool'. */
  name?: string;
}

/** A single tool call from the model. */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/** A streaming chunk from the OpenAI chat/completions endpoint. */
export interface ChatCompletionChunk {
  id: string;
  choices: {
    index: number;
    delta: {
      role?: string;
      content?: string | null;
      tool_calls?: {
        index: number;
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }[];
    };
    finish_reason: string | null;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/** Non-streaming response from the chat/completions endpoint. */
export interface ChatCompletionResponse {
  id: string;
  choices: {
    index: number;
    message: {
      role: string;
      content: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason: string | null;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/** Configuration for the provider endpoint. */
export interface ProviderEndpointConfig {
  /** Full URL for the chat/completions endpoint. */
  url: string;
  /** API key for Authorization header. Optional (e.g., local llama.cpp). */
  apiKey?: string;
  /** Additional headers to send with every request. */
  headers?: Record<string, string>;
  /** Whether to request streaming responses. Default: true. */
  stream?: boolean;
}

/** Configuration for the tool loop. */
export interface ToolLoopConfig {
  /** Provider endpoint configuration. */
  endpoint: ProviderEndpointConfig;
  /** Initial messages to send. */
  messages: ChatMessage[];
  /** Tool definitions available to the model. */
  tools: ToolDefinition[];
  /** Working directory for tool execution. */
  cwd: string;
  /** Model name to send in the request. */
  model: string;
  /** Optional abort signal for cancellation. */
  abortSignal?: AbortSignal;
  /** Max consecutive malformed tool-call attempts before throwing. Default: 3. */
  maxMalformedToolCallAttempts?: number;
  /** Additional request body fields (e.g., response_format, grammar, temperature). */
  extraBody?: Record<string, unknown>;
  /** Maximum number of tool-call rounds. Default: 100. */
  maxIterations?: number;
}

/** Type for a tool executor function. */
type ToolExecutor = (params: Record<string, unknown>, cwd: string) => Promise<string>;

// ─── Tool Registry ───────────────────────────────────────────────────────────

const toolRegistry: ReadonlyMap<string, ToolExecutor> = new Map<string, ToolExecutor>([
  ['Read', readTool],
  ['Write', writeTool],
  ['Edit', editTool],
  ['Bash', bashTool],
  ['Glob', globTool],
  ['Grep', grepTool],
  ['WebFetch', webFetchTool],
  ['WebSearch', webSearchTool],
]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildRequestBody(
  config: ToolLoopConfig,
  messages: ChatMessage[]
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    stream: config.endpoint.stream !== false,
  };
  if (config.tools.length > 0) {
    body.tools = config.tools;
  }
  if (config.extraBody) {
    Object.assign(body, config.extraBody);
  }
  return body;
}

function buildHeaders(endpoint: ProviderEndpointConfig): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (endpoint.apiKey) {
    headers.Authorization = `Bearer ${endpoint.apiKey}`;
  }
  if (endpoint.headers) {
    Object.assign(headers, endpoint.headers);
  }
  return headers;
}

/**
 * Parse a streaming SSE response into chunks.
 * Handles `data: {...}` lines and the `data: [DONE]` terminator.
 */
async function* parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  abortSignal?: AbortSignal
): AsyncGenerator<ChatCompletionChunk> {
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    if (abortSignal?.aborted) {
      void reader.cancel();
      return;
    }

    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    // Keep the last (possibly incomplete) line in the buffer
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith(':')) continue;
      if (trimmed === 'data: [DONE]') return;
      if (!trimmed.startsWith('data: ')) continue;

      const jsonStr = trimmed.slice(6);
      try {
        yield JSON.parse(jsonStr) as ChatCompletionChunk;
      } catch {
        // Skip malformed JSON lines in stream
        log.debug({ jsonStr: jsonStr.slice(0, 200) }, 'tool-loop.sse_parse_skipped');
      }
    }
  }

  // Process any remaining buffer content
  if (buffer.trim().startsWith('data: ') && buffer.trim() !== 'data: [DONE]') {
    const jsonStr = buffer.trim().slice(6);
    try {
      yield JSON.parse(jsonStr) as ChatCompletionChunk;
    } catch {
      // Skip malformed trailing data
    }
  }
}

/**
 * Assemble streamed tool_calls deltas into complete ToolCall objects.
 */
function assembleToolCalls(
  deltas: {
    index: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }[][]
): ToolCall[] {
  const assembled = new Map<number, { id: string; name: string; args: string }>();

  for (const deltaArr of deltas) {
    for (const delta of deltaArr) {
      const existing = assembled.get(delta.index);
      if (existing) {
        if (delta.function?.arguments) {
          existing.args += delta.function.arguments;
        }
      } else {
        assembled.set(delta.index, {
          id: delta.id ?? `call_${delta.index}`,
          name: delta.function?.name ?? '',
          args: delta.function?.arguments ?? '',
        });
      }
    }
  }

  return Array.from(assembled.values()).map(tc => ({
    id: tc.id,
    type: 'function' as const,
    function: { name: tc.name, arguments: tc.args },
  }));
}

/**
 * Validate a tool call: name must map to a known tool, arguments must be valid JSON.
 * Returns parsed arguments or null if malformed.
 */
function validateToolCall(
  tc: ToolCall,
  availableTools: ReadonlySet<string>
): Record<string, unknown> | null {
  if (!tc.function.name || !availableTools.has(tc.function.name)) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(tc.function.arguments);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ─── Main Loop ───────────────────────────────────────────────────────────────

/**
 * Execute the agentic tool-execution loop.
 *
 * Yields `MessageChunk` events as the loop progresses:
 * - `assistant` chunks for streamed text content
 * - `tool` chunks when a tool call is detected
 * - `tool_result` chunks after tool execution
 * - `result` chunk at the end with token usage
 *
 * @throws Error if the abort signal fires, if the provider returns errors,
 *         or if malformed tool calls exceed the configured threshold.
 */
export async function* executeToolLoop(config: ToolLoopConfig): AsyncGenerator<MessageChunk> {
  const maxMalformed = config.maxMalformedToolCallAttempts ?? 3;
  const maxIterations = config.maxIterations ?? 100;
  const streaming = config.endpoint.stream !== false;
  const headers = buildHeaders(config.endpoint);
  const availableTools = new Set(config.tools.map(t => t.function.name));

  // Working copy of messages that grows as tools execute
  const messages = [...config.messages];

  let consecutiveMalformed = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (config.abortSignal?.aborted) {
      throw new Error('Tool loop aborted');
    }

    const body = buildRequestBody(config, messages);

    log.debug(
      { iteration, messageCount: messages.length, toolCount: config.tools.length },
      'tool-loop.request_started'
    );

    const response = await fetch(config.endpoint.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: config.abortSignal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(
        `Tool loop: provider returned HTTP ${response.status}: ${errorText.slice(0, 500)}`
      );
    }

    let assistantContent = '';
    let toolCalls: ToolCall[] = [];
    let finishReason: string | null = null;

    if (streaming && response.body) {
      // ── Streaming path ──
      // Bun's fetch body type is ReadableStream<any>; cast to Uint8Array reader
      const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
      const toolCallDeltas: {
        index: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }[][] = [];

      for await (const chunk of parseSSEStream(reader, config.abortSignal)) {
        const choice = chunk.choices[0];
        if (!choice) continue;

        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
        }

        // Content delta
        if (choice.delta.content) {
          assistantContent += choice.delta.content;
          yield { type: 'assistant', content: choice.delta.content };
        }

        // Tool call deltas
        if (choice.delta.tool_calls) {
          toolCallDeltas.push(choice.delta.tool_calls);
        }

        // Accumulate token usage from chunks
        if (chunk.usage) {
          totalInputTokens += chunk.usage.prompt_tokens;
          totalOutputTokens += chunk.usage.completion_tokens;
        }
      }

      if (toolCallDeltas.length > 0) {
        toolCalls = assembleToolCalls(toolCallDeltas);
      }
    } else {
      // ── Non-streaming path ──
      const data = (await response.json()) as ChatCompletionResponse;
      const choice = data.choices[0];
      if (choice) {
        assistantContent = choice.message.content ?? '';
        toolCalls = choice.message.tool_calls ?? [];
        finishReason = choice.finish_reason;

        if (assistantContent) {
          yield { type: 'assistant', content: assistantContent };
        }
      }

      if (data.usage) {
        totalInputTokens += data.usage.prompt_tokens;
        totalOutputTokens += data.usage.completion_tokens;
      }
    }

    log.debug(
      { iteration, toolCallCount: toolCalls.length, finishReason },
      'tool-loop.response_received'
    );

    // ── No tool calls → done ──
    if (toolCalls.length === 0) {
      yield {
        type: 'result',
        tokens: {
          input: totalInputTokens,
          output: totalOutputTokens,
          total: totalInputTokens + totalOutputTokens,
        },
        stopReason: finishReason ?? 'stop',
        numTurns: iteration + 1,
      };
      return;
    }

    // ── Validate tool calls ──
    const parsedCalls: {
      tc: ToolCall;
      args: Record<string, unknown> | null;
    }[] = toolCalls.map(tc => ({
      tc,
      args: validateToolCall(tc, availableTools),
    }));

    const allMalformed = parsedCalls.every(pc => pc.args === null);
    if (allMalformed) {
      consecutiveMalformed++;
      log.warn(
        {
          iteration,
          consecutiveMalformed,
          maxMalformed,
          toolCalls: toolCalls.map(tc => ({
            name: tc.function.name,
            args: tc.function.arguments.slice(0, 200),
          })),
        },
        'tool-loop.malformed_tool_calls'
      );

      if (consecutiveMalformed >= maxMalformed) {
        throw new Error(
          `Tool loop: ${consecutiveMalformed} consecutive malformed tool calls. ` +
            `Model: ${config.model}. Last tool calls: ${JSON.stringify(
              toolCalls.map(tc => ({
                name: tc.function.name,
                args: tc.function.arguments.slice(0, 200),
              }))
            )}`
        );
      }

      // Append the assistant message with tool_calls, then error results
      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: assistantContent || null,
        tool_calls: toolCalls,
      };
      messages.push(assistantMsg);

      for (const { tc } of parsedCalls) {
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.function.name,
          content: `Error: Malformed tool call. Tool "${tc.function.name}" ${
            !availableTools.has(tc.function.name)
              ? 'is not available'
              : 'received invalid arguments'
          }. Available tools: ${Array.from(availableTools).join(', ')}`,
        });
      }
      continue;
    }

    // Reset malformed counter on any successful parse
    consecutiveMalformed = 0;

    // ── Append assistant message with tool_calls ──
    const assistantMsg: ChatMessage = {
      role: 'assistant',
      content: assistantContent || null,
      tool_calls: toolCalls,
    };
    messages.push(assistantMsg);

    // ── Execute tools and append results ──
    for (const { tc, args } of parsedCalls) {
      // Emit tool chunk
      yield {
        type: 'tool',
        toolName: tc.function.name,
        toolInput: args ?? undefined,
        toolCallId: tc.id,
      };

      let result: string;
      if (args === null) {
        result = `Error: Malformed tool call for "${tc.function.name}". Arguments must be valid JSON.`;
      } else {
        const executor = toolRegistry.get(tc.function.name);
        if (!executor) {
          result = `Error: Unknown tool "${tc.function.name}". Available: ${Array.from(availableTools).join(', ')}`;
        } else {
          try {
            result = await executor(args, config.cwd);
          } catch (err) {
            const error = err as Error;
            result = `Error executing ${tc.function.name}: ${error.message}`;
            log.warn(
              { toolName: tc.function.name, error: error.message },
              'tool-loop.tool_execution_failed'
            );
          }
        }
      }

      // Emit tool_result chunk
      yield {
        type: 'tool_result',
        toolName: tc.function.name,
        toolOutput: result,
        toolCallId: tc.id,
      };

      // Append tool result to messages
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        name: tc.function.name,
        content: result,
      });
    }
  }

  // Exhausted max iterations
  yield {
    type: 'result',
    tokens: {
      input: totalInputTokens,
      output: totalOutputTokens,
      total: totalInputTokens + totalOutputTokens,
    },
    stopReason: 'max_iterations',
    numTurns: maxIterations,
    isError: true,
    errorSubtype: 'max_iterations_exceeded',
  };
}
