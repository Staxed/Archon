import { mock, describe, test, expect, beforeEach } from 'bun:test';

// Track appendFile calls
const appendFileCalls: Array<{ path: string; content: string }> = [];
const mockAppendFile = mock(async (path: string, content: string) => {
  appendFileCalls.push({ path, content });
  return undefined;
});

const mkdirCalls: string[] = [];
const mockMkdir = mock(async (path: string) => {
  mkdirCalls.push(path);
  return undefined;
});

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

import { captureKnowledge } from './knowledge-capture';

describe('knowledge-capture', () => {
  beforeEach(() => {
    appendFileCalls.length = 0;
    mkdirCalls.length = 0;
    mockAppendFile.mockClear();
    mockMkdir.mockClear();
    mockListMessages.mockClear();
    mockLoadConfig.mockClear();
    mockInitKnowledgeDir.mockClear();
    mockSendQuery.mockClear();
    mockGetAssistantClient.mockClear();
    Object.values(mockLogger).forEach(fn => fn.mockClear());

    // Reset default mock implementations
    mockListMessages.mockImplementation(async () => []);
    mockSendQueryChunks = [];
    mockSendQuery.mockImplementation(function* () {
      for (const chunk of mockSendQueryChunks) {
        yield chunk;
      }
    });
  });

  test('skips capture when knowledge is disabled', async () => {
    const config = {
      knowledge: { ...defaultKnowledgeConfig, enabled: false },
      assistants: { claude: { model: 'sonnet', settingSources: ['project'] as const }, codex: {} },
      worktree: {},
      docs: { path: 'docs/' },
      defaults: { loadDefaultCommands: true, loadDefaultWorkflows: true },
    };

    const result = await captureKnowledge('conv-123', 'acme', 'widget', config as never);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain('disabled');
    expect(mockListMessages).not.toHaveBeenCalled();
  });

  test('skips capture when conversation has no messages', async () => {
    mockListMessages.mockResolvedValueOnce([]);

    const result = await captureKnowledge('conv-123', 'acme', 'widget');

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain('No messages');
    expect(mockSendQuery).not.toHaveBeenCalled();
  });

  test('extracts knowledge from conversation and appends to daily log', async () => {
    mockListMessages.mockResolvedValueOnce([
      {
        id: 'msg-1',
        conversation_id: 'conv-123',
        role: 'user' as const,
        content: 'How should we handle auth?',
        metadata: '{}',
        created_at: '2026-04-11T10:00:00Z',
      },
      {
        id: 'msg-2',
        conversation_id: 'conv-123',
        role: 'assistant' as const,
        content: 'We should use JWT tokens with short expiry.',
        metadata: '{}',
        created_at: '2026-04-11T10:00:01Z',
      },
    ]);

    mockSendQueryChunks = [
      { type: 'assistant', content: '## Decisions\n' },
      { type: 'assistant', content: '- Use JWT tokens with short expiry for auth\n' },
    ];

    const result = await captureKnowledge('conv-123', 'acme', 'widget');

    expect(result.skipped).toBe(false);
    expect(result.extractedContent).toBe(
      '## Decisions\n- Use JWT tokens with short expiry for auth\n'
    );
    expect(result.logFile).toContain('knowledge/logs/');
    expect(result.logFile).toMatch(/\d{4}-\d{2}-\d{2}\.md$/);
  });

  test('calls AI client with haiku model and no tools', async () => {
    mockListMessages.mockResolvedValueOnce([
      {
        id: 'msg-1',
        conversation_id: 'conv-123',
        role: 'user' as const,
        content: 'test message',
        metadata: '{}',
        created_at: '2026-04-11T10:00:00Z',
      },
    ]);

    mockSendQueryChunks = [{ type: 'assistant', content: '## Patterns\n- test\n' }];

    await captureKnowledge('conv-123', 'acme', 'widget');

    expect(mockGetAssistantClient).toHaveBeenCalledWith('claude');
    expect(mockSendQuery).toHaveBeenCalledTimes(1);

    // Check options passed to sendQuery
    const callArgs = mockSendQuery.mock.calls[0];
    expect(callArgs).toBeDefined();
    // sendQuery(prompt, cwd, resumeSessionId, options)
    const options = callArgs![3] as { model: string; tools: string[] };
    expect(options.model).toBe('haiku');
    expect(options.tools).toEqual([]);
  });

  test('formats transcript with role labels', async () => {
    mockListMessages.mockResolvedValueOnce([
      {
        id: 'msg-1',
        conversation_id: 'conv-123',
        role: 'user' as const,
        content: 'Hello',
        metadata: '{}',
        created_at: '2026-04-11T10:00:00Z',
      },
      {
        id: 'msg-2',
        conversation_id: 'conv-123',
        role: 'assistant' as const,
        content: 'Hi there',
        metadata: '{}',
        created_at: '2026-04-11T10:00:01Z',
      },
    ]);

    mockSendQueryChunks = [{ type: 'assistant', content: '## Lessons\n- greeting\n' }];

    await captureKnowledge('conv-123', 'acme', 'widget');

    // The prompt should contain formatted transcript
    const prompt = mockSendQuery.mock.calls[0]![0] as string;
    expect(prompt).toContain('[USER]: Hello');
    expect(prompt).toContain('[ASSISTANT]: Hi there');
  });

  test('skips when AI returns "No knowledge to extract"', async () => {
    mockListMessages.mockResolvedValueOnce([
      {
        id: 'msg-1',
        conversation_id: 'conv-123',
        role: 'user' as const,
        content: 'Hi',
        metadata: '{}',
        created_at: '2026-04-11T10:00:00Z',
      },
    ]);

    mockSendQueryChunks = [{ type: 'assistant', content: 'No knowledge to extract.' }];

    const result = await captureKnowledge('conv-123', 'acme', 'widget');

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain('No knowledge extracted');
    expect(mockAppendFile).not.toHaveBeenCalled();
  });

  test('initializes KB directory before writing', async () => {
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

    mockSendQueryChunks = [{ type: 'assistant', content: '## Decisions\n- test\n' }];

    await captureKnowledge('conv-123', 'acme', 'widget');

    expect(mockInitKnowledgeDir).toHaveBeenCalledWith('acme', 'widget');
  });

  test('appends to daily log with conversation ID and timestamp', async () => {
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

    mockSendQueryChunks = [{ type: 'assistant', content: '## Patterns\n- something\n' }];

    await captureKnowledge('conv-123', 'acme', 'widget');

    expect(appendFileCalls).toHaveLength(1);
    const call = appendFileCalls[0]!;
    expect(call.path).toContain('/knowledge/logs/');
    expect(call.content).toContain('conv-123');
    expect(call.content).toContain('## Patterns\n- something\n');
    expect(call.content).toContain('### Capture:');
  });

  test('loads config when not provided', async () => {
    mockListMessages.mockResolvedValueOnce([]);

    await captureKnowledge('conv-123', 'acme', 'widget');

    expect(mockLoadConfig).toHaveBeenCalledTimes(1);
  });

  test('uses provided config without loading', async () => {
    const config = {
      knowledge: { ...defaultKnowledgeConfig },
      assistants: { claude: { model: 'sonnet', settingSources: ['project'] as const }, codex: {} },
      worktree: {},
      docs: { path: 'docs/' },
      defaults: { loadDefaultCommands: true, loadDefaultWorkflows: true },
    };

    mockListMessages.mockResolvedValueOnce([]);

    await captureKnowledge('conv-123', 'acme', 'widget', config as never);

    expect(mockLoadConfig).not.toHaveBeenCalled();
  });

  test('throws and logs on AI client error', async () => {
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

    mockSendQuery.mockImplementation(function* () {
      throw new Error('API rate limit exceeded');
    });

    await expect(captureKnowledge('conv-123', 'acme', 'widget')).rejects.toThrow(
      'API rate limit exceeded'
    );

    expect(mockLogger.error).toHaveBeenCalled();
  });

  test('ignores non-assistant chunks from AI response', async () => {
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

    mockSendQueryChunks = [
      { type: 'thinking', content: 'analyzing...' },
      { type: 'assistant', content: '## Decisions\n- use X\n' },
      { type: 'result' },
    ];

    const result = await captureKnowledge('conv-123', 'acme', 'widget');

    expect(result.extractedContent).toBe('## Decisions\n- use X\n');
  });
});
