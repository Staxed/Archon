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

const mockLoadSkills = mock(() =>
  Promise.resolve({ systemPromptAdditions: [] as string[], toolAllowlist: [] as string[] })
);

mock.module('./skill-loader', () => ({
  loadSkills: mockLoadSkills,
}));

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexClient, findRolloutModel } from './codex';

// Keep the rollout lookup off the real ~/.codex for every test in this file.
const codexHome = mkdtempSync(join(tmpdir(), 'codex-home-'));
process.env.CODEX_HOME = codexHome;

function writeRollout(day: string, threadId: string, lines: unknown[]): void {
  const dir = join(codexHome, 'sessions', ...day.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `rollout-2026-09-25T12-00-00-${threadId}.jsonl`),
    lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n'
  );
}

describe('codex usage for subscription runs', () => {
  afterEach(() => {
    rmSync(join(codexHome, 'sessions'), { recursive: true, force: true });
  });

  test('findRolloutModel returns the last turn_context model', () => {
    writeRollout('2026/09/25', 'thread-a', [
      { type: 'session_meta', payload: { id: 'thread-a' } },
      { type: 'turn_context', payload: { model: 'gpt-5.4' } },
      { type: 'turn_context', payload: { model: 'gpt-5.5' } },
      '{"type":"turn_context","payload":{"mod',
    ]);
    expect(findRolloutModel('thread-a')).toBe('gpt-5.5');
  });

  test('findRolloutModel searches only the two newest day folders', () => {
    writeRollout('2026/09/20', 'old-thread', [{ type: 'turn_context', payload: { model: 'm' } }]);
    writeRollout('2026/09/24', 'x', []);
    writeRollout('2026/10/01', 'y', []);
    expect(findRolloutModel('old-thread')).toBeUndefined();
  });

  test('findRolloutModel is undefined when there is no sessions folder', () => {
    expect(findRolloutModel('nope')).toBeUndefined();
  });

  test('result splits cached input out and carries the rollout model', async () => {
    writeRollout('2026/09/25', 'new-thread-id', [
      { type: 'turn_context', payload: { model: 'gpt-5.4' } },
    ]);
    mockStartThread.mockReturnValue(createMockThread('new-thread-id'));
    mockRunStreamed.mockResolvedValue({
      events: (async function* () {
        yield {
          type: 'turn.completed',
          usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50 },
        };
      })(),
    });

    const chunks = [];
    for await (const chunk of new CodexClient({ retryBaseDelayMs: 1 }).sendQuery('p', '/w')) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([
      {
        type: 'result',
        sessionId: 'new-thread-id',
        tokens: { input: 200, output: 50, total: 1050, model: 'gpt-5.4' },
      },
    ]);
  });
});

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
        tokens: { input: 10, output: 5, total: 15 },
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
        tokens: { input: 10, output: 5, total: 15 },
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
        tokens: { input: 10, output: 5, total: 15 },
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
        tokens: { input: 10, output: 5, total: 15 },
      });

      // Error is still logged even though not sent to user
      expect(mockLogger.error).toHaveBeenCalledWith(
        { message: 'MCP client connection timeout' },
        'stream_error'
      );
    });

    test('handles turn.failed events', async () => {
      // a fresh stream per attempt, as the SDK gives each retry
      mockRunStreamed.mockImplementation(() =>
        Promise.resolve({
          events: (async function* () {
            yield { type: 'turn.failed', error: { message: 'Rate limit exceeded' } };
          })(),
        })
      );

      const chunks: unknown[] = [];
      const consume = async () => {
        for await (const chunk of client.sendQuery('test', '/workspace')) {
          chunks.push(chunk);
        }
      };

      // A failed turn fails the query (retried as a rate limit, then thrown)
      await expect(consume()).rejects.toThrow('Codex rate_limit: Rate limit exceeded');
      expect(chunks[0]).toEqual({ type: 'system', content: '❌ Turn failed: Rate limit exceeded' });
      expect(mockRunStreamed).toHaveBeenCalledTimes(4);
      expect(mockLogger.error).toHaveBeenCalledWith(
        { errorMessage: 'Rate limit exceeded' },
        'turn_failed'
      );
    });

    test('turn.failed with a 401 (no ChatGPT login) fails at once as an auth error', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield {
            type: 'turn.failed',
            error: { message: 'unexpected status 401 Unauthorized: Missing bearer' },
          };
        })(),
      });

      const consume = async () => {
        for await (const _ of client.sendQuery('test', '/workspace')) {
          // consume
        }
      };

      await expect(consume()).rejects.toThrow('Codex auth error: unexpected status 401');
      expect(mockRunStreamed).toHaveBeenCalledTimes(1);
    });

    test('handles turn.failed without error message', async () => {
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.failed', error: null };
        })(),
      });

      const chunks: unknown[] = [];
      const consume = async () => {
        for await (const chunk of client.sendQuery('test', '/workspace')) {
          chunks.push(chunk);
        }
      };

      await expect(consume()).rejects.toThrow('Codex unknown: Unknown error');
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
        tokens: { input: 10, output: 5, total: 15 },
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

  describe('native option mapping (subscription only, no API tool loop)', () => {
    /** CodexOptions of the most recent `new Codex(...)`. */
    const lastCodexOptions = (): {
      config?: Record<string, unknown>;
      configOverrides?: string[];
      env?: Record<string, string>;
    } => {
      const calls = MockCodex.mock.calls as unknown as unknown[][];
      return (calls[calls.length - 1]?.[0] ?? {}) as ReturnType<typeof lastCodexOptions>;
    };
    const lastThreadOptions = (): Record<string, unknown> => {
      const calls = mockStartThread.mock.calls as unknown as unknown[][];
      return (calls[calls.length - 1]?.[0] ?? {}) as Record<string, unknown>;
    };
    const drain = async (
      options: Parameters<CodexClient['sendQuery']>[3],
      cwd = '/workspace'
    ): Promise<unknown[]> => {
      const chunks: unknown[] = [];
      for await (const c of client.sendQuery('test', cwd, undefined, options)) chunks.push(c);
      return chunks;
    };

    beforeEach(() => {
      MockCodex.mockClear();
      mockLoadSkills.mockClear();
      mockRunStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: 'turn.completed', usage: defaultUsage };
        })(),
      });
    });

    afterEach(() => {
      rmSync(join(codexHome, 'sessions'), { recursive: true, force: true });
    });

    test('installs the dispatcher in $CODEX_HOME/hooks.json and trusts it for the run', async () => {
      writeFileSync(
        join(codexHome, 'hooks.json'),
        JSON.stringify({
          hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'user-hook' }] }] },
        })
      );
      await drain({});
      const doc = JSON.parse(readFileSync(join(codexHome, 'hooks.json'), 'utf8')) as {
        hooks: Record<string, { hooks: { command: string }[] }[]>;
      };
      expect(doc.hooks.SessionEnd[0].hooks[0].command).toBe('user-hook');
      expect(doc.hooks.SessionEnd[1].hooks[0].command).toContain('ARCHON_HOOK_EVENTS');
      expect(doc.hooks.PreToolUse[0].hooks[0].command).toContain('hook-dispatcher.ts');
      const override = lastCodexOptions().configOverrides?.[0] ?? '';
      expect(override).toContain('hooks.state={');
      expect(override).toContain(`${join(codexHome, 'hooks.json')}:pre_tool_use:0:0`);
      expect(override).toContain(`${join(codexHome, 'hooks.json')}:session_end:1:0`);
    });

    test('hands the dispatcher a spec with the path guard, tool lists and node hooks', async () => {
      let spec: Record<string, unknown> | undefined;
      let events: string | undefined;
      mockRunStreamed.mockImplementation(() => {
        const env = lastCodexOptions().env ?? {};
        spec = JSON.parse(readFileSync(env.ARCHON_HOOK_SPEC, 'utf8')) as Record<string, unknown>;
        events = env.ARCHON_HOOK_EVENTS;
        return Promise.resolve({
          events: (async function* () {
            yield { type: 'turn.completed', usage: defaultUsage };
          })(),
        });
      });
      const hookSpecs = {
        PostToolUse: [{ matcher: 'Bash', response: { systemMessage: 'ran bash' } }],
      };
      await drain({ tools: ['Read', 'Bash'], disallowedTools: ['WebFetch'], hookSpecs });
      expect(spec).toEqual({
        version: 1,
        provider: 'codex',
        cwd: '/workspace',
        pathGuard: true,
        allowedTools: ['Read', 'Bash'],
        deniedTools: ['WebFetch'],
        hooks: hookSpecs,
      });
      expect(events).toBe('PreToolUse,PostToolUse');
      // the spec file is removed after the run
      expect(existsSync(lastCodexOptions().env?.ARCHON_HOOK_SPEC ?? '/nope')).toBe(false);
    });

    test('never passes an OpenAI API key to the CLI', async () => {
      const saved = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = 'sk-test';
      try {
        await drain({ env: { CODEX_API_KEY: 'x', PROJECT_VAR: 'kept' } });
      } finally {
        if (saved === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = saved;
      }
      const env = lastCodexOptions().env ?? {};
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.CODEX_API_KEY).toBeUndefined();
      expect(env.PROJECT_VAR).toBe('kept');
    });

    test('systemPrompt replaces the base instructions via model_instructions_file', async () => {
      let content: string | undefined;
      mockRunStreamed.mockImplementation(() => {
        content = readFileSync(
          lastCodexOptions().config?.model_instructions_file as string,
          'utf8'
        );
        return Promise.resolve({
          events: (async function* () {
            yield { type: 'turn.completed', usage: defaultUsage };
          })(),
        });
      });
      await drain({ systemPrompt: 'You are PIRATEBOT.' });
      expect(content).toBe('You are PIRATEBOT.');
      const file = lastCodexOptions().config?.model_instructions_file as string;
      expect(existsSync(file)).toBe(false);
    });

    test('skills are preloaded into developer_instructions', async () => {
      mockLoadSkills.mockResolvedValueOnce({
        systemPromptAdditions: ['# Deploy skill\nAlways run the smoke test.'],
        toolAllowlist: [],
      });
      await drain({ skills: ['deploy'] });
      expect(mockLoadSkills).toHaveBeenCalledWith(['deploy'], '/workspace');
      const di = lastCodexOptions().config?.developer_instructions as string;
      expect(di).toContain('(deploy)');
      expect(di).toContain('Always run the smoke test.');
    });

    test('MCP servers map to mcp_servers config (stdio env, http headers)', async () => {
      await drain({
        mcpConfigs: {
          local: { command: 'bun', args: ['srv.ts'], env: { TOKEN: 't' } },
          remote: { type: 'http', url: 'https://mcp.example/mcp', headers: { A: 'b' } },
        },
      });
      expect(lastCodexOptions().config?.mcp_servers).toEqual({
        local: { command: 'bun', args: ['srv.ts'], env: { TOKEN: 't' } },
        remote: { url: 'https://mcp.example/mcp', http_headers: { A: 'b' } },
      });
    });

    test('refuses SSE MCP servers and dotted server names', async () => {
      await expect(
        drain({ mcpConfigs: { s: { type: 'sse', url: 'https://x/sse' } } })
      ).rejects.toThrow('SSE');
      await expect(drain({ mcpConfigs: { 'a.b': { command: 'x' } } })).rejects.toThrow(
        'letters, digits'
      );
    });

    test('effort maps to model_reasoning_effort; thinking disabled -> low with a note', async () => {
      await drain({ effort: 'high', modelReasoningEffort: 'medium' });
      expect(lastThreadOptions().modelReasoningEffort).toBe('high');
      const chunks = await drain({ thinking: { type: 'disabled' } });
      expect(lastThreadOptions().modelReasoningEffort).toBe('low');
      expect(chunks[0]).toEqual({
        type: 'system',
        content: expect.stringContaining('cannot turn reasoning off'),
      });
    });

    test('web search is switched off when the node does not allow WebSearch', async () => {
      await drain({ tools: ['Read'], webSearchMode: 'live' });
      expect(lastThreadOptions().webSearchMode).toBe('disabled');
      await drain({ disallowedTools: ['WebSearch'], webSearchMode: 'live' });
      expect(lastThreadOptions().webSearchMode).toBe('disabled');
      await drain({ webSearchMode: 'live' });
      expect(lastThreadOptions().webSearchMode).toBe('live');
    });

    test('sandbox maps to workspace-write with writable roots and no network', async () => {
      await drain({ sandbox: { enabled: true, filesystem: { allowWrite: ['out', '/tmp/x'] } } });
      expect(lastThreadOptions().sandboxMode).toBe('workspace-write');
      expect(lastThreadOptions().networkAccessEnabled).toBe(false);
      expect(lastCodexOptions().config?.sandbox_workspace_write).toEqual({
        writable_roots: ['/workspace/out', '/tmp/x'],
      });
      await drain({ sandbox: { enabled: true, network: { allowedDomains: ['*'] } } });
      expect(lastThreadOptions().networkAccessEnabled).toBe(true);
    });

    test('refuses sandbox settings Codex cannot enforce', async () => {
      await expect(
        drain({ sandbox: { enabled: true, network: { allowedDomains: ['github.com'] } } })
      ).rejects.toThrow('specific domains');
      await expect(
        drain({ sandbox: { enabled: true, filesystem: { denyRead: ['~/.ssh'] } } })
      ).rejects.toThrow('denyRead');
    });

    test('refuses betas, in-process hooks and hook events Codex never fires', async () => {
      await expect(drain({ betas: ['context-1m-2025-08-07'] })).rejects.toThrow('betas');
      await expect(
        drain({ hooks: { PreToolUse: [{ hooks: [async (): Promise<undefined> => undefined] }] } })
      ).rejects.toThrow('in-process hooks');
      await expect(drain({ hookSpecs: { Setup: [{ response: {} }] } })).rejects.toThrow(
        'hook events Codex never fires: Setup'
      );
      expect(mockRunStreamed).not.toHaveBeenCalled();
    });

    test('maxBudgetUsd stops the turn once the rollout spend passes the cap', async () => {
      const rolloutDir = join(codexHome, 'sessions', '2026', '09', '25');
      const rollout = join(rolloutDir, 'rollout-2026-09-25T12-00-00-new-thread-id.jsonl');
      mkdirSync(rolloutDir, { recursive: true });
      // an earlier turn of the thread: must not count
      writeFileSync(
        rollout,
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: { input_tokens: 9e6, cached_input_tokens: 0, output_tokens: 0 },
            },
          },
        }) + '\n'
      );
      mockRunStreamed.mockImplementation((_p: unknown, turnOptions?: { signal?: AbortSignal }) => {
        return Promise.resolve({
          events: (async function* () {
            appendFileSync(
              rollout,
              [
                { type: 'turn_context', payload: { model: 'gpt-6-astra' } },
                {
                  type: 'event_msg',
                  payload: {
                    type: 'token_count',
                    info: {
                      last_token_usage: {
                        input_tokens: 12000,
                        cached_input_tokens: 2000,
                        output_tokens: 1000,
                      },
                    },
                  },
                },
              ]
                .map(l => JSON.stringify(l))
                .join('\n') + '\n'
            );
            yield { type: 'item.completed', item: { type: 'agent_message', text: 'working' } };
            if (turnOptions?.signal?.aborted) throw new Error('aborted');
            yield { type: 'turn.completed', usage: defaultUsage };
          })(),
        });
      });
      const chunks = (await drain({ model: 'gpt-6-astra', maxBudgetUsd: 0.1 })) as {
        type: string;
        isError?: boolean;
        errorSubtype?: string;
        cost?: number;
        tokens?: unknown;
      }[];
      const result = chunks.find(c => c.type === 'result');
      // 10k uncached * $10/M + 2k cached * $1/M + 1k out * $50/M = $0.152
      expect(result?.isError).toBe(true);
      expect(result?.errorSubtype).toBe('error_max_budget_usd');
      expect(result?.cost).toBeCloseTo(0.152, 6);
      expect(result?.tokens).toEqual({
        input: 10000,
        output: 1000,
        total: 13000,
        model: 'gpt-6-astra',
      });
    });

    test('maxBudgetUsd with a model Archon has no price for is refused up front', async () => {
      await expect(drain({ model: 'gpt-unknown', maxBudgetUsd: 1 })).rejects.toThrow(
        'ARCHON_MODEL_RATES'
      );
      expect(mockRunStreamed).not.toHaveBeenCalled();
    });

    test('fallbackModel retries on a model-access error', async () => {
      // the real text a ChatGPT login gets (archon sandbox, 2026-09-25)
      mockRunStreamed
        .mockRejectedValueOnce(
          new Error("The 'gpt-x' model is not supported when using Codex with a ChatGPT account.")
        )
        .mockResolvedValueOnce({
          events: (async function* () {
            yield { type: 'turn.completed', usage: defaultUsage };
          })(),
        });
      const chunks = await drain({ model: 'gpt-x', fallbackModel: 'gpt-6-astra' });
      expect(chunks[0]).toEqual({
        type: 'system',
        content: expect.stringContaining('retrying with fallback model "gpt-6-astra"'),
      });
      expect(lastThreadOptions().model).toBe('gpt-6-astra');
      expect(chunks[chunks.length - 1]).toMatchObject({ type: 'result' });
    });

    test('an unsupported parameter is not a model error: no fallback', async () => {
      mockRunStreamed.mockRejectedValueOnce(
        new Error("Unsupported value: 'none' is not supported with the 'gpt-6-astra' model.")
      );
      await expect(drain({ model: 'gpt-6-astra', fallbackModel: 'gpt-y' })).rejects.toThrow(
        'Codex unknown'
      );
      expect(lastThreadOptions().model).toBe('gpt-6-astra');
    });

    test('maxBudgetUsd with no model named waits for the rollout to name it', async () => {
      const rolloutDir = join(codexHome, 'sessions', '2026', '09', '25');
      const rollout = join(rolloutDir, 'rollout-2026-09-25T12-00-00-new-thread-id.jsonl');
      mkdirSync(rolloutDir, { recursive: true });
      writeFileSync(rollout, '');
      mockRunStreamed.mockImplementation(() =>
        Promise.resolve({
          events: (async function* () {
            // an event before any model call: nothing to price yet, must not throw
            yield { type: 'item.started', item: { id: 'i0', type: 'reasoning' } };
            appendFileSync(
              rollout,
              JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6-astra' } }) +
                '\n' +
                JSON.stringify({
                  type: 'event_msg',
                  payload: {
                    type: 'token_count',
                    info: {
                      last_token_usage: {
                        input_tokens: 100,
                        cached_input_tokens: 0,
                        output_tokens: 10,
                      },
                    },
                  },
                }) +
                '\n'
            );
            yield { type: 'item.completed', item: { type: 'agent_message', text: 'ok' } };
            yield { type: 'turn.completed', usage: defaultUsage };
          })(),
        })
      );
      const chunks = await drain({ maxBudgetUsd: 1 });
      expect(chunks[chunks.length - 1]).toMatchObject({ type: 'result' });
      expect((chunks[chunks.length - 1] as { isError?: boolean }).isError).toBeUndefined();
    });
  });
});
