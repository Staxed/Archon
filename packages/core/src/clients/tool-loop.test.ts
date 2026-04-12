import { describe, test, expect, spyOn, afterEach } from 'bun:test';
import { executeToolLoop } from './tool-loop';
import type { ToolLoopConfig, ChatCompletionResponse, ChatCompletionChunk } from './tool-loop';
import { toolDefinitions } from './tool-definitions';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a non-streaming JSON response. */
function jsonResponse(body: ChatCompletionResponse): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Build an SSE streaming response from chunks. */
function sseResponse(chunks: ChatCompletionChunk[]): Response {
  const lines = chunks.map(c => `data: ${JSON.stringify(c)}`).join('\n') + '\ndata: [DONE]\n';
  return new Response(lines, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

/** Make a non-streaming assistant response with text content. */
function textResponse(
  content: string,
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
): ChatCompletionResponse {
  return {
    id: 'resp-1',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content, tool_calls: undefined },
        finish_reason: 'stop',
      },
    ],
    usage,
  };
}

/** Make a non-streaming response with tool_calls. */
function toolCallResponse(
  toolCalls: Array<{ id: string; name: string; arguments: string }>,
  content?: string
): ChatCompletionResponse {
  return {
    id: 'resp-tc',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: content ?? null,
          tool_calls: toolCalls.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };
}

/** Minimal config for non-streaming tests. */
function baseConfig(overrides?: Partial<ToolLoopConfig>): ToolLoopConfig {
  return {
    endpoint: { url: 'http://localhost:9999/v1/chat/completions', stream: false },
    messages: [
      {
        role: 'user',
        content: 'hello',
        tool_calls: undefined,
        tool_call_id: undefined,
        name: undefined,
      },
    ],
    tools: [...toolDefinitions],
    cwd: '/tmp',
    model: 'test-model',
    ...overrides,
  };
}

/** Collect all chunks from the async generator. */
async function collectChunks(config: ToolLoopConfig): Promise<import('../types').MessageChunk[]> {
  const chunks: import('../types').MessageChunk[] = [];
  for await (const chunk of executeToolLoop(config)) {
    chunks.push(chunk);
  }
  return chunks;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

let fetchSpy: ReturnType<typeof spyOn>;

afterEach(() => {
  fetchSpy?.mockRestore();
});

describe('executeToolLoop', () => {
  test('single-turn: no tool_calls emits assistant + result', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse(
        textResponse('Hello world', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
      )
    );

    const chunks = await collectChunks(baseConfig());

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual({ type: 'assistant', content: 'Hello world' });
    expect(chunks[1]).toMatchObject({
      type: 'result',
      tokens: { input: 10, output: 5, total: 15 },
      stopReason: 'stop',
      numTurns: 1,
    });
  });

  test('single-turn: no content, no tool_calls emits result only', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        id: 'resp-empty',
        choices: [
          { index: 0, message: { role: 'assistant', content: null }, finish_reason: 'stop' },
        ],
      })
    );

    const chunks = await collectChunks(baseConfig());

    // No assistant chunk (no content), just result
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ type: 'result', numTurns: 1 });
  });

  test('multi-turn: tool_call -> execute -> follow-up response', async () => {
    // First call returns a Read tool call
    const readArgs = JSON.stringify({ file_path: '/tmp/test.txt' });
    fetchSpy = spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse(toolCallResponse([{ id: 'call_1', name: 'Read', arguments: readArgs }]))
      )
      // Second call returns a text response
      .mockResolvedValueOnce(jsonResponse(textResponse('File content is: test')));

    const chunks = await collectChunks(baseConfig());

    // Expect: tool, tool_result, assistant, result
    const types = chunks.map(c => c.type);
    expect(types).toContain('tool');
    expect(types).toContain('tool_result');
    expect(types).toContain('assistant');
    expect(types).toContain('result');

    const toolChunk = chunks.find(c => c.type === 'tool');
    expect(toolChunk).toMatchObject({ type: 'tool', toolName: 'Read', toolCallId: 'call_1' });

    const toolResultChunk = chunks.find(c => c.type === 'tool_result');
    expect(toolResultChunk).toMatchObject({
      type: 'tool_result',
      toolName: 'Read',
      toolCallId: 'call_1',
    });

    // Result should show 2 turns
    const result = chunks.find(c => c.type === 'result');
    expect(result).toMatchObject({ type: 'result', numTurns: 2 });
  });

  test('malformed tool calls: increments counter, throws after 3 consecutive', async () => {
    // 3 consecutive malformed tool calls (bad JSON arguments)
    const malformedResponse = toolCallResponse([
      { id: 'call_bad', name: 'Read', arguments: '{invalid json' },
    ]);

    fetchSpy = spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(malformedResponse))
      .mockResolvedValueOnce(jsonResponse(malformedResponse))
      .mockResolvedValueOnce(jsonResponse(malformedResponse));

    await expect(collectChunks(baseConfig())).rejects.toThrow(/3 consecutive malformed tool calls/);
  });

  test('malformed tool calls: counter resets on success', async () => {
    // 2 malformed, then a valid tool call, then text response
    const malformedResponse = toolCallResponse([
      { id: 'call_bad', name: 'Read', arguments: 'not json' },
    ]);
    const validToolCall = toolCallResponse([
      { id: 'call_good', name: 'Bash', arguments: JSON.stringify({ command: 'echo hi' }) },
    ]);

    fetchSpy = spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(malformedResponse))
      .mockResolvedValueOnce(jsonResponse(malformedResponse))
      .mockResolvedValueOnce(jsonResponse(validToolCall))
      .mockResolvedValueOnce(jsonResponse(textResponse('Done')));

    // Should NOT throw because the counter resets after the valid tool call
    const chunks = await collectChunks(baseConfig());
    const result = chunks.find(c => c.type === 'result');
    expect(result).toBeDefined();
  });

  test('malformed tool calls: unknown tool name', async () => {
    const unknownToolResponse = toolCallResponse([
      { id: 'call_unknown', name: 'NonExistentTool', arguments: '{}' },
    ]);

    fetchSpy = spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(unknownToolResponse))
      .mockResolvedValueOnce(jsonResponse(unknownToolResponse))
      .mockResolvedValueOnce(jsonResponse(unknownToolResponse));

    await expect(collectChunks(baseConfig())).rejects.toThrow(/3 consecutive malformed tool calls/);
  });

  test('streaming: emits assistant chunks in real-time', async () => {
    const chunks: ChatCompletionChunk[] = [
      {
        id: 'ch-1',
        choices: [
          { index: 0, delta: { role: 'assistant', content: 'Hello' }, finish_reason: null },
        ],
      },
      {
        id: 'ch-2',
        choices: [{ index: 0, delta: { content: ' world' }, finish_reason: null }],
      },
      {
        id: 'ch-3',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    ];

    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(sseResponse(chunks));

    const config = baseConfig({
      endpoint: { url: 'http://localhost:9999/v1/chat/completions', stream: true },
    });
    const result = await collectChunks(config);

    // Two assistant chunks + result
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ type: 'assistant', content: 'Hello' });
    expect(result[1]).toEqual({ type: 'assistant', content: ' world' });
    expect(result[2]).toMatchObject({ type: 'result', stopReason: 'stop', numTurns: 1 });
  });

  test('streaming: tool_calls via deltas', async () => {
    // Streaming tool call: name + args sent across multiple deltas
    const streamChunks: ChatCompletionChunk[] = [
      {
        id: 'ch-tc-1',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_s1',
                  type: 'function',
                  function: { name: 'Bash', arguments: '{"co' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'ch-tc-2',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: 'mmand":"echo test"}' } }],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'ch-tc-3',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      },
    ];

    // After tool execution, model responds with text
    const followUpChunks: ChatCompletionChunk[] = [
      {
        id: 'ch-fu',
        choices: [{ index: 0, delta: { content: 'Command executed' }, finish_reason: null }],
      },
      {
        id: 'ch-fu-2',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      },
    ];

    fetchSpy = spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(sseResponse(streamChunks))
      .mockResolvedValueOnce(sseResponse(followUpChunks));

    const config = baseConfig({
      endpoint: { url: 'http://localhost:9999/v1/chat/completions', stream: true },
    });
    const result = await collectChunks(config);

    const types = result.map(c => c.type);
    expect(types).toContain('tool');
    expect(types).toContain('tool_result');
    expect(types).toContain('assistant');
    expect(types).toContain('result');
  });

  test('abort signal: throws when aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const config = baseConfig({ abortSignal: controller.signal });

    await expect(collectChunks(config)).rejects.toThrow();
  });

  test('HTTP error: throws with status and message', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Rate limit exceeded', { status: 429 })
    );

    await expect(collectChunks(baseConfig())).rejects.toThrow(/429.*Rate limit exceeded/);
  });

  test('configurable maxMalformedToolCallAttempts', async () => {
    const malformed = toolCallResponse([{ id: 'call_bad', name: 'Read', arguments: '{bad}' }]);

    // Set max to 1 — should throw after first malformed
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(malformed));

    await expect(collectChunks(baseConfig({ maxMalformedToolCallAttempts: 1 }))).rejects.toThrow(
      /1 consecutive malformed tool calls/
    );
  });

  test('tool execution error: returns error string, does not crash loop', async () => {
    // Read a non-existent file
    const readArgs = JSON.stringify({ file_path: '/tmp/definitely-does-not-exist-12345.txt' });
    fetchSpy = spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse(toolCallResponse([{ id: 'call_err', name: 'Read', arguments: readArgs }]))
      )
      .mockResolvedValueOnce(jsonResponse(textResponse('File not found')));

    const chunks = await collectChunks(baseConfig());

    const toolResult = chunks.find(c => c.type === 'tool_result');
    expect(toolResult).toBeDefined();
    if (toolResult && toolResult.type === 'tool_result') {
      expect(toolResult.toolOutput).toContain('Error');
    }

    // Loop should complete successfully
    const result = chunks.find(c => c.type === 'result');
    expect(result).toBeDefined();
  });

  test('empty tools list: single-turn without tools field', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse(textResponse('No tools available'))
    );

    const config = baseConfig({ tools: [] });
    const chunks = await collectChunks(config);

    expect(chunks).toHaveLength(2);

    // Verify the request body didn't include tools
    const callArgs = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(callArgs[1].body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty('tools');
  });

  test('token accumulation across multiple turns', async () => {
    const toolCall = toolCallResponse([
      { id: 'call_1', name: 'Bash', arguments: JSON.stringify({ command: 'echo hi' }) },
    ]);
    // Override usage on the tool call response
    toolCall.usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };

    const finalResp = textResponse('Done');
    finalResp.usage = { prompt_tokens: 200, completion_tokens: 30, total_tokens: 230 };

    fetchSpy = spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(toolCall))
      .mockResolvedValueOnce(jsonResponse(finalResp));

    const chunks = await collectChunks(baseConfig());
    const result = chunks.find(c => c.type === 'result');

    expect(result).toMatchObject({
      type: 'result',
      tokens: { input: 300, output: 50, total: 350 },
    });
  });
});
