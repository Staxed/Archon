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
const mockInitGlobalKnowledgeDir = mock(async () => undefined);
mock.module('./knowledge-init', () => ({
  initKnowledgeDir: mockInitKnowledgeDir,
  initGlobalKnowledgeDir: mockInitGlobalKnowledgeDir,
}));

// Mock knowledge-scheduler
const mockScheduleFlush = mock(async () => undefined);
const mockScheduleGlobalFlush = mock(async () => undefined);
mock.module('./knowledge-scheduler', () => ({
  scheduleFlush: mockScheduleFlush,
  scheduleGlobalFlush: mockScheduleGlobalFlush,
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

import { extractKnowledgeFromContext, parseScopedOutput } from './knowledge-capture';

describe('extractKnowledgeFromContext', () => {
  beforeEach(() => {
    appendFileCalls.length = 0;
    mkdirCalls.length = 0;
    mockAppendFile.mockClear();
    mockMkdir.mockClear();
    mockLoadConfig.mockClear();
    mockInitKnowledgeDir.mockClear();
    mockInitGlobalKnowledgeDir.mockClear();
    mockScheduleFlush.mockClear();
    mockScheduleGlobalFlush.mockClear();
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

  test('scope=project writes only to project log, not global', async () => {
    mockSendQueryChunks = [
      { type: 'assistant', content: '## Decisions\n- Project-specific decision' },
      { type: 'result' },
    ];

    await extractKnowledgeFromContext(
      'Extract decisions',
      'Context',
      '/tmp/repo',
      { workflowRunId: 'run-123', nodeId: 'extract' },
      'project'
    );

    expect(mockInitKnowledgeDir).toHaveBeenCalledWith('acme', 'widget');
    expect(mockInitGlobalKnowledgeDir).not.toHaveBeenCalled();
    expect(mockScheduleFlush).toHaveBeenCalledWith('acme', 'widget');
    expect(mockScheduleGlobalFlush).not.toHaveBeenCalled();

    // Only one appendFile call (project log)
    expect(appendFileCalls.length).toBe(1);
    expect(appendFileCalls[0].path).toContain('/workspaces/acme/widget/knowledge/logs/');
  });

  test('scope=global writes only to global log, not project', async () => {
    mockSendQueryChunks = [
      { type: 'assistant', content: '## Patterns\n- Universal pattern' },
      { type: 'result' },
    ];

    await extractKnowledgeFromContext(
      'Extract patterns',
      'Context',
      '/tmp/repo',
      { workflowRunId: 'run-123', nodeId: 'extract' },
      'global'
    );

    expect(mockInitKnowledgeDir).not.toHaveBeenCalled();
    expect(mockInitGlobalKnowledgeDir).toHaveBeenCalled();
    expect(mockScheduleFlush).not.toHaveBeenCalled();
    expect(mockScheduleGlobalFlush).toHaveBeenCalled();

    // Only one appendFile call (global log)
    expect(appendFileCalls.length).toBe(1);
    expect(appendFileCalls[0].path).toContain('/home/test/.archon/knowledge/logs/');
  });

  test('scope=both with both sections writes to both logs', async () => {
    mockSendQueryChunks = [
      {
        type: 'assistant',
        content:
          '## PROJECT\n\n- Repo-specific pattern\n\n## GLOBAL\n\n- Universal debugging technique',
      },
      { type: 'result' },
    ];

    await extractKnowledgeFromContext(
      'Extract knowledge',
      'Context',
      '/tmp/repo',
      { workflowRunId: 'run-123', nodeId: 'extract' },
      'both'
    );

    expect(mockInitKnowledgeDir).toHaveBeenCalledWith('acme', 'widget');
    expect(mockInitGlobalKnowledgeDir).toHaveBeenCalled();
    expect(mockScheduleFlush).toHaveBeenCalledWith('acme', 'widget');
    expect(mockScheduleGlobalFlush).toHaveBeenCalled();

    // Two appendFile calls (project + global)
    expect(appendFileCalls.length).toBe(2);
    const projectCall = appendFileCalls.find(c =>
      c.path.includes('/workspaces/acme/widget/knowledge/logs/')
    );
    const globalCall = appendFileCalls.find(c =>
      c.path.includes('/home/test/.archon/knowledge/logs/')
    );
    expect(projectCall).toBeDefined();
    expect(globalCall).toBeDefined();
    expect(projectCall!.content).toContain('Repo-specific pattern');
    expect(globalCall!.content).toContain('Universal debugging technique');
  });

  test('scope=both with malformed output falls back to project', async () => {
    mockSendQueryChunks = [
      { type: 'assistant', content: '## Decisions\n- Some decision without scope blocks' },
      { type: 'result' },
    ];

    await extractKnowledgeFromContext(
      'Extract decisions',
      'Context',
      '/tmp/repo',
      { workflowRunId: 'run-123', nodeId: 'extract' },
      'both'
    );

    // Fallback: all content goes to project
    expect(mockInitKnowledgeDir).toHaveBeenCalledWith('acme', 'widget');
    expect(mockInitGlobalKnowledgeDir).not.toHaveBeenCalled();
    expect(appendFileCalls.length).toBe(1);
    expect(appendFileCalls[0].path).toContain('/workspaces/acme/widget/knowledge/logs/');
  });

  test('global log entries include source attribution', async () => {
    mockSendQueryChunks = [
      {
        type: 'assistant',
        content: '## GLOBAL\n\n- Universal pattern',
      },
      { type: 'result' },
    ];

    await extractKnowledgeFromContext(
      'Extract patterns',
      'Context',
      '/tmp/repo',
      { workflowRunId: 'run-123', nodeId: 'extract' },
      'both'
    );

    const globalCall = appendFileCalls.find(c =>
      c.path.includes('/home/test/.archon/knowledge/logs/')
    );
    expect(globalCall).toBeDefined();
    expect(globalCall!.content).toContain('**Source**: acme/widget');
  });

  test('scope=both appends scope classification addendum to prompt', async () => {
    mockSendQueryChunks = [{ type: 'assistant', content: 'Content' }, { type: 'result' }];

    await extractKnowledgeFromContext(
      'Extract knowledge',
      'Context',
      '/tmp/repo',
      { workflowRunId: 'run-123', nodeId: 'extract' },
      'both'
    );

    const callArgs = mockSendQuery.mock.calls[0];
    const prompt = callArgs[0] as string;
    expect(prompt).toContain('Scope Classification');
    expect(prompt).toContain('PROJECT');
    expect(prompt).toContain('GLOBAL');
  });

  test('scope=project does not append scope classification addendum', async () => {
    mockSendQueryChunks = [{ type: 'assistant', content: 'Content' }, { type: 'result' }];

    await extractKnowledgeFromContext(
      'Extract knowledge',
      'Context',
      '/tmp/repo',
      { workflowRunId: 'run-123', nodeId: 'extract' },
      'project'
    );

    const callArgs = mockSendQuery.mock.calls[0];
    const prompt = callArgs[0] as string;
    expect(prompt).not.toContain('Scope Classification');
  });
});

describe('parseScopedOutput', () => {
  test('scope=project returns all content as project', () => {
    const result = parseScopedOutput('Some content', 'project');
    expect(result.project).toBe('Some content');
    expect(result.global).toBe('');
  });

  test('scope=global returns all content as global', () => {
    const result = parseScopedOutput('Some content', 'global');
    expect(result.project).toBe('');
    expect(result.global).toBe('Some content');
  });

  test('scope=both parses both blocks', () => {
    const content = '## PROJECT\n\nProject stuff\n\n## GLOBAL\n\nGlobal stuff';
    const result = parseScopedOutput(content, 'both');
    expect(result.project).toBe('Project stuff');
    expect(result.global).toBe('Global stuff');
  });

  test('scope=both with only project block', () => {
    const content = '## PROJECT\n\nOnly project content';
    const result = parseScopedOutput(content, 'both');
    expect(result.project).toBe('Only project content');
    expect(result.global).toBe('');
  });

  test('scope=both with only global block', () => {
    const content = '## GLOBAL\n\nOnly global content';
    const result = parseScopedOutput(content, 'both');
    expect(result.project).toBe('');
    expect(result.global).toBe('Only global content');
  });

  test('scope=both with malformed output falls back to project', () => {
    const content = '## Decisions\n- Some decision without scope markers';
    const result = parseScopedOutput(content, 'both');
    expect(result.project).toBe('## Decisions\n- Some decision without scope markers');
    expect(result.global).toBe('');
  });

  test('scope=both with empty content falls back to project', () => {
    const result = parseScopedOutput('  ', 'both');
    // Trimmed empty content still falls back to project
    expect(result.project).toBe('');
    expect(result.global).toBe('');
  });
});
