/**
 * Tests for extractKnowledgeFromContext — used by knowledge-extract workflow nodes.
 */
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
  parseOwnerRepo: (name: string) => {
    const parts = name.split('/');
    if (parts.length !== 2) return null;
    return { owner: parts[0], repo: parts[1] };
  },
}));

// Mock @archon/git (used via dynamic import)
mock.module('@archon/git', () => ({
  toRepoPath: (cwd: string) => cwd,
  getRemoteUrl: mock(async () => 'https://github.com/acme/widget.git'),
}));

// Mock messages DB (not used by extractKnowledgeFromContext but imported by module)
mock.module('../db/messages', () => ({
  listMessages: mock(async () => []),
}));

// Mock codebases DB
mock.module('../db/codebases', () => ({
  getCodebase: mock(async () => null),
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
mock.module('../clients/factory', () => ({
  getAssistantClient: mock(() => ({
    sendQuery: mockSendQuery,
    getType: () => 'claude',
  })),
}));

import { extractKnowledgeFromContext } from './knowledge-capture';

describe('extractKnowledgeFromContext', () => {
  beforeEach(() => {
    appendFileCalls.length = 0;
    mkdirCalls.length = 0;
    mockAppendFile.mockClear();
    mockMkdir.mockClear();
    mockLoadConfig.mockClear();
    mockInitKnowledgeDir.mockClear();
    mockScheduleFlush.mockClear();
    mockSendQuery.mockClear();
    Object.values(mockLogger).forEach(fn => fn.mockClear());
    mockSendQueryChunks = [];
    mockSendQuery.mockImplementation(function* () {
      for (const chunk of mockSendQueryChunks) {
        yield chunk;
      }
    });
  });

  test('extracts knowledge and appends to daily log', async () => {
    mockSendQueryChunks = [
      { type: 'assistant', content: '## Decisions\n- Use JWT for auth' },
      { type: 'result' },
    ];

    const result = await extractKnowledgeFromContext(
      'Extract architecture decisions',
      'Auth module uses session tokens',
      '/tmp/repo',
      { workflowRunId: 'run-123', nodeId: 'extract-node' }
    );

    expect(result).toContain('Use JWT for auth');
    expect(mockInitKnowledgeDir).toHaveBeenCalledWith('acme', 'widget');
    expect(appendFileCalls.length).toBe(1);
    expect(appendFileCalls[0].content).toContain('Knowledge Extract:');
    expect(appendFileCalls[0].content).toContain('run-123');
    expect(appendFileCalls[0].content).toContain('extract-node');
  });

  test('returns empty string when knowledge is disabled', async () => {
    mockLoadConfig.mockResolvedValueOnce({
      knowledge: { ...defaultKnowledgeConfig, enabled: false },
      assistants: { claude: { model: 'sonnet' }, codex: {} },
    } as never);

    const result = await extractKnowledgeFromContext(
      'Extract patterns',
      'Some context',
      '/tmp/repo',
      { workflowRunId: 'run-123', nodeId: 'extract' }
    );

    expect(result).toBe('');
    expect(mockSendQuery).not.toHaveBeenCalled();
  });

  test('returns empty string when AI produces no output', async () => {
    mockSendQueryChunks = [{ type: 'result' }];

    const result = await extractKnowledgeFromContext(
      'Extract decisions',
      'Some context',
      '/tmp/repo',
      { workflowRunId: 'run-123', nodeId: 'extract' }
    );

    expect(result).toBe('');
    expect(appendFileCalls.length).toBe(0);
  });

  test('schedules flush after successful extraction', async () => {
    mockSendQueryChunks = [
      { type: 'assistant', content: '## Patterns\n- Use dependency injection' },
      { type: 'result' },
    ];

    await extractKnowledgeFromContext('Extract patterns', 'Context', '/tmp/repo', {
      workflowRunId: 'run-123',
      nodeId: 'extract',
    });

    expect(mockScheduleFlush).toHaveBeenCalledWith('acme', 'widget');
  });

  test('includes custom prompt and context in AI call', async () => {
    mockSendQueryChunks = [{ type: 'assistant', content: 'Extracted content' }, { type: 'result' }];

    await extractKnowledgeFromContext(
      'Focus on security patterns',
      'Auth uses bcrypt for hashing',
      '/tmp/repo',
      { workflowRunId: 'run-123', nodeId: 'extract' }
    );

    expect(mockSendQuery).toHaveBeenCalledTimes(1);
    const callArgs = mockSendQuery.mock.calls[0];
    expect(callArgs[0]).toContain('Focus on security patterns');
    expect(callArgs[0]).toContain('Auth uses bcrypt for hashing');
  });
});
