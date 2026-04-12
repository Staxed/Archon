import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { createMockLogger } from '../test/mocks/logger';

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

/** Default usage matching Codex SDK's Usage type (required on TurnCompletedEvent) */
const defaultUsage = { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 };

// Create mock runStreamed first (before it's referenced)
const mockRunStreamed = mock(() =>
  Promise.resolve({
    events: (async function* () {
      yield { type: 'turn.completed', usage: defaultUsage };
    })(),
  })
);

// Create a mock thread object factory
const createMockThread = (id: string) => ({
  id,
  runStreamed: mockRunStreamed,
});

// Create mock functions for Codex SDK that use createMockThread
const mockStartThread = mock(() => createMockThread('new-thread-id'));
const mockResumeThread = mock(() => createMockThread('resumed-thread-id'));

// Mock Codex class
const MockCodex = mock(() => ({
  startThread: mockStartThread,
  resumeThread: mockResumeThread,
}));

// Mock the Codex SDK
mock.module('@openai/codex-sdk', () => ({
  Codex: MockCodex,
}));

// ── Tool-loop fallback mocks ──
const mockExecuteToolLoop = mock(async function* () {
  yield { type: 'assistant' as const, content: 'Tool loop response' };
  yield { type: 'result' as const, sessionId: undefined, tokens: { input: 5, output: 3 } };
});

mock.module('./tool-loop', () => ({
  executeToolLoop: mockExecuteToolLoop,
}));

const mockMcpConnect = mock(() => Promise.resolve());
const mockMcpShutdown = mock(() => Promise.resolve());
const mockMcpGetToolDefinitions = mock(() => []);
const MockMcpToolProvider = mock(() => ({
  connect: mockMcpConnect,
  shutdown: mockMcpShutdown,
  getToolDefinitions: mockMcpGetToolDefinitions,
}));

mock.module('./mcp-client', () => ({
  McpToolProvider: MockMcpToolProvider,
}));

const mockLoadSkills = mock(() =>
  Promise.resolve({ systemPromptAdditions: [], toolAllowlist: [] })
);

mock.module('./skill-loader', () => ({
  loadSkills: mockLoadSkills,
}));

const mockShouldSummarize = mock(() => false);
const mockSummarize = mock(() => Promise.resolve({ messages: [] }));
const MockContextWindowManager = mock(() => ({
  shouldSummarize: mockShouldSummarize,
  summarize: mockSummarize,
}));

mock.module('./context-window', () => ({
  ContextWindowManager: MockContextWindowManager,
}));

mock.module('./tool-definitions', () => ({
  toolDefinitions: [
    { type: 'function', function: { name: 'Read', description: 'Read a file', parameters: {} } },
  ],
}));

import { CodexClient } from './codex';

describe('CodexClient', () => {
  let client: CodexClient;

  beforeEach(() => {
    client = new CodexClient({ retryBaseDelayMs: 1 });
    mockStartThread.mockClear();
    mockResumeThread.mockClear();
    mockRunStreamed.mockClear();
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.debug.mockClear();

    // Setup default mock thread
    mockStartThread.mockReturnValue(createMockThread('new-thread-id'));
    mockResumeThread.mockReturnValue(createMockThread('resumed-thread-id'));
  });

  describe('getType', () => {
    test('returns codex', () => {
      expect(client.getType()).toBe('codex');
    });
  });

  describe('sendQuery', () => {
    test('yields text events from agent_message items', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: { type: 'agent_message', text: 'Hello from Codex!' },
          };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toEqual({ type: 'assistant', content: 'Hello from Codex!' });
      expect(chunks[1]).toEqual({
        type: 'result',
        sessionId: 'new-thread-id',
        tokens: { input: 10, output: 5 },
      });
    });

    test('yields tool events from command_execution items', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: {
              type: 'command_execution',
              command: 'npm test',
              aggregated_output: 'tests passed\n',
              exit_code: 0,
            },
          };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace')) {
        chunks.push(chunk);
      }

      // Codex item.completed fires once the command is fully done, so we emit
      // start + result back-to-back to close the UI tool card immediately.
      expect(chunks[0]).toEqual({ type: 'tool', toolName: 'npm test' });
      expect(chunks[1]).toEqual({
        type: 'tool_result',
        toolName: 'npm test',
        toolOutput: 'tests passed\n',
      });
    });

    test('appends non-zero exit code to command_execution tool_result', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: {
              type: 'command_execution',
              command: 'npm test',
              aggregated_output: 'failure\n',
              exit_code: 1,
            },
          };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[1]).toEqual({
        type: 'tool_result',
        toolName: 'npm test',
        toolOutput: 'failure\n\n[exit code: 1]',
      });
    });

    test('yields thinking events from reasoning items', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: { type: 'reasoning', text: 'Let me think about this...' },
          };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({ type: 'thinking', content: 'Let me think about this...' });
    });

    test('yields tool events from web_search items', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'item.completed', item: { type: 'web_search', query: 'codex sdk' } };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({ type: 'tool', toolName: '🔍 Searching: codex sdk' });
      expect(chunks[1]).toEqual({
        type: 'tool_result',
        toolName: '🔍 Searching: codex sdk',
        toolOutput: '',
      });
    });

    test('yields system task list for todo_list items and deduplicates', async () => {
      const todoItem = {
        type: 'todo_list',
        items: [
          { text: 'Scan repo', completed: true },
          { text: 'Add tests', completed: false },
        ],
      };

      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'item.completed', item: todoItem };
          yield { type: 'item.completed', item: todoItem };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({
        type: 'system',
        content: '📋 Tasks:\n✅ Scan repo\n⬜ Add tests',
      });
      expect(chunks).toHaveLength(2);
    });

    test('yields updated todo_list when items change', async () => {
      const todoV1 = {
        type: 'todo_list',
        items: [
          { text: 'Scan repo', completed: false },
          { text: 'Add tests', completed: false },
        ],
      };
      const todoV2 = {
        type: 'todo_list',
        items: [
          { text: 'Scan repo', completed: true },
          { text: 'Add tests', completed: false },
        ],
      };

      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'item.completed', item: todoV1 };
          yield { type: 'item.completed', item: todoV2 };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(3); // todoV1 + todoV2 + result
      expect(chunks[0]).toEqual({
        type: 'system',
        content: '📋 Tasks:\n⬜ Scan repo\n⬜ Add tests',
      });
      expect(chunks[1]).toEqual({
        type: 'system',
        content: '📋 Tasks:\n✅ Scan repo\n⬜ Add tests',
      });
    });

    test('yields file change summary for file_change items', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: {
              type: 'file_change',
              status: 'completed',
              changes: [
                { kind: 'add', path: 'src/new.ts' },
                { kind: 'update', path: 'src/app.ts' },
                { kind: 'delete', path: 'src/old.ts' },
              ],
            },
          };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({
        type: 'system',
        content: '✅ File changes:\n➕ src/new.ts\n📝 src/app.ts\n➖ src/old.ts',
      });
    });

    test('yields failed file change with error message', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: {
              type: 'file_change',
              status: 'failed',
              error: { message: 'Permission denied' },
              changes: [{ kind: 'update', path: 'src/locked.ts' }],
            },
          };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({
        type: 'system',
        content: '❌ File changes:\n📝 src/locked.ts\nPermission denied',
      });
    });

    test('yields failed file change without changes array', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: {
              type: 'file_change',
              status: 'failed',
              error: { message: 'Disk full' },
            },
          };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({
        type: 'system',
        content: '❌ File change failed: Disk full',
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'failed' }),
        'file_change_failed_no_changes'
      );
    });

    test('yields failed file change without error message', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: { type: 'file_change', status: 'failed' },
          };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({
        type: 'system',
        content: '❌ File change failed',
      });
    });

    test('yields MCP tool call events and failures', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: { type: 'mcp_tool_call', server: 'fs', tool: 'readFile', status: 'in_progress' },
          };
          yield {
            type: 'item.completed',
            item: {
              type: 'mcp_tool_call',
              server: 'fs',
              tool: 'readFile',
              status: 'failed',
              error: { message: 'Permission denied' },
            },
          };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      // First mcp call (in_progress on item.completed): start + empty result
      expect(chunks[0]).toEqual({ type: 'tool', toolName: '🔌 MCP: fs/readFile' });
      expect(chunks[1]).toEqual({
        type: 'tool_result',
        toolName: '🔌 MCP: fs/readFile',
        toolOutput: '',
      });
      // Second mcp call (failed): start + error result so the UI card closes
      expect(chunks[2]).toEqual({ type: 'tool', toolName: '🔌 MCP: fs/readFile' });
      expect(chunks[3]).toEqual({
        type: 'tool_result',
        toolName: '🔌 MCP: fs/readFile',
        toolOutput: '❌ Error: Permission denied',
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ server: 'fs', tool: 'readFile' }),
        'mcp_tool_call_failed'
      );
    });

    test('yields MCP tool call with partial identification', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: { type: 'mcp_tool_call', tool: 'readFile', status: 'in_progress' },
          };
          yield {
            type: 'item.completed',
            item: { type: 'mcp_tool_call', server: 'fs', status: 'in_progress' },
          };
          yield {
            type: 'item.completed',
            item: { type: 'mcp_tool_call', status: 'in_progress' },
          };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      // Each item now emits start + empty result so the UI cards always close.
      expect(chunks[0]).toEqual({ type: 'tool', toolName: '🔌 MCP: readFile' });
      expect(chunks[1]).toEqual({
        type: 'tool_result',
        toolName: '🔌 MCP: readFile',
        toolOutput: '',
      });
      expect(chunks[2]).toEqual({ type: 'tool', toolName: '🔌 MCP: fs' });
      expect(chunks[3]).toEqual({ type: 'tool_result', toolName: '🔌 MCP: fs', toolOutput: '' });
      expect(chunks[4]).toEqual({ type: 'tool', toolName: '🔌 MCP: MCP tool' });
      expect(chunks[5]).toEqual({
        type: 'tool_result',
        toolName: '🔌 MCP: MCP tool',
        toolOutput: '',
      });
    });

    test('yields MCP failure without error message', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: { type: 'mcp_tool_call', server: 'db', tool: 'query', status: 'failed' },
          };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({ type: 'tool', toolName: '🔌 MCP: db/query' });
      expect(chunks[1]).toEqual({
        type: 'tool_result',
        toolName: '🔌 MCP: db/query',
        toolOutput: '❌ Error: MCP tool failed',
      });
    });

    test('emits paired tool + tool_result for completed MCP tool call', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: {
              type: 'mcp_tool_call',
              server: 'fs',
              tool: 'readFile',
              status: 'completed',
              result: { content: [{ type: 'text', text: 'file contents' }] },
            },
          };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      // Completed MCP calls now emit tool + tool_result so the UI card closes.
      expect(chunks).toHaveLength(3);
      expect(chunks[0]).toEqual({ type: 'tool', toolName: '🔌 MCP: fs/readFile' });
      expect(chunks[1]).toEqual({
        type: 'tool_result',
        toolName: '🔌 MCP: fs/readFile',
        toolOutput: JSON.stringify([{ type: 'text', text: 'file contents' }]),
      });
      expect(chunks[2]).toEqual({
        type: 'result',
        sessionId: 'new-thread-id',
        tokens: { input: 10, output: 5 },
      });
    });

    test('creates new thread with sandbox/network settings', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of client.sendQuery('test prompt', '/my/workspace')) {
        // consume
      }

      expect(mockStartThread).toHaveBeenCalledWith(
        expect.objectContaining({
          workingDirectory: '/my/workspace',
          skipGitRepoCheck: true,
          sandboxMode: 'danger-full-access',
          networkAccessEnabled: true,
          approvalPolicy: 'never',
        })
      );
    });

    test('resumes existing thread with sandbox/network settings', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of client.sendQuery('test prompt', '/workspace', 'existing-thread')) {
        // consume
      }

      expect(mockResumeThread).toHaveBeenCalledWith(
        'existing-thread',
        expect.objectContaining({
          workingDirectory: '/workspace',
          skipGitRepoCheck: true,
          sandboxMode: 'danger-full-access',
          networkAccessEnabled: true,
          approvalPolicy: 'never',
        })
      );
      expect(mockStartThread).not.toHaveBeenCalled();
    });

    test('falls back to new thread when resume fails and notifies user', async () => {
      const resumeError = new Error('Thread not found');
      mockResumeThread.mockImplementation(() => {
        throw resumeError;
      });
      mockStartThread.mockReturnValue(createMockThread('fallback-thread'));

      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace', 'bad-thread-id')) {
        chunks.push(chunk);
      }

      expect(mockResumeThread).toHaveBeenCalled();
      // Verify fallback startThread is called with correct config options
      expect(mockStartThread).toHaveBeenCalledWith(
        expect.objectContaining({
          workingDirectory: '/workspace',
          skipGitRepoCheck: true,
          sandboxMode: 'danger-full-access',
          networkAccessEnabled: true,
          approvalPolicy: 'never',
        })
      );
      // Verify error was logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        { err: resumeError, sessionId: 'bad-thread-id' },
        'resume_thread_failed'
      );
      // Verify user is notified about session loss
      expect(chunks[0]).toEqual({
        type: 'system',
        content: expect.stringContaining('Could not resume previous session'),
      });
      expect(chunks[1]).toEqual({
        type: 'result',
        sessionId: 'fallback-thread',
        tokens: { input: 10, output: 5 },
      });
    });

    test('passes model and codex options to thread options', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of client.sendQuery('test prompt', '/workspace', undefined, {
        model: 'gpt-5.2-codex',
        modelReasoningEffort: 'medium',
        webSearchMode: 'live',
        additionalDirectories: ['/other/repo'],
      })) {
        // consume
      }

      expect(mockStartThread).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gpt-5.2-codex',
          modelReasoningEffort: 'medium',
          webSearchMode: 'live',
          additionalDirectories: ['/other/repo'],
        })
      );
    });

    test('passes outputFormat schema as outputSchema in TurnOptions', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const schema = {
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
      };

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace', undefined, {
        outputFormat: { type: 'json_schema', schema },
      })) {
        chunks.push(chunk);
      }

      expect(mockRunStreamed).toHaveBeenCalledWith(
        'test prompt',
        expect.objectContaining({ outputSchema: schema })
      );
    });

    test('passes abortSignal as signal in TurnOptions', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const controller = new AbortController();

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace', undefined, {
        abortSignal: controller.signal,
      })) {
        chunks.push(chunk);
      }

      expect(mockRunStreamed).toHaveBeenCalledWith(
        'test prompt',
        expect.objectContaining({ signal: controller.signal })
      );
    });

    test('passes empty TurnOptions when no outputFormat or abortSignal', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test prompt', '/workspace')) {
        chunks.push(chunk);
      }

      expect(mockRunStreamed).toHaveBeenCalledWith('test prompt', {});
    });

    test('breaks on turn.completed event', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'item.completed', item: { type: 'agent_message', text: 'Before turn' } };
          yield { type: 'turn.completed', usage: defaultUsage };
          // This should NOT be yielded due to break
          yield { type: 'item.completed', item: { type: 'agent_message', text: 'After turn' } };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      // Only first message and result should be yielded
      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toEqual({ type: 'assistant', content: 'Before turn' });
      expect(chunks[1]).toMatchObject({ type: 'result', sessionId: 'new-thread-id' });
    });

    test('logs progress for item.started and item.completed events', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'item.started', item: { id: 'item-1', type: 'command_execution' } };
          yield {
            type: 'item.completed',
            item: { id: 'item-1', type: 'command_execution', command: 'npm test' },
          };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      // Verify item.started logging with correct format
      expect(mockLogger.debug).toHaveBeenCalledWith(
        { eventType: 'item.started', itemType: 'command_execution', itemId: 'item-1' },
        'item_started'
      );

      // Verify item.completed logging includes command context
      expect(mockLogger.debug).toHaveBeenCalledWith(
        {
          eventType: 'item.completed',
          itemType: 'command_execution',
          itemId: 'item-1',
          command: 'npm test',
        },
        'item_completed'
      );
    });

    test('handles error events', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'error', message: 'Something went wrong' };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({ type: 'system', content: '⚠️ Something went wrong' });
      expect(mockLogger.error).toHaveBeenCalledWith(
        { message: 'Something went wrong' },
        'stream_error'
      );
    });

    test('suppresses MCP timeout errors', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'error', message: 'MCP client connection timeout' };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      // Should only have the result, not the MCP error
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({
        type: 'result',
        sessionId: 'new-thread-id',
        tokens: { input: 10, output: 5 },
      });

      // Error is still logged even though not sent to user
      expect(mockLogger.error).toHaveBeenCalledWith(
        { message: 'MCP client connection timeout' },
        'stream_error'
      );
    });

    test('handles turn.failed events', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.failed', error: { message: 'Rate limit exceeded' } };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({ type: 'system', content: '❌ Turn failed: Rate limit exceeded' });
      expect(mockLogger.error).toHaveBeenCalledWith(
        { errorMessage: 'Rate limit exceeded' },
        'turn_failed'
      );
    });

    test('handles turn.failed without error message', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.failed', error: null };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({ type: 'system', content: '❌ Turn failed: Unknown error' });
      expect(mockLogger.error).toHaveBeenCalledWith(
        { errorMessage: 'Unknown error' },
        'turn_failed'
      );
    });

    test('throws on runStreamed error', async () => {
      const networkError = new Error('Network failure');
      mockRunStreamed.mockRejectedValue(networkError);

      const consumeGenerator = async () => {
        for await (const _ of client.sendQuery('test', '/workspace')) {
          // consume
        }
      };

      await expect(consumeGenerator()).rejects.toThrow('Codex unknown: Network failure');

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: networkError }),
        'query_error'
      );
    });

    test('throws actionable model-access message for unavailable configured model', async () => {
      mockRunStreamed.mockRejectedValue(new Error('403 Forbidden: model not available'));

      const consumeGenerator = async () => {
        for await (const _ of client.sendQuery('test', '/workspace', undefined, {
          model: 'gpt-5.3-codex',
        })) {
          // consume
        }
      };

      await expect(consumeGenerator()).rejects.toThrow(
        'Model "gpt-5.3-codex" is not available for your account'
      );
      await expect(consumeGenerator()).rejects.toThrow('model: gpt-5.2-codex');
    });

    test('uses generic dashboard guidance when fallback mapping is unknown', async () => {
      mockRunStreamed.mockRejectedValue(new Error('model not available'));

      const consumeGenerator = async () => {
        for await (const _ of client.sendQuery('test', '/workspace', undefined, {
          model: 'o5-pro',
        })) {
          // consume
        }
      };

      await expect(consumeGenerator()).rejects.toThrow(
        'Model "o5-pro" is not available for your account'
      );
      await expect(consumeGenerator()).rejects.toThrow(
        'update your model in ~/.archon/config.yaml'
      );
    });

    test('ignores items without text or command', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'item.completed', item: { type: 'agent_message', text: '' } };
          yield { type: 'item.completed', item: { type: 'agent_message' } }; // no text
          yield { type: 'item.completed', item: { type: 'command_execution' } }; // no command
          yield { type: 'item.completed', item: { type: 'reasoning' } }; // no text
          yield { type: 'item.completed', item: { type: 'file_edit' } }; // ignored type
          yield { type: 'item.completed', item: { type: 'web_search' } }; // no query
          yield { type: 'item.completed', item: { type: 'todo_list', items: [] } }; // empty items
          yield { type: 'item.completed', item: { type: 'todo_list' } }; // no items
          yield {
            type: 'item.completed',
            item: { type: 'file_change', status: 'completed', changes: [] },
          }; // empty changes
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      // Only the result should be yielded
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({
        type: 'result',
        sessionId: 'new-thread-id',
        tokens: { input: 10, output: 5 },
      });
    });

    describe('retry behavior', () => {
      test('classifies exit code errors as crash and retries up to 3 times', async () => {
        mockRunStreamed.mockRejectedValue(
          new Error('Codex Exec exited with code 1: stderr output')
        );

        const consumeGenerator = async (): Promise<void> => {
          for await (const _ of client.sendQuery('test', '/workspace')) {
            // consume
          }
        };

        await expect(consumeGenerator()).rejects.toThrow(/Codex crash/);
        // Initial attempt + 3 retries = 4 runStreamed calls
        expect(mockRunStreamed).toHaveBeenCalledTimes(4);
      }, 5_000);

      test('recovers from transient crash on retry', async () => {
        let callCount = 0;
        mockRunStreamed.mockImplementation(() => {
          callCount++;
          if (callCount <= 2) {
            return Promise.reject(new Error('Codex Exec exited with code 1'));
          }
          return Promise.resolve({
            events: (async function* () {
              yield {
                type: 'item.completed',
                item: { type: 'agent_message', text: 'Recovered!' },
              };
              yield { type: 'turn.completed', usage: defaultUsage };
            })(),
          });
        });

        const chunks = [];
        for await (const chunk of client.sendQuery('test', '/workspace')) {
          chunks.push(chunk);
        }

        expect(callCount).toBe(3);
        expect(chunks.some(c => c.type === 'assistant' && c.content === 'Recovered!')).toBe(true);
      }, 5_000);

      test('classifies auth errors as fatal (no retry)', async () => {
        mockRunStreamed.mockRejectedValue(new Error('unauthorized'));

        const consumeGenerator = async (): Promise<void> => {
          for await (const _ of client.sendQuery('test', '/workspace')) {
            // consume
          }
        };

        await expect(consumeGenerator()).rejects.toThrow(/Codex auth error/);
        expect(mockRunStreamed).toHaveBeenCalledTimes(1);
      });

      test('does not retry unknown errors', async () => {
        mockRunStreamed.mockRejectedValue(new Error('something unexpected and unclassified'));

        const consumeGenerator = async (): Promise<void> => {
          for await (const _ of client.sendQuery('test', '/workspace')) {
            // consume
          }
        };

        await expect(consumeGenerator()).rejects.toThrow(/Codex unknown/);
        expect(mockRunStreamed).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('dispatch logic', () => {
    const originalEnv = process.env.OPENAI_API_KEY;

    beforeEach(() => {
      process.env.OPENAI_API_KEY = 'test-key';
      mockExecuteToolLoop.mockClear();
      MockMcpToolProvider.mockClear();
      mockMcpConnect.mockClear();
      mockMcpShutdown.mockClear();
      mockMcpGetToolDefinitions.mockClear();
      mockLoadSkills.mockClear();
      MockContextWindowManager.mockClear();
      mockShouldSummarize.mockClear();
      mockShouldSummarize.mockReturnValue(false);

      // Reset tool loop mock
      mockExecuteToolLoop.mockImplementation(async function* () {
        yield { type: 'assistant' as const, content: 'Tool loop response' };
        yield {
          type: 'result' as const,
          sessionId: undefined,
          tokens: { input: 5, output: 3 },
        };
      });
    });

    afterEach(() => {
      if (originalEnv !== undefined) {
        process.env.OPENAI_API_KEY = originalEnv;
      } else {
        delete process.env.OPENAI_API_KEY;
      }
    });

    test('uses SDK path when no unsupported features are requested', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace', undefined, {
        model: 'gpt-5.2-codex',
        outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      })) {
        chunks.push(chunk);
      }

      // Should use SDK path (mockRunStreamed called, not executeToolLoop)
      expect(mockRunStreamed).toHaveBeenCalled();
      expect(mockExecuteToolLoop).not.toHaveBeenCalled();
    });

    test('uses tool-loop path when allowed_tools is set', async () => {
      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace', undefined, {
        tools: ['Read', 'Write'],
      })) {
        chunks.push(chunk);
      }

      expect(mockRunStreamed).not.toHaveBeenCalled();
      expect(mockExecuteToolLoop).toHaveBeenCalled();
      // Should emit system message tagging the path
      expect(chunks[0]).toEqual({
        type: 'system',
        content: expect.stringContaining('codex:tool-loop'),
      });
    });

    test('uses tool-loop path when hooks are set', async () => {
      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace', undefined, {
        hooks: { PreToolUse: [{ hooks: [async () => undefined] }] },
      })) {
        chunks.push(chunk);
      }

      expect(mockRunStreamed).not.toHaveBeenCalled();
      expect(mockExecuteToolLoop).toHaveBeenCalled();
    });

    test('uses tool-loop path when systemPrompt is set', async () => {
      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace', undefined, {
        systemPrompt: 'You are a helpful assistant',
      })) {
        chunks.push(chunk);
      }

      expect(mockRunStreamed).not.toHaveBeenCalled();
      expect(mockExecuteToolLoop).toHaveBeenCalled();
    });

    test('uses tool-loop path when denied_tools is set', async () => {
      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace', undefined, {
        disallowedTools: ['Bash'],
      })) {
        chunks.push(chunk);
      }

      expect(mockRunStreamed).not.toHaveBeenCalled();
      expect(mockExecuteToolLoop).toHaveBeenCalled();
    });

    test('uses tool-loop path when skills are set', async () => {
      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace', undefined, {
        skills: ['my-skill'],
      })) {
        chunks.push(chunk);
      }

      expect(mockRunStreamed).not.toHaveBeenCalled();
      expect(mockExecuteToolLoop).toHaveBeenCalled();
      expect(mockLoadSkills).toHaveBeenCalledWith(['my-skill'], '/workspace');
    });

    test('uses tool-loop path when mcpConfigs are set', async () => {
      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace', undefined, {
        mcpConfigs: {
          myServer: { command: 'node', args: ['server.js'] },
        },
      })) {
        chunks.push(chunk);
      }

      expect(mockRunStreamed).not.toHaveBeenCalled();
      expect(mockExecuteToolLoop).toHaveBeenCalled();
      expect(mockMcpConnect).toHaveBeenCalled();
      expect(mockMcpShutdown).toHaveBeenCalled();
    });

    test('system message lists unsupported features used', async () => {
      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace', undefined, {
        systemPrompt: 'Custom prompt',
        tools: ['Read'],
        hooks: { PreToolUse: [{ hooks: [async () => undefined] }] },
      })) {
        chunks.push(chunk);
      }

      const systemMsg = chunks.find(
        c => c.type === 'system' && 'content' in c && c.content.includes('codex:tool-loop')
      );
      expect(systemMsg).toBeDefined();
      if (systemMsg && 'content' in systemMsg) {
        expect(systemMsg.content).toContain('allowed_tools');
        expect(systemMsg.content).toContain('hooks');
        expect(systemMsg.content).toContain('systemPrompt');
      }
    });

    test('throws when OPENAI_API_KEY is missing for tool-loop path', async () => {
      delete process.env.OPENAI_API_KEY;

      const consumeGenerator = async (): Promise<void> => {
        for await (const _ of client.sendQuery('test', '/workspace', undefined, {
          systemPrompt: 'Custom prompt',
        })) {
          // consume
        }
      };

      await expect(consumeGenerator()).rejects.toThrow('OPENAI_API_KEY');
    });

    test('getType still returns codex regardless of dispatch path', () => {
      expect(client.getType()).toBe('codex');
    });

    test('existing workflows without unsupported features run on SDK path', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: { type: 'agent_message', text: 'Hello!' },
          };
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });

      const chunks = [];
      for await (const chunk of client.sendQuery('test', '/workspace')) {
        chunks.push(chunk);
      }

      // SDK path used — no tool-loop system message
      expect(mockRunStreamed).toHaveBeenCalled();
      expect(mockExecuteToolLoop).not.toHaveBeenCalled();
      expect(chunks[0]).toEqual({ type: 'assistant', content: 'Hello!' });
    });
  });
});
