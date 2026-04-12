import { describe, test, expect, spyOn, afterEach } from 'bun:test';
import { executeToolLoop } from './tool-loop';
import type {
  ToolLoopConfig,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ToolLoopHooks,
  PreToolUseHookInput,
  PostToolUseHookInput,
  PostToolUseFailureHookInput,
  HookOutput,
} from './tool-loop';
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

  // ─── Feature integration tests (US-019) ────────────────────────────────

  describe('allowedTools', () => {
    test('filters tools to only allowed names', async () => {
      let body: Record<string, unknown> | null = null;
      fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
        async (_url: string | URL | Request, init?: RequestInit) => {
          body = JSON.parse(init?.body as string) as Record<string, unknown>;
          return jsonResponse(textResponse('ok'));
        }
      );

      await collectChunks(baseConfig({ allowedTools: ['Read', 'Write'] }));

      const tools = body!.tools as { function: { name: string } }[];
      expect(tools).toHaveLength(2);
      expect(tools.map(t => t.function.name).sort()).toEqual(['Read', 'Write']);
    });

    test('empty allowedTools passes all tools', async () => {
      let body: Record<string, unknown> | null = null;
      fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
        async (_url: string | URL | Request, init?: RequestInit) => {
          body = JSON.parse(init?.body as string) as Record<string, unknown>;
          return jsonResponse(textResponse('ok'));
        }
      );

      await collectChunks(baseConfig({ allowedTools: [] }));

      // Empty allowedTools array means no filter — all tools passed
      const tools = body!.tools as { function: { name: string } }[];
      expect(tools).toHaveLength(8);
    });
  });

  describe('deniedTools', () => {
    test('excludes denied tool names', async () => {
      let body: Record<string, unknown> | null = null;
      fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
        async (_url: string | URL | Request, init?: RequestInit) => {
          body = JSON.parse(init?.body as string) as Record<string, unknown>;
          return jsonResponse(textResponse('ok'));
        }
      );

      await collectChunks(baseConfig({ deniedTools: ['Bash', 'WebFetch', 'WebSearch'] }));

      const tools = body!.tools as { function: { name: string } }[];
      expect(tools).toHaveLength(5);
      const names = tools.map(t => t.function.name);
      expect(names).not.toContain('Bash');
      expect(names).not.toContain('WebFetch');
      expect(names).not.toContain('WebSearch');
    });

    test('allowedTools + deniedTools: denied removes from whitelist', async () => {
      let body: Record<string, unknown> | null = null;
      fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
        async (_url: string | URL | Request, init?: RequestInit) => {
          body = JSON.parse(init?.body as string) as Record<string, unknown>;
          return jsonResponse(textResponse('ok'));
        }
      );

      await collectChunks(
        baseConfig({ allowedTools: ['Read', 'Write', 'Bash'], deniedTools: ['Bash'] })
      );

      const tools = body!.tools as { function: { name: string } }[];
      expect(tools).toHaveLength(2);
      expect(tools.map(t => t.function.name).sort()).toEqual(['Read', 'Write']);
    });
  });

  describe('systemPrompt', () => {
    test('prepends system message to messages array', async () => {
      let body: Record<string, unknown> | null = null;
      fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
        async (_url: string | URL | Request, init?: RequestInit) => {
          body = JSON.parse(init?.body as string) as Record<string, unknown>;
          return jsonResponse(textResponse('ok'));
        }
      );

      await collectChunks(baseConfig({ systemPrompt: 'You are a helpful assistant.' }));

      const messages = body!.messages as { role: string; content: string }[];
      expect(messages[0]).toEqual({ role: 'system', content: 'You are a helpful assistant.' });
      expect(messages[1]).toMatchObject({ role: 'user', content: 'hello' });
    });

    test('no systemPrompt: messages unchanged', async () => {
      let body: Record<string, unknown> | null = null;
      fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
        async (_url: string | URL | Request, init?: RequestInit) => {
          body = JSON.parse(init?.body as string) as Record<string, unknown>;
          return jsonResponse(textResponse('ok'));
        }
      );

      await collectChunks(baseConfig());

      const messages = body!.messages as { role: string; content: string }[];
      expect(messages[0]).toMatchObject({ role: 'user', content: 'hello' });
    });
  });

  describe('outputFormat', () => {
    test('maps to response_format by default (response_format style)', async () => {
      let body: Record<string, unknown> | null = null;
      fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
        async (_url: string | URL | Request, init?: RequestInit) => {
          body = JSON.parse(init?.body as string) as Record<string, unknown>;
          return jsonResponse(textResponse('{"result": 42}'));
        }
      );

      const schema = { type: 'object', properties: { result: { type: 'number' } } };
      await collectChunks(baseConfig({ outputFormat: { schema, name: 'my_output' } }));

      expect(body!.response_format).toEqual({
        type: 'json_schema',
        json_schema: { name: 'my_output', schema },
      });
      expect(body!.grammar).toBeUndefined();
    });

    test('maps to GBNF grammar when outputFormatStyle is grammar', async () => {
      let body: Record<string, unknown> | null = null;
      fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
        async (_url: string | URL | Request, init?: RequestInit) => {
          body = JSON.parse(init?.body as string) as Record<string, unknown>;
          return jsonResponse(textResponse('{}'));
        }
      );

      const schema = {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      };
      await collectChunks(baseConfig({ outputFormat: { schema }, outputFormatStyle: 'grammar' }));

      // Should have grammar field, not response_format
      expect(body!.grammar).toBeDefined();
      expect(typeof body!.grammar).toBe('string');
      expect(body!.response_format).toBeUndefined();
    });

    test('defaults name to "output" when not specified', async () => {
      let body: Record<string, unknown> | null = null;
      fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
        async (_url: string | URL | Request, init?: RequestInit) => {
          body = JSON.parse(init?.body as string) as Record<string, unknown>;
          return jsonResponse(textResponse('{}'));
        }
      );

      await collectChunks(
        baseConfig({ outputFormat: { schema: { type: 'object', properties: {} } } })
      );

      const rf = body!.response_format as { json_schema: { name: string } };
      expect(rf.json_schema.name).toBe('output');
    });

    test('no outputFormat: no response_format or grammar in body', async () => {
      let body: Record<string, unknown> | null = null;
      fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
        async (_url: string | URL | Request, init?: RequestInit) => {
          body = JSON.parse(init?.body as string) as Record<string, unknown>;
          return jsonResponse(textResponse('ok'));
        }
      );

      await collectChunks(baseConfig());

      expect(body!.response_format).toBeUndefined();
      expect(body!.grammar).toBeUndefined();
    });
  });

  // ─── Hooks lifecycle tests (US-020) ─────────────────────────────────────

  describe('hooks', () => {
    test('PreToolUse: fires before tool execution with correct payload', async () => {
      const hookCalls: PreToolUseHookInput[] = [];
      const hooks: ToolLoopHooks = {
        PreToolUse: [
          {
            hooks: [
              async input => {
                hookCalls.push(input as PreToolUseHookInput);
                return {};
              },
            ],
          },
        ],
      };

      const bashArgs = JSON.stringify({ command: 'echo hello' });
      fetchSpy = spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          jsonResponse(toolCallResponse([{ id: 'call_1', name: 'Bash', arguments: bashArgs }]))
        )
        .mockResolvedValueOnce(jsonResponse(textResponse('done')));

      await collectChunks(baseConfig({ hooks, sessionId: 'sess-123' }));

      expect(hookCalls).toHaveLength(1);
      expect(hookCalls[0]).toMatchObject({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'echo hello' },
        tool_use_id: 'call_1',
        session_id: 'sess-123',
        cwd: '/tmp',
      });
    });

    test('PreToolUse: deny permission blocks tool execution', async () => {
      const hooks: ToolLoopHooks = {
        PreToolUse: [
          {
            hooks: [
              async () => ({
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse',
                  permissionDecision: 'deny' as const,
                  permissionDecisionReason: 'Not allowed in this context',
                },
              }),
            ],
          },
        ],
      };

      const bashArgs = JSON.stringify({ command: 'rm -rf /' });
      fetchSpy = spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          jsonResponse(toolCallResponse([{ id: 'call_deny', name: 'Bash', arguments: bashArgs }]))
        )
        .mockResolvedValueOnce(jsonResponse(textResponse('ok')));

      const chunks = await collectChunks(baseConfig({ hooks }));

      // Should have a tool_result with denial message
      const toolResult = chunks.find(c => c.type === 'tool_result');
      expect(toolResult).toBeDefined();
      if (toolResult?.type === 'tool_result') {
        expect(toolResult.toolOutput).toContain('denied by PreToolUse hook');
        expect(toolResult.toolOutput).toContain('Not allowed in this context');
      }
    });

    test('PreToolUse: matcher regex filters which tools trigger the hook', async () => {
      const hookCalls: string[] = [];
      const hooks: ToolLoopHooks = {
        PreToolUse: [
          {
            matcher: 'Write|Edit',
            hooks: [
              async input => {
                hookCalls.push((input as PreToolUseHookInput).tool_name);
                return {};
              },
            ],
          },
        ],
      };

      const bashArgs = JSON.stringify({ command: 'echo test' });
      fetchSpy = spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          jsonResponse(toolCallResponse([{ id: 'call_1', name: 'Bash', arguments: bashArgs }]))
        )
        .mockResolvedValueOnce(jsonResponse(textResponse('done')));

      await collectChunks(baseConfig({ hooks }));

      // Matcher "Write|Edit" should NOT match "Bash"
      expect(hookCalls).toHaveLength(0);
    });

    test('PreToolUse: updatedInput modifies tool arguments', async () => {
      const hooks: ToolLoopHooks = {
        PreToolUse: [
          {
            hooks: [
              async () => ({
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse',
                  updatedInput: { command: 'echo modified' },
                },
              }),
            ],
          },
        ],
      };

      const bashArgs = JSON.stringify({ command: 'echo original' });
      fetchSpy = spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          jsonResponse(toolCallResponse([{ id: 'call_mod', name: 'Bash', arguments: bashArgs }]))
        )
        .mockResolvedValueOnce(jsonResponse(textResponse('done')));

      const chunks = await collectChunks(baseConfig({ hooks }));

      // The tool result should reflect the modified command
      const toolResult = chunks.find(c => c.type === 'tool_result');
      expect(toolResult).toBeDefined();
      if (toolResult?.type === 'tool_result') {
        // 'echo modified' should have been executed
        expect(toolResult.toolOutput).toContain('modified');
      }
    });

    test('PostToolUse: fires after successful tool execution', async () => {
      const hookCalls: PostToolUseHookInput[] = [];
      const hooks: ToolLoopHooks = {
        PostToolUse: [
          {
            hooks: [
              async input => {
                hookCalls.push(input as PostToolUseHookInput);
                return {};
              },
            ],
          },
        ],
      };

      const bashArgs = JSON.stringify({ command: 'echo hello' });
      fetchSpy = spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          jsonResponse(toolCallResponse([{ id: 'call_post', name: 'Bash', arguments: bashArgs }]))
        )
        .mockResolvedValueOnce(jsonResponse(textResponse('done')));

      await collectChunks(baseConfig({ hooks, sessionId: 'sess-post' }));

      expect(hookCalls).toHaveLength(1);
      expect(hookCalls[0]).toMatchObject({
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'echo hello' },
        tool_use_id: 'call_post',
        session_id: 'sess-post',
        cwd: '/tmp',
      });
      // tool_response should be the string output
      expect(typeof hookCalls[0].tool_response).toBe('string');
    });

    test('PostToolUseFailure: fires after tool execution error', async () => {
      const hookCalls: PostToolUseFailureHookInput[] = [];
      const hooks: ToolLoopHooks = {
        PostToolUseFailure: [
          {
            hooks: [
              async input => {
                hookCalls.push(input as PostToolUseFailureHookInput);
                return {};
              },
            ],
          },
        ],
      };

      // Read a non-existent file to trigger an error
      const readArgs = JSON.stringify({ file_path: '/tmp/nonexistent-hook-test-file-xyz.txt' });
      fetchSpy = spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          jsonResponse(toolCallResponse([{ id: 'call_fail', name: 'Read', arguments: readArgs }]))
        )
        .mockResolvedValueOnce(jsonResponse(textResponse('done')));

      await collectChunks(baseConfig({ hooks, sessionId: 'sess-fail' }));

      expect(hookCalls).toHaveLength(1);
      expect(hookCalls[0]).toMatchObject({
        hook_event_name: 'PostToolUseFailure',
        tool_name: 'Read',
        tool_use_id: 'call_fail',
        session_id: 'sess-fail',
        cwd: '/tmp',
      });
      expect(hookCalls[0].error).toBeDefined();
      expect(hookCalls[0].error.length).toBeGreaterThan(0);
    });

    test('hook errors are surfaced, not swallowed', async () => {
      const hooks: ToolLoopHooks = {
        PreToolUse: [
          {
            hooks: [
              async () => {
                throw new Error('Hook crashed intentionally');
              },
            ],
          },
        ],
      };

      const bashArgs = JSON.stringify({ command: 'echo test' });
      fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        jsonResponse(toolCallResponse([{ id: 'call_err', name: 'Bash', arguments: bashArgs }]))
      );

      await expect(collectChunks(baseConfig({ hooks }))).rejects.toThrow(
        'Hook crashed intentionally'
      );
    });

    test('PostToolUse matcher filters by tool name', async () => {
      const hookCalls: string[] = [];
      const hooks: ToolLoopHooks = {
        PostToolUse: [
          {
            matcher: 'Read',
            hooks: [
              async input => {
                hookCalls.push((input as PostToolUseHookInput).tool_name);
                return {};
              },
            ],
          },
        ],
      };

      const bashArgs = JSON.stringify({ command: 'echo hi' });
      fetchSpy = spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          jsonResponse(toolCallResponse([{ id: 'call_1', name: 'Bash', arguments: bashArgs }]))
        )
        .mockResolvedValueOnce(jsonResponse(textResponse('done')));

      await collectChunks(baseConfig({ hooks }));

      // Matcher "Read" should NOT fire for "Bash"
      expect(hookCalls).toHaveLength(0);
    });

    test('multiple hook matchers are all evaluated', async () => {
      const calls: string[] = [];
      const hooks: ToolLoopHooks = {
        PreToolUse: [
          {
            hooks: [
              async () => {
                calls.push('first');
                return {};
              },
            ],
          },
          {
            hooks: [
              async () => {
                calls.push('second');
                return {};
              },
            ],
          },
        ],
      };

      const bashArgs = JSON.stringify({ command: 'echo test' });
      fetchSpy = spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          jsonResponse(toolCallResponse([{ id: 'call_m', name: 'Bash', arguments: bashArgs }]))
        )
        .mockResolvedValueOnce(jsonResponse(textResponse('done')));

      await collectChunks(baseConfig({ hooks }));

      expect(calls).toEqual(['first', 'second']);
    });

    test('default sessionId is empty string when not provided', async () => {
      let capturedSessionId = '';
      const hooks: ToolLoopHooks = {
        PreToolUse: [
          {
            hooks: [
              async input => {
                capturedSessionId = (input as PreToolUseHookInput).session_id;
                return {};
              },
            ],
          },
        ],
      };

      const bashArgs = JSON.stringify({ command: 'echo test' });
      fetchSpy = spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          jsonResponse(toolCallResponse([{ id: 'call_s', name: 'Bash', arguments: bashArgs }]))
        )
        .mockResolvedValueOnce(jsonResponse(textResponse('done')));

      // No sessionId in config
      await collectChunks(baseConfig({ hooks }));

      expect(capturedSessionId).toBe('');
    });
  });

  // ─── MCP + Skills integration tests (US-021) ─────────────────────────────

  describe('mcpProvider integration', () => {
    /** Minimal mock McpToolProvider. */
    function createMockMcpProvider(
      tools: import('./tool-definitions').ToolDefinition[],
      callResult?: string
    ) {
      return {
        getToolDefinitions: () => tools,
        callTool: async (_name: string, _args: Record<string, unknown>) =>
          callResult ?? 'mcp-result',
        connect: async () => {},
        shutdown: async () => {},
      } as unknown as import('./mcp-client').McpToolProvider;
    }

    test('MCP tools merged into tool list sent to API', async () => {
      const mcpTool: import('./tool-definitions').ToolDefinition = {
        type: 'function',
        function: {
          name: 'mcp__myserver__search',
          description: 'MCP search',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      };
      const mcpProvider = createMockMcpProvider([mcpTool]);

      let body: Record<string, unknown> | null = null;
      fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
        async (_url: string | URL | Request, init?: RequestInit) => {
          body = JSON.parse(init?.body as string) as Record<string, unknown>;
          return jsonResponse(textResponse('ok'));
        }
      );

      await collectChunks(baseConfig({ mcpProvider }));

      const tools = body!.tools as { function: { name: string } }[];
      const names = tools.map(t => t.function.name);
      // 8 canonical + 1 MCP
      expect(names).toContain('mcp__myserver__search');
      expect(names).toContain('Read');
      expect(tools.length).toBe(9);
    });

    test('MCP tool call dispatched to provider', async () => {
      const mcpTool: import('./tool-definitions').ToolDefinition = {
        type: 'function',
        function: {
          name: 'mcp__db__query',
          description: 'Run SQL',
          parameters: {
            type: 'object',
            properties: { sql: { type: 'string' } },
            required: ['sql'],
          },
        },
      };

      const callArgs: { name: string; args: Record<string, unknown> }[] = [];
      const mcpProvider = {
        getToolDefinitions: () => [mcpTool],
        callTool: async (name: string, args: Record<string, unknown>) => {
          callArgs.push({ name, args });
          return 'query result: 42';
        },
        connect: async () => {},
        shutdown: async () => {},
      } as unknown as import('./mcp-client').McpToolProvider;

      const mcpArgs = JSON.stringify({ sql: 'SELECT 1' });
      fetchSpy = spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          jsonResponse(
            toolCallResponse([{ id: 'call_mcp', name: 'mcp__db__query', arguments: mcpArgs }])
          )
        )
        .mockResolvedValueOnce(jsonResponse(textResponse('done')));

      const chunks = await collectChunks(baseConfig({ mcpProvider }));

      // Verify MCP callTool was invoked
      expect(callArgs).toHaveLength(1);
      expect(callArgs[0].name).toBe('mcp__db__query');
      expect(callArgs[0].args).toEqual({ sql: 'SELECT 1' });

      // Verify tool_result chunk emitted
      const resultChunk = chunks.find(
        c => c.type === 'tool_result' && c.toolName === 'mcp__db__query'
      );
      expect(resultChunk).toBeDefined();
      expect(resultChunk!.toolOutput).toBe('query result: 42');
    });

    test('MCP tool error formatted as error result', async () => {
      const mcpTool: import('./tool-definitions').ToolDefinition = {
        type: 'function',
        function: {
          name: 'mcp__srv__fail',
          description: 'Fails',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      };
      const mcpProvider = {
        getToolDefinitions: () => [mcpTool],
        callTool: async () => {
          throw new Error('connection refused');
        },
        connect: async () => {},
        shutdown: async () => {},
      } as unknown as import('./mcp-client').McpToolProvider;

      fetchSpy = spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          jsonResponse(
            toolCallResponse([{ id: 'call_f', name: 'mcp__srv__fail', arguments: '{}' }])
          )
        )
        .mockResolvedValueOnce(jsonResponse(textResponse('recovered')));

      const chunks = await collectChunks(baseConfig({ mcpProvider }));

      const resultChunk = chunks.find(
        c => c.type === 'tool_result' && c.toolName === 'mcp__srv__fail'
      );
      expect(resultChunk).toBeDefined();
      expect(resultChunk!.toolOutput).toContain('Error executing MCP tool');
      expect(resultChunk!.toolOutput).toContain('connection refused');
    });

    test('MCP tools filtered by allowedTools', async () => {
      const mcpTool: import('./tool-definitions').ToolDefinition = {
        type: 'function',
        function: {
          name: 'mcp__srv__search',
          description: 'Search',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      };
      const mcpProvider = createMockMcpProvider([mcpTool]);

      let body: Record<string, unknown> | null = null;
      fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
        async (_url: string | URL | Request, init?: RequestInit) => {
          body = JSON.parse(init?.body as string) as Record<string, unknown>;
          return jsonResponse(textResponse('ok'));
        }
      );

      // allowedTools includes the MCP tool + Read
      await collectChunks(baseConfig({ mcpProvider, allowedTools: ['Read', 'mcp__srv__search'] }));

      const tools = body!.tools as { function: { name: string } }[];
      expect(tools).toHaveLength(2);
      expect(tools.map(t => t.function.name).sort()).toEqual(['Read', 'mcp__srv__search']);
    });

    test('MCP tools filtered by deniedTools', async () => {
      const mcpTool: import('./tool-definitions').ToolDefinition = {
        type: 'function',
        function: {
          name: 'mcp__srv__dangerous',
          description: 'Dangerous',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      };
      const mcpProvider = createMockMcpProvider([mcpTool]);

      let body: Record<string, unknown> | null = null;
      fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
        async (_url: string | URL | Request, init?: RequestInit) => {
          body = JSON.parse(init?.body as string) as Record<string, unknown>;
          return jsonResponse(textResponse('ok'));
        }
      );

      await collectChunks(baseConfig({ mcpProvider, deniedTools: ['mcp__srv__dangerous'] }));

      const tools = body!.tools as { function: { name: string } }[];
      const names = tools.map(t => t.function.name);
      expect(names).not.toContain('mcp__srv__dangerous');
      // 8 canonical only
      expect(tools).toHaveLength(8);
    });
  });

  describe('skillContext integration', () => {
    test('skill system prompt additions appended to messages', async () => {
      let body: Record<string, unknown> | null = null;
      fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
        async (_url: string | URL | Request, init?: RequestInit) => {
          body = JSON.parse(init?.body as string) as Record<string, unknown>;
          return jsonResponse(textResponse('ok'));
        }
      );

      const skillContext: import('./skill-loader').SkillContext = {
        systemPromptAdditions: ['You are a SQL expert.', 'Always use safe queries.'],
        toolAllowlist: [],
      };

      await collectChunks(baseConfig({ skillContext }));

      const messages = body!.messages as { role: string; content: string }[];
      // user message + 2 skill system messages
      expect(messages).toHaveLength(3);
      expect(messages[0]).toMatchObject({ role: 'user', content: 'hello' });
      expect(messages[1]).toMatchObject({ role: 'system', content: 'You are a SQL expert.' });
      expect(messages[2]).toMatchObject({
        role: 'system',
        content: 'Always use safe queries.',
      });
    });

    test('skill system prompt + systemPrompt both injected', async () => {
      let body: Record<string, unknown> | null = null;
      fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
        async (_url: string | URL | Request, init?: RequestInit) => {
          body = JSON.parse(init?.body as string) as Record<string, unknown>;
          return jsonResponse(textResponse('ok'));
        }
      );

      const skillContext: import('./skill-loader').SkillContext = {
        systemPromptAdditions: ['Skill prompt here'],
        toolAllowlist: [],
      };

      await collectChunks(baseConfig({ systemPrompt: 'Base system', skillContext }));

      const messages = body!.messages as { role: string; content: string }[];
      // systemPrompt first, user, then skill
      expect(messages[0]).toMatchObject({ role: 'system', content: 'Base system' });
      expect(messages[1]).toMatchObject({ role: 'user', content: 'hello' });
      expect(messages[2]).toMatchObject({ role: 'system', content: 'Skill prompt here' });
    });

    test('skill toolAllowlist restricts tools when no allowedTools set', async () => {
      let body: Record<string, unknown> | null = null;
      fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
        async (_url: string | URL | Request, init?: RequestInit) => {
          body = JSON.parse(init?.body as string) as Record<string, unknown>;
          return jsonResponse(textResponse('ok'));
        }
      );

      const skillContext: import('./skill-loader').SkillContext = {
        systemPromptAdditions: [],
        toolAllowlist: ['Read', 'Write', 'Edit'],
      };

      await collectChunks(baseConfig({ skillContext }));

      const tools = body!.tools as { function: { name: string } }[];
      expect(tools).toHaveLength(3);
      expect(tools.map(t => t.function.name).sort()).toEqual(['Edit', 'Read', 'Write']);
    });

    test('skill toolAllowlist intersected with allowedTools', async () => {
      let body: Record<string, unknown> | null = null;
      fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
        async (_url: string | URL | Request, init?: RequestInit) => {
          body = JSON.parse(init?.body as string) as Record<string, unknown>;
          return jsonResponse(textResponse('ok'));
        }
      );

      const skillContext: import('./skill-loader').SkillContext = {
        systemPromptAdditions: [],
        toolAllowlist: ['Read', 'Write', 'Bash'],
      };

      // allowedTools: Read, Write, Glob — intersect with skill: Read, Write, Bash → Read, Write
      await collectChunks(baseConfig({ allowedTools: ['Read', 'Write', 'Glob'], skillContext }));

      const tools = body!.tools as { function: { name: string } }[];
      expect(tools).toHaveLength(2);
      expect(tools.map(t => t.function.name).sort()).toEqual(['Read', 'Write']);
    });

    test('empty skill toolAllowlist means no skill restrictions', async () => {
      let body: Record<string, unknown> | null = null;
      fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
        async (_url: string | URL | Request, init?: RequestInit) => {
          body = JSON.parse(init?.body as string) as Record<string, unknown>;
          return jsonResponse(textResponse('ok'));
        }
      );

      const skillContext: import('./skill-loader').SkillContext = {
        systemPromptAdditions: [],
        toolAllowlist: [],
      };

      await collectChunks(baseConfig({ skillContext }));

      const tools = body!.tools as { function: { name: string } }[];
      // No restriction — all 8 canonical tools
      expect(tools).toHaveLength(8);
    });
  });

  describe('MCP + skills combined', () => {
    test('MCP tools + skill context work together', async () => {
      const mcpTool: import('./tool-definitions').ToolDefinition = {
        type: 'function',
        function: {
          name: 'mcp__api__fetch',
          description: 'Fetch API',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      };
      const mcpProvider = {
        getToolDefinitions: () => [mcpTool],
        callTool: async () => 'api result',
        connect: async () => {},
        shutdown: async () => {},
      } as unknown as import('./mcp-client').McpToolProvider;

      const skillContext: import('./skill-loader').SkillContext = {
        systemPromptAdditions: ['Use the API tool when possible.'],
        toolAllowlist: ['Read', 'mcp__api__fetch'],
      };

      let body: Record<string, unknown> | null = null;
      fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
        async (_url: string | URL | Request, init?: RequestInit) => {
          body = JSON.parse(init?.body as string) as Record<string, unknown>;
          return jsonResponse(textResponse('ok'));
        }
      );

      await collectChunks(baseConfig({ mcpProvider, skillContext }));

      const tools = body!.tools as { function: { name: string } }[];
      // skill allowlist: Read + mcp__api__fetch
      expect(tools).toHaveLength(2);
      expect(tools.map(t => t.function.name).sort()).toEqual(['Read', 'mcp__api__fetch']);

      const messages = body!.messages as { role: string; content: string }[];
      expect(messages.some(m => m.content === 'Use the API tool when possible.')).toBe(true);
    });
  });
});
