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
});
