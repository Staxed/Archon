import { describe, test, expect, spyOn, afterEach } from 'bun:test';
import type { ChatMessage } from './tool-loop';
import type { ToolDefinition } from './tool-definitions';
import {
  estimateStringTokens,
  estimateMessageTokens,
  estimateToolTokens,
  estimateRequestTokens,
  getModelWindowSize,
  ContextWindowManager,
  ContextWindowSummarizationError,
} from './context-window';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeMessage(role: ChatMessage['role'], content: string): ChatMessage {
  return { role, content };
}

function makeTool(name: string): ToolDefinition {
  return {
    type: 'function',
    function: {
      name,
      description: `The ${name} tool`,
      parameters: { type: 'object', properties: {}, required: [] },
    },
  };
}

const defaultEndpoint = {
  url: 'http://localhost:8080/v1/chat/completions',
  stream: false,
};

// Restore fetch after each test
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ─── estimateStringTokens ───────────────────────────────────────────────────

describe('estimateStringTokens', () => {
  test('returns 0 for empty string', () => {
    expect(estimateStringTokens('')).toBe(0);
  });

  test('estimates tokens for a short string', () => {
    // "Hello" = 5 chars / 3.5 ≈ 2 (ceil)
    expect(estimateStringTokens('Hello')).toBe(2);
  });

  test('estimates tokens for a longer string', () => {
    // 100 chars / 3.5 ≈ 29 (ceil)
    const text = 'a'.repeat(100);
    expect(estimateStringTokens(text)).toBe(29);
  });
});

// ─── estimateMessageTokens ──────────────────────────────────────────────────

describe('estimateMessageTokens', () => {
  test('includes base overhead for empty message', () => {
    const msg: ChatMessage = { role: 'user', content: '' };
    // Base overhead = 4
    expect(estimateMessageTokens(msg)).toBe(4);
  });

  test('includes content tokens', () => {
    const msg: ChatMessage = { role: 'user', content: 'Hello world' };
    const tokens = estimateMessageTokens(msg);
    // 4 base + ceil(11 / 3.5) = 4 + 4 = 8
    expect(tokens).toBe(8);
  });

  test('includes tool_calls tokens', () => {
    const msg: ChatMessage = {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'Read', arguments: '{"file_path": "/test.ts"}' },
        },
      ],
    };
    const tokens = estimateMessageTokens(msg);
    // Should include function name + arguments tokens
    expect(tokens).toBeGreaterThan(4);
  });

  test('includes tool_call_id and name tokens', () => {
    const msg: ChatMessage = {
      role: 'tool',
      content: 'file content here',
      tool_call_id: 'call_123',
      name: 'Read',
    };
    const tokens = estimateMessageTokens(msg);
    // More than just base + content
    expect(tokens).toBeGreaterThan(
      estimateMessageTokens({ role: 'tool', content: 'file content here' })
    );
  });
});

// ─── estimateToolTokens ─────────────────────────────────────────────────────

describe('estimateToolTokens', () => {
  test('returns 0 for empty tools array', () => {
    expect(estimateToolTokens([])).toBe(0);
  });

  test('estimates tokens for tool definitions', () => {
    const tools = [makeTool('Read'), makeTool('Write')];
    const tokens = estimateToolTokens(tools);
    expect(tokens).toBeGreaterThan(0);
  });
});

// ─── estimateRequestTokens ──────────────────────────────────────────────────

describe('estimateRequestTokens', () => {
  test('combines message and tool estimates', () => {
    const messages = [makeMessage('system', 'You are helpful'), makeMessage('user', 'Hello')];
    const tools = [makeTool('Read')];
    const total = estimateRequestTokens(messages, tools);

    const msgTokens = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
    const toolTokens = estimateToolTokens(tools);

    // total = messages + tools + 10 overhead
    expect(total).toBe(msgTokens + toolTokens + 10);
  });
});

// ─── getModelWindowSize ─────────────────────────────────────────────────────

describe('getModelWindowSize', () => {
  test('returns known size for gpt-4o', () => {
    expect(getModelWindowSize('gpt-4o')).toBe(128_000);
  });

  test('returns known size for vendored model', () => {
    expect(getModelWindowSize('anthropic/claude-3-haiku')).toBe(200_000);
  });

  test('returns default for unknown model', () => {
    expect(getModelWindowSize('some-unknown-model')).toBe(16_384);
  });
});

// ─── ContextWindowManager ───────────────────────────────────────────────────

describe('ContextWindowManager', () => {
  test('estimateTokens returns positive number', () => {
    const mgr = new ContextWindowManager({
      model: 'gpt-4o',
      endpoint: defaultEndpoint,
    });
    const messages = [makeMessage('system', 'Hello'), makeMessage('user', 'World')];
    expect(mgr.estimateTokens(messages, [])).toBeGreaterThan(0);
  });

  test('shouldSummarize returns false for small conversations', () => {
    const mgr = new ContextWindowManager({
      model: 'gpt-4o',
      endpoint: defaultEndpoint,
    });
    const messages = [makeMessage('system', 'Hello'), makeMessage('user', 'Hi')];
    expect(mgr.shouldSummarize(messages, [])).toBe(false);
  });

  test('shouldSummarize returns true when tokens exceed threshold', () => {
    const mgr = new ContextWindowManager({
      model: 'gpt-4o',
      contextWindowSize: 100, // tiny window for testing
      reservationThreshold: 0.5, // trigger at 50 tokens
      endpoint: defaultEndpoint,
    });
    // Create messages that exceed 50 estimated tokens
    const messages = [makeMessage('system', 'a'.repeat(200)), makeMessage('user', 'b'.repeat(200))];
    expect(mgr.shouldSummarize(messages, [])).toBe(true);
  });

  test('shouldSummarize respects custom contextWindowSize', () => {
    const mgr = new ContextWindowManager({
      model: 'gpt-4o',
      contextWindowSize: 1_000_000, // huge window
      endpoint: defaultEndpoint,
    });
    const messages = [makeMessage('system', 'Hello'), makeMessage('user', 'Hi')];
    expect(mgr.shouldSummarize(messages, [])).toBe(false);
  });

  test('summarize replaces oldest turns with summary', async () => {
    const summaryText = 'This is a summary of the conversation.';

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: summaryText } }],
        }),
        { status: 200 }
      );

    const mgr = new ContextWindowManager({
      model: 'gpt-4o',
      contextWindowSize: 100,
      preserveRecentTurns: 2,
      endpoint: defaultEndpoint,
    });

    const messages: ChatMessage[] = [
      makeMessage('system', 'You are helpful'),
      makeMessage('user', 'First long message ' + 'x'.repeat(200)),
      makeMessage('assistant', 'First response ' + 'y'.repeat(200)),
      makeMessage('user', 'Second message'),
      makeMessage('assistant', 'Second response'),
    ];

    const result = await mgr.summarize(messages, []);

    // Should have: system + summary + 2 preserved
    expect(result.messages.length).toBe(4);
    expect(result.messages[0]!.role).toBe('system');
    expect(result.messages[0]!.content).toBe('You are helpful');
    expect(result.messages[1]!.role).toBe('system');
    expect(result.messages[1]!.content).toContain('[Summary of');
    expect(result.messages[1]!.content).toContain(summaryText);
    expect(result.messages[2]!.content).toBe('Second message');
    expect(result.messages[3]!.content).toBe('Second response');

    // Metadata
    expect(result.metadata.summarizedTurnIndices).toEqual([1, 2]);
    expect(result.metadata.originalTokenEstimate).toBeGreaterThan(0);
    expect(result.metadata.summaryTokenEstimate).toBeGreaterThan(0);
  });

  test('summarize preserves multiple system messages', async () => {
    const summaryText = 'Summary content.';

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: summaryText } }],
        }),
        { status: 200 }
      );

    const mgr = new ContextWindowManager({
      model: 'gpt-4o',
      contextWindowSize: 100,
      preserveRecentTurns: 1,
      endpoint: defaultEndpoint,
    });

    const messages: ChatMessage[] = [
      makeMessage('system', 'System prompt 1'),
      makeMessage('system', 'System prompt 2'),
      makeMessage('user', 'Long first message ' + 'x'.repeat(200)),
      makeMessage('assistant', 'Long response ' + 'y'.repeat(200)),
      makeMessage('user', 'Recent message'),
    ];

    const result = await mgr.summarize(messages, []);

    // Should have: 2 system + summary + 1 preserved
    expect(result.messages.length).toBe(4);
    expect(result.messages[0]!.content).toBe('System prompt 1');
    expect(result.messages[1]!.content).toBe('System prompt 2');
    expect(result.messages[2]!.role).toBe('system'); // summary
    expect(result.messages[3]!.content).toBe('Recent message');
  });

  test('summarize throws when no turns available to summarize', async () => {
    const mgr = new ContextWindowManager({
      model: 'gpt-4o',
      contextWindowSize: 100,
      preserveRecentTurns: 10, // preserve more than available
      endpoint: defaultEndpoint,
    });

    const messages: ChatMessage[] = [
      makeMessage('system', 'System prompt'),
      makeMessage('user', 'Hello'),
      makeMessage('assistant', 'Hi'),
    ];

    await expect(mgr.summarize(messages, [])).rejects.toThrow(ContextWindowSummarizationError);
  });

  test('summarize throws on API failure', async () => {
    globalThis.fetch = async () => new Response('Internal error', { status: 500 });

    const mgr = new ContextWindowManager({
      model: 'gpt-4o',
      contextWindowSize: 100,
      preserveRecentTurns: 1,
      endpoint: defaultEndpoint,
    });

    const messages: ChatMessage[] = [
      makeMessage('system', 'System prompt'),
      makeMessage('user', 'Long message ' + 'x'.repeat(200)),
      makeMessage('assistant', 'Long response ' + 'y'.repeat(200)),
      makeMessage('user', 'Recent'),
    ];

    await expect(mgr.summarize(messages, [])).rejects.toThrow(ContextWindowSummarizationError);
  });

  test('summarize throws on empty summary response', async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '' } }],
        }),
        { status: 200 }
      );

    const mgr = new ContextWindowManager({
      model: 'gpt-4o',
      contextWindowSize: 100,
      preserveRecentTurns: 1,
      endpoint: defaultEndpoint,
    });

    const messages: ChatMessage[] = [
      makeMessage('system', 'System prompt'),
      makeMessage('user', 'Long message ' + 'x'.repeat(200)),
      makeMessage('assistant', 'Long response ' + 'y'.repeat(200)),
      makeMessage('user', 'Recent'),
    ];

    await expect(mgr.summarize(messages, [])).rejects.toThrow(ContextWindowSummarizationError);
  });

  test('summarize sends correct request to provider', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    let capturedHeaders: Record<string, string> | undefined;

    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = Object.fromEntries(Object.entries(init?.headers ?? {})) as Record<
        string,
        string
      >;
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Summary of the conversation' } }],
        }),
        { status: 200 }
      );
    };

    const mgr = new ContextWindowManager({
      model: 'gpt-4o',
      contextWindowSize: 100,
      preserveRecentTurns: 1,
      endpoint: {
        url: 'http://test-endpoint/v1/chat/completions',
        apiKey: 'test-key-123',
        headers: { 'X-Custom': 'value' },
        stream: false,
      },
    });

    const messages: ChatMessage[] = [
      makeMessage('system', 'System prompt'),
      makeMessage('user', 'Long message ' + 'x'.repeat(200)),
      makeMessage('assistant', 'Long response ' + 'y'.repeat(200)),
      makeMessage('user', 'Recent'),
    ];

    await mgr.summarize(messages, []);

    expect(capturedHeaders).toBeDefined();
    expect(capturedHeaders!.Authorization).toBe('Bearer test-key-123');
    expect(capturedHeaders!['X-Custom']).toBe('value');
    expect(capturedBody).toBeDefined();
    expect(capturedBody!.model).toBe('gpt-4o');
    expect(capturedBody!.stream).toBe(false);
    expect(Array.isArray(capturedBody!.messages)).toBe(true);
  });

  test('summarize throws when result is still too large', async () => {
    // Return a summary that is LONGER than the original content
    const hugeSummary = 'x'.repeat(10000);

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: hugeSummary } }],
        }),
        { status: 200 }
      );

    const mgr = new ContextWindowManager({
      model: 'gpt-4o',
      contextWindowSize: 100,
      preserveRecentTurns: 1,
      endpoint: defaultEndpoint,
    });

    const messages: ChatMessage[] = [
      makeMessage('system', 'System'),
      makeMessage('user', 'Short'),
      makeMessage('user', 'Recent'),
    ];

    await expect(mgr.summarize(messages, [])).rejects.toThrow(ContextWindowSummarizationError);
  });
});
