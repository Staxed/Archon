import { mock, describe, test, expect, beforeEach } from 'bun:test';

// Track appendFile calls
const appendFileCalls: Array<{ path: string; content: string }> = [];
const mockAppendFile = mock(async (path: string, content: string) => {
  appendFileCalls.push({ path, content });
  return undefined;
});

const mockMkdir = mock(async () => undefined);

mock.module('node:fs/promises', () => ({
  appendFile: mockAppendFile,
  mkdir: mockMkdir,
  writeFile: mock(async () => undefined),
}));

// Mock @archon/paths
const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
};
mock.module('@archon/paths', () => ({
  getProjectKnowledgePath: (owner: string, repo: string) =>
    `/home/test/.archon/workspaces/${owner}/${repo}/knowledge`,
  getGlobalKnowledgePath: () => '/home/test/.archon/knowledge',
  parseOwnerRepo: (name: string) => {
    const parts = name.split('/');
    if (parts.length !== 2) return null;
    const [owner, repo] = parts;
    if (!owner || !repo) return null;
    return { owner, repo };
  },
  createLogger: mock(() => mockLogger),
}));

// Mock messages DB
const mockListMessages = mock(
  async () =>
    [] as Array<{
      id: string;
      conversation_id: string;
      role: 'user' | 'assistant';
      content: string;
      metadata: string;
      created_at: string;
    }>
);
mock.module('../db/messages', () => ({
  listMessages: mockListMessages,
}));

// Mock codebases DB
const mockGetCodebase = mock(
  async (_id: string) => null as { id: string; name: string; default_cwd: string } | null
);
mock.module('../db/codebases', () => ({
  getCodebase: mockGetCodebase,
}));

// Mock config loader
const defaultKnowledgeConfig = {
  enabled: true,
  captureModel: 'haiku',
  compileModel: 'sonnet',
  flushDebounceMinutes: 10,
  domains: ['architecture', 'decisions', 'patterns', 'lessons', 'connections'],
};
const mockLoadConfig = mock(async () => ({
  knowledge: { ...defaultKnowledgeConfig },
  assistants: { claude: { model: 'sonnet', settingSources: ['project'] }, codex: {} },
  worktree: {},
  docs: { path: 'docs/' },
  defaults: { loadDefaultCommands: true, loadDefaultWorkflows: true },
}));
mock.module('../config/config-loader', () => ({
  loadConfig: mockLoadConfig,
}));

// Mock knowledge-init
const mockInitKnowledgeDir = mock(async () => undefined);
mock.module('./knowledge-init', () => ({
  initKnowledgeDir: mockInitKnowledgeDir,
}));

// Mock knowledge-scheduler
const mockScheduleFlush = mock(async () => undefined);
mock.module('./knowledge-scheduler', () => ({
  scheduleFlush: mockScheduleFlush,
}));

// Mock AI client
let mockSendQueryChunks: Array<{ type: string; content?: string }> = [];
const mockSendQuery = mock(function* () {
  for (const chunk of mockSendQueryChunks) {
    yield chunk;
  }
});
const mockGetAssistantClient = mock(() => ({
  sendQuery: mockSendQuery,
  getType: () => 'claude',
}));
mock.module('../clients/factory', () => ({
  getAssistantClient: mockGetAssistantClient,
}));

import { triggerCapture } from './knowledge-capture';

/**
 * Helper to flush microtasks + fire-and-forget promises.
 * triggerCapture uses `void (async () => { ... })().catch(...)` which
 * schedules work on the microtask queue. We need to await that work.
 */
async function flushFireAndForget(): Promise<void> {
  // Multiple rounds to handle chained awaits inside the async IIFE
  for (let i = 0; i < 10; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

describe('triggerCapture fire-and-forget wiring', () => {
  beforeEach(() => {
    appendFileCalls.length = 0;
    mockAppendFile.mockClear();
    mockMkdir.mockClear();
    mockListMessages.mockClear();
    mockGetCodebase.mockClear();
    mockLoadConfig.mockClear();
    mockInitKnowledgeDir.mockClear();
    mockScheduleFlush.mockClear();
    mockSendQuery.mockClear();
    mockGetAssistantClient.mockClear();
    Object.values(mockLogger).forEach(fn => fn.mockClear());

    // Reset default mock implementations
    mockGetCodebase.mockImplementation(async () => null);
    mockListMessages.mockImplementation(async () => []);
    mockSendQueryChunks = [];
    mockSendQuery.mockImplementation(function* () {
      for (const chunk of mockSendQueryChunks) {
        yield chunk;
      }
    });
  });

  test('returns immediately without awaiting (fire-and-forget)', () => {
    // triggerCapture returns void (not a promise) — this is the fire-and-forget contract
    const result = triggerCapture('conv-123', 'cb-456');
    expect(result).toBeUndefined();
  });

  test('skips when codebaseId is null', async () => {
    triggerCapture('conv-123', null);
    await flushFireAndForget();

    expect(mockGetCodebase).not.toHaveBeenCalled();
  });

  test('skips when codebase is not found', async () => {
    mockGetCodebase.mockResolvedValueOnce(null);

    triggerCapture('conv-123', 'cb-missing');
    await flushFireAndForget();

    expect(mockGetCodebase).toHaveBeenCalledWith('cb-missing');
    expect(mockListMessages).not.toHaveBeenCalled();
    expect(mockLogger.debug).toHaveBeenCalled();
  });

  test('skips when codebase name cannot be parsed as owner/repo', async () => {
    mockGetCodebase.mockResolvedValueOnce({
      id: 'cb-1',
      name: 'bare-name', // no slash, so parseOwnerRepo returns null
      default_cwd: '/tmp',
    });

    triggerCapture('conv-123', 'cb-1');
    await flushFireAndForget();

    expect(mockGetCodebase).toHaveBeenCalledWith('cb-1');
    expect(mockListMessages).not.toHaveBeenCalled();
    expect(mockLogger.debug).toHaveBeenCalled();
  });

  test('calls captureKnowledge with resolved owner/repo', async () => {
    mockGetCodebase.mockResolvedValueOnce({
      id: 'cb-1',
      name: 'acme/widget',
      default_cwd: '/tmp/acme/widget',
    });

    // Set up messages and AI response for captureKnowledge to succeed
    mockListMessages.mockResolvedValueOnce([
      {
        id: 'msg-1',
        conversation_id: 'conv-123',
        role: 'user' as const,
        content: 'How to do auth?',
        metadata: '{}',
        created_at: '2026-04-11T10:00:00Z',
      },
    ]);

    mockSendQueryChunks = [{ type: 'assistant', content: '## Decisions\n- Use JWT\n' }];

    triggerCapture('conv-123', 'cb-1');
    await flushFireAndForget();

    // captureKnowledge should have been called (it reads messages)
    expect(mockListMessages).toHaveBeenCalledWith('conv-123');
    // AI client was called for extraction
    expect(mockGetAssistantClient).toHaveBeenCalledWith('claude');
    // Knowledge dir was initialized
    expect(mockInitKnowledgeDir).toHaveBeenCalledWith('acme', 'widget');
    // Daily log was appended
    expect(appendFileCalls).toHaveLength(1);
    expect(appendFileCalls[0]!.content).toContain('conv-123');
  });

  test('schedules flush after successful non-skipped capture', async () => {
    mockGetCodebase.mockResolvedValueOnce({
      id: 'cb-1',
      name: 'acme/widget',
      default_cwd: '/tmp/acme/widget',
    });

    mockListMessages.mockResolvedValueOnce([
      {
        id: 'msg-1',
        conversation_id: 'conv-123',
        role: 'user' as const,
        content: 'design decision',
        metadata: '{}',
        created_at: '2026-04-11T10:00:00Z',
      },
    ]);

    mockSendQueryChunks = [{ type: 'assistant', content: '## Patterns\n- test\n' }];

    triggerCapture('conv-123', 'cb-1');
    await flushFireAndForget();

    expect(mockScheduleFlush).toHaveBeenCalledWith('acme', 'widget');
  });

  test('does not schedule flush when capture is skipped', async () => {
    mockGetCodebase.mockResolvedValueOnce({
      id: 'cb-1',
      name: 'acme/widget',
      default_cwd: '/tmp/acme/widget',
    });

    // No messages => capture skipped
    mockListMessages.mockResolvedValueOnce([]);

    triggerCapture('conv-123', 'cb-1');
    await flushFireAndForget();

    expect(mockScheduleFlush).not.toHaveBeenCalled();
  });

  test('errors in captureKnowledge are caught and logged, not propagated', async () => {
    mockGetCodebase.mockResolvedValueOnce({
      id: 'cb-1',
      name: 'acme/widget',
      default_cwd: '/tmp/acme/widget',
    });

    mockListMessages.mockResolvedValueOnce([
      {
        id: 'msg-1',
        conversation_id: 'conv-123',
        role: 'user' as const,
        content: 'test',
        metadata: '{}',
        created_at: '2026-04-11T10:00:00Z',
      },
    ]);

    // AI client throws an error
    mockSendQuery.mockImplementation(function* () {
      throw new Error('API rate limit exceeded');
    });

    // This should NOT throw — fire-and-forget catches errors
    triggerCapture('conv-123', 'cb-1');
    await flushFireAndForget();

    // Error was logged (capture_failed from captureKnowledge, then trigger_failed from .catch)
    const errorCalls = mockLogger.error.mock.calls;
    expect(errorCalls.length).toBeGreaterThanOrEqual(1);
    const triggerFailedLog = errorCalls.find(
      (call: unknown[]) => (call[1] as string) === 'knowledge.trigger_failed'
    );
    expect(triggerFailedLog).toBeDefined();
    const logData = triggerFailedLog![0] as {
      conversationId: string;
      codebaseId: string;
      error: string;
    };
    expect(logData.conversationId).toBe('conv-123');
    expect(logData.codebaseId).toBe('cb-1');
    expect(logData.error).toContain('API rate limit');
  });

  test('errors in getCodebase are caught and logged, not propagated', async () => {
    mockGetCodebase.mockRejectedValueOnce(new Error('Database connection lost'));

    // Should NOT throw
    triggerCapture('conv-123', 'cb-1');
    await flushFireAndForget();

    // Error was logged via .catch handler
    const errorCalls = mockLogger.error.mock.calls;
    expect(errorCalls.length).toBeGreaterThanOrEqual(1);
    const triggerFailedLog = errorCalls.find(
      (call: unknown[]) => (call[1] as string) === 'knowledge.trigger_failed'
    );
    expect(triggerFailedLog).toBeDefined();
    const logData = triggerFailedLog![0] as { error: string };
    expect(logData.error).toContain('Database connection lost');
  });
});
