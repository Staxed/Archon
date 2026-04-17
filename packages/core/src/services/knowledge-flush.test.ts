import { mock, describe, test, expect, beforeEach } from 'bun:test';

// Track writeFile calls
const writeFileCalls: Array<{ path: string; content: string; options?: unknown }> = [];
const mockWriteFile = mock(async (path: string, content: string, options?: unknown) => {
  // Simulate exclusive create (wx flag) — fail if file already exists in mock FS
  if (
    options &&
    typeof options === 'object' &&
    'flag' in options &&
    (options as { flag: string }).flag === 'wx'
  ) {
    if (fileSystem[path] !== undefined) {
      const err = new Error(`EEXIST: file already exists, open '${path}'`) as NodeJS.ErrnoException;
      err.code = 'EEXIST';
      throw err;
    }
  }
  writeFileCalls.push({ path, content, options });
  fileSystem[path] = content;
  return undefined;
});

const mkdirCalls: string[] = [];
const mockMkdir = mock(async (path: string) => {
  mkdirCalls.push(path);
  return undefined;
});

const renameCalls: Array<{ oldPath: string; newPath: string }> = [];
const mockRename = mock(async (oldPath: string, newPath: string) => {
  renameCalls.push({ oldPath, newPath });
  return undefined;
});

const unlinkCalls: string[] = [];
const mockUnlink = mock(async (path: string) => {
  unlinkCalls.push(path);
  delete fileSystem[path];
  return undefined;
});

const rmCalls: string[] = [];
const mockRm = mock(async (path: string) => {
  rmCalls.push(path);
  return undefined;
});

// File system state for readFile/readdir
let fileSystem: Record<string, string> = {};
let directories: Record<string, string[]> = {};

const mockReadFile = mock(async (path: string) => {
  if (fileSystem[path] !== undefined) {
    return fileSystem[path];
  }
  const err = new Error(
    `ENOENT: no such file or directory, open '${path}'`
  ) as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  throw err;
});

const mockReaddir = mock(async (path: string) => {
  if (directories[path] !== undefined) {
    return directories[path];
  }
  const err = new Error(
    `ENOENT: no such file or directory, scandir '${path}'`
  ) as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  throw err;
});

mock.module('node:fs/promises', () => ({
  writeFile: mockWriteFile,
  mkdir: mockMkdir,
  readFile: mockReadFile,
  readdir: mockReaddir,
  rename: mockRename,
  unlink: mockUnlink,
  rm: mockRm,
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
  getProjectSourcePath: (owner: string, repo: string) =>
    `/home/test/.archon/workspaces/${owner}/${repo}/source`,
  getGlobalKnowledgePath: () => '/home/test/.archon/knowledge',
  createLogger: mock(() => mockLogger),
}));

// Mock @archon/git
const mockExecFileAsync = mock(async () => ({ stdout: '', stderr: '' }));
mock.module('@archon/git', () => ({
  execFileAsync: mockExecFileAsync,
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

import { flushKnowledge, flushGlobalKnowledge } from './knowledge-flush';

const KB_PATH = '/home/test/.archon/workspaces/acme/widget/knowledge';

describe('knowledge-flush', () => {
  beforeEach(() => {
    writeFileCalls.length = 0;
    mkdirCalls.length = 0;
    renameCalls.length = 0;
    unlinkCalls.length = 0;
    rmCalls.length = 0;
    fileSystem = {};
    directories = {};
    mockWriteFile.mockClear();
    mockMkdir.mockClear();
    mockRename.mockClear();
    mockUnlink.mockClear();
    mockRm.mockClear();
    mockReadFile.mockClear();
    mockReaddir.mockClear();
    mockLoadConfig.mockClear();
    mockInitKnowledgeDir.mockClear();
    mockInitGlobalKnowledgeDir.mockClear();
    mockSendQuery.mockClear();
    mockGetAssistantClient.mockClear();
    mockExecFileAsync.mockClear();
    Object.values(mockLogger).forEach(fn => fn.mockClear());

    // Reset default mock implementations
    mockExecFileAsync.mockImplementation(async () => ({ stdout: '', stderr: '' }));
    mockSendQueryChunks = [];
    mockSendQuery.mockImplementation(function* () {
      for (const chunk of mockSendQueryChunks) {
        yield chunk;
      }
    });
    mockReadFile.mockImplementation(async (path: string) => {
      if (fileSystem[path] !== undefined) {
        return fileSystem[path];
      }
      const err = new Error(`ENOENT`) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });
    mockReaddir.mockImplementation(async (path: string) => {
      if (directories[path] !== undefined) {
        return directories[path];
      }
      const err = new Error(`ENOENT`) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });
  });

  test('skips flush when knowledge is disabled', async () => {
    const config = {
      knowledge: { ...defaultKnowledgeConfig, enabled: false },
      assistants: { claude: { model: 'sonnet', settingSources: ['project'] as const }, codex: {} },
      worktree: {},
      docs: { path: 'docs/' },
      defaults: { loadDefaultCommands: true, loadDefaultWorkflows: true },
    };

    const result = await flushKnowledge('acme', 'widget', config as never);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain('disabled');
    expect(mockInitKnowledgeDir).not.toHaveBeenCalled();
  });

  test('skips flush when no unprocessed logs exist', async () => {
    // Empty logs directory
    directories[`${KB_PATH}/logs`] = [];
    directories[`${KB_PATH}/domains`] = [];

    const result = await flushKnowledge('acme', 'widget');

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain('No unprocessed logs');
    expect(mockSendQuery).not.toHaveBeenCalled();
  });

  test('skips flush when logs directory does not exist', async () => {
    // readdir will throw ENOENT by default
    const result = await flushKnowledge('acme', 'widget');

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain('No unprocessed logs');
  });

  test('flushes logs into articles and updates indexes', async () => {
    // Set up: one daily log, no existing articles, no last-flush
    directories[`${KB_PATH}/logs`] = ['2026-04-11.md'];
    directories[`${KB_PATH}/domains`] = ['architecture'];
    directories[`${KB_PATH}/domains/architecture`] = ['_index.md'];

    fileSystem[`${KB_PATH}/logs/2026-04-11.md`] = '## Decisions\n- Use JWT for auth\n';
    fileSystem[`${KB_PATH}/domains/architecture/_index.md`] =
      '# Architecture\n\nSystem design.\n\n## Articles\n\n_No articles yet. Articles will appear here as knowledge is compiled._\n';

    const synthesisResponse = JSON.stringify({
      articles: [
        {
          domain: 'decisions',
          concept: 'auth-token-strategy',
          content:
            '# Auth Token Strategy\n\nUse JWT tokens with short expiry.\n\n## Related\n\n- [[architecture/api-design]]\n',
        },
      ],
      domainSummaries: {
        decisions: 'Architectural decisions including auth strategy.',
      },
      indexSummary: 'Project knowledge covering auth decisions.',
    });

    mockSendQueryChunks = [{ type: 'assistant', content: synthesisResponse }];

    const result = await flushKnowledge('acme', 'widget');

    expect(result.skipped).toBe(false);
    expect(result.articlesCreated).toBe(1);
    expect(result.logsProcessed).toEqual(['2026-04-11.md']);

    // Verify article was written
    const articleWrite = writeFileCalls.find(c => c.path.includes('auth-token-strategy.md'));
    expect(articleWrite).toBeDefined();
    expect(articleWrite!.content).toContain('Auth Token Strategy');
    expect(articleWrite!.content).toContain('[[architecture/api-design]]');
  });

  test('calls AI client with sonnet model', async () => {
    directories[`${KB_PATH}/logs`] = ['2026-04-11.md'];
    directories[`${KB_PATH}/domains`] = [];

    fileSystem[`${KB_PATH}/logs/2026-04-11.md`] = '## Patterns\n- test\n';

    mockSendQueryChunks = [
      {
        type: 'assistant',
        content: JSON.stringify({
          articles: [],
          domainSummaries: {},
          indexSummary: '',
        }),
      },
    ];

    await flushKnowledge('acme', 'widget');

    expect(mockGetAssistantClient).toHaveBeenCalledWith('claude');
    const callArgs = mockSendQuery.mock.calls[0];
    const options = callArgs![3] as { model: string; tools: string[] };
    expect(options.model).toBe('sonnet');
    expect(options.tools).toEqual([]);
  });

  test('only processes logs newer than last flush', async () => {
    // Last flush was on 2026-04-09
    fileSystem[`${KB_PATH}/meta/last-flush.json`] = JSON.stringify({
      timestamp: '2026-04-09T12:00:00Z',
      gitSha: '',
      logsCaptured: ['2026-04-09.md'],
    });

    directories[`${KB_PATH}/logs`] = [
      '2026-04-08.md',
      '2026-04-09.md',
      '2026-04-10.md',
      '2026-04-11.md',
    ];
    directories[`${KB_PATH}/domains`] = [];

    fileSystem[`${KB_PATH}/logs/2026-04-09.md`] = '## Day 09\n';
    fileSystem[`${KB_PATH}/logs/2026-04-10.md`] = '## Day 10\n';
    fileSystem[`${KB_PATH}/logs/2026-04-11.md`] = '## Day 11\n';

    mockSendQueryChunks = [
      {
        type: 'assistant',
        content: JSON.stringify({
          articles: [],
          domainSummaries: {},
          indexSummary: '',
        }),
      },
    ];

    const result = await flushKnowledge('acme', 'widget');

    // Should process logs from 2026-04-09 (same day — may have new entries), 2026-04-10, and 2026-04-11
    expect(result.logsProcessed).toEqual(['2026-04-09.md', '2026-04-10.md', '2026-04-11.md']);

    // Verify the prompt includes the relevant logs
    const prompt = mockSendQuery.mock.calls[0]![0] as string;
    expect(prompt).toContain('2026-04-09.md');
    expect(prompt).toContain('2026-04-10.md');
    expect(prompt).toContain('2026-04-11.md');
    expect(prompt).not.toContain('2026-04-08.md');
  });

  test('creates new domain directories for organic domains', async () => {
    directories[`${KB_PATH}/logs`] = ['2026-04-11.md'];
    directories[`${KB_PATH}/domains`] = [];

    fileSystem[`${KB_PATH}/logs/2026-04-11.md`] = '## Security patterns\n';

    const synthesisResponse = JSON.stringify({
      articles: [
        {
          domain: 'security',
          concept: 'auth-best-practices',
          content: '# Auth Best Practices\n\nContent here.\n',
        },
      ],
      domainSummaries: {
        security: 'Security-related knowledge.',
      },
      indexSummary: 'Project knowledge including security.',
    });

    mockSendQueryChunks = [{ type: 'assistant', content: synthesisResponse }];

    const result = await flushKnowledge('acme', 'widget');

    expect(result.domainsCreated).toContain('security');
    expect(mkdirCalls).toContainEqual(expect.stringContaining('domains/security'));
  });

  test('tracks updated vs created articles', async () => {
    directories[`${KB_PATH}/logs`] = ['2026-04-11.md'];
    directories[`${KB_PATH}/domains`] = ['decisions'];
    directories[`${KB_PATH}/domains/decisions`] = ['_index.md', 'auth-strategy.md'];

    fileSystem[`${KB_PATH}/logs/2026-04-11.md`] = '## Updates\n';
    fileSystem[`${KB_PATH}/domains/decisions/_index.md`] = '# Decisions\n\n## Articles\n';
    fileSystem[`${KB_PATH}/domains/decisions/auth-strategy.md`] =
      '# Auth Strategy\n\nOld content.\n';

    const synthesisResponse = JSON.stringify({
      articles: [
        {
          domain: 'decisions',
          concept: 'auth-strategy',
          content: '# Auth Strategy\n\nUpdated content.\n',
        },
        {
          domain: 'decisions',
          concept: 'caching-policy',
          content: '# Caching Policy\n\nNew article.\n',
        },
      ],
      domainSummaries: {
        decisions: 'Decisions about auth and caching.',
      },
      indexSummary: 'Updated decisions.',
    });

    mockSendQueryChunks = [{ type: 'assistant', content: synthesisResponse }];

    const result = await flushKnowledge('acme', 'widget');

    expect(result.articlesUpdated).toBe(1); // auth-strategy existed
    expect(result.articlesCreated).toBe(1); // caching-policy is new
  });

  test('updates meta/last-flush.json after flush', async () => {
    directories[`${KB_PATH}/logs`] = ['2026-04-11.md'];
    directories[`${KB_PATH}/domains`] = [];

    fileSystem[`${KB_PATH}/logs/2026-04-11.md`] = '## Content\n';

    mockSendQueryChunks = [
      {
        type: 'assistant',
        content: JSON.stringify({
          articles: [],
          domainSummaries: {},
          indexSummary: '',
        }),
      },
    ];

    await flushKnowledge('acme', 'widget');

    const flushWrite = writeFileCalls.find(c => c.path.includes('last-flush.json'));
    expect(flushWrite).toBeDefined();
    const meta = JSON.parse(flushWrite!.content) as { timestamp: string; logsCaptured: string[] };
    expect(meta.timestamp).toBeTruthy();
    expect(meta.logsCaptured).toEqual(['2026-04-11.md']);
  });

  test('updates top-level index.md with domain summaries', async () => {
    directories[`${KB_PATH}/logs`] = ['2026-04-11.md'];
    directories[`${KB_PATH}/domains`] = [];

    fileSystem[`${KB_PATH}/logs/2026-04-11.md`] = '## Content\n';

    const synthesisResponse = JSON.stringify({
      articles: [
        {
          domain: 'patterns',
          concept: 'error-handling',
          content: '# Error Handling\n\nAlways use try-catch.\n',
        },
      ],
      domainSummaries: {
        patterns: 'Code patterns including error handling.',
      },
      indexSummary: 'Knowledge about patterns.',
    });

    mockSendQueryChunks = [{ type: 'assistant', content: synthesisResponse }];

    await flushKnowledge('acme', 'widget');

    // With atomic writes, index is written to .tmp/ first then renamed
    const indexWrite = writeFileCalls.find(c => c.path.includes('.tmp/index.md'));
    expect(indexWrite).toBeDefined();
    expect(indexWrite!.content).toContain('[[domains/patterns/_index|Patterns]]');
    expect(indexWrite!.content).toContain('Code patterns including error handling.');

    // Verify it was renamed to the final path
    const indexRename = renameCalls.find(r => r.newPath.endsWith('/knowledge/index.md'));
    expect(indexRename).toBeDefined();
  });

  test('handles AI response with markdown code fences', async () => {
    directories[`${KB_PATH}/logs`] = ['2026-04-11.md'];
    directories[`${KB_PATH}/domains`] = [];

    fileSystem[`${KB_PATH}/logs/2026-04-11.md`] = '## Content\n';

    const jsonResponse = JSON.stringify({
      articles: [],
      domainSummaries: {},
      indexSummary: '',
    });

    // AI wraps response in code fences
    mockSendQueryChunks = [{ type: 'assistant', content: '```json\n' + jsonResponse + '\n```' }];

    const result = await flushKnowledge('acme', 'widget');

    // Should parse successfully despite code fences
    expect(result.skipped).toBe(false);
    expect(result.logsProcessed).toEqual(['2026-04-11.md']);
  });

  test('initializes KB directory before flush', async () => {
    directories[`${KB_PATH}/logs`] = ['2026-04-11.md'];
    directories[`${KB_PATH}/domains`] = [];

    fileSystem[`${KB_PATH}/logs/2026-04-11.md`] = '## Content\n';

    mockSendQueryChunks = [
      {
        type: 'assistant',
        content: JSON.stringify({ articles: [], domainSummaries: {}, indexSummary: '' }),
      },
    ];

    await flushKnowledge('acme', 'widget');

    expect(mockInitKnowledgeDir).toHaveBeenCalledWith('acme', 'widget');
  });

  test('loads config when not provided', async () => {
    directories[`${KB_PATH}/logs`] = [];

    await flushKnowledge('acme', 'widget');

    expect(mockLoadConfig).toHaveBeenCalledTimes(1);
  });

  test('throws and logs on AI client error', async () => {
    directories[`${KB_PATH}/logs`] = ['2026-04-11.md'];
    directories[`${KB_PATH}/domains`] = [];

    fileSystem[`${KB_PATH}/logs/2026-04-11.md`] = '## Content\n';

    mockSendQuery.mockImplementation(function* () {
      throw new Error('API rate limit exceeded');
    });

    await expect(flushKnowledge('acme', 'widget')).rejects.toThrow('API rate limit exceeded');

    expect(mockLogger.error).toHaveBeenCalled();
  });

  test('reads existing articles for merge context', async () => {
    directories[`${KB_PATH}/logs`] = ['2026-04-11.md'];
    directories[`${KB_PATH}/domains`] = ['architecture'];
    directories[`${KB_PATH}/domains/architecture`] = ['_index.md', 'api-design.md'];

    fileSystem[`${KB_PATH}/logs/2026-04-11.md`] = '## New info\n';
    fileSystem[`${KB_PATH}/domains/architecture/_index.md`] = '# Architecture\n';
    fileSystem[`${KB_PATH}/domains/architecture/api-design.md`] =
      '# API Design\n\nExisting content about API design.\n';

    mockSendQueryChunks = [
      {
        type: 'assistant',
        content: JSON.stringify({ articles: [], domainSummaries: {}, indexSummary: '' }),
      },
    ];

    await flushKnowledge('acme', 'widget');

    // Verify the prompt includes existing articles for merge context
    const prompt = mockSendQuery.mock.calls[0]![0] as string;
    expect(prompt).toContain('Existing Articles');
    expect(prompt).toContain('api-design.md');
    expect(prompt).toContain('Existing content about API design');
  });

  test('articles use wikilink backlinks', async () => {
    directories[`${KB_PATH}/logs`] = ['2026-04-11.md'];
    directories[`${KB_PATH}/domains`] = [];

    fileSystem[`${KB_PATH}/logs/2026-04-11.md`] = '## Content\n';

    const synthesisResponse = JSON.stringify({
      articles: [
        {
          domain: 'lessons',
          concept: 'mock-pollution',
          content:
            '# Mock Pollution\n\nBun mock.module() is irreversible.\n\n## Related\n\n- [[patterns/testing-patterns]]\n',
        },
      ],
      domainSummaries: { lessons: 'Testing lessons.' },
      indexSummary: 'Lessons learned.',
    });

    mockSendQueryChunks = [{ type: 'assistant', content: synthesisResponse }];

    const result = await flushKnowledge('acme', 'widget');

    expect(result.articlesCreated).toBe(1);

    const articleWrite = writeFileCalls.find(c => c.path.includes('mock-pollution.md'));
    expect(articleWrite).toBeDefined();
    expect(articleWrite!.content).toContain('[[patterns/testing-patterns]]');
  });

  test('logs flush events correctly', async () => {
    directories[`${KB_PATH}/logs`] = ['2026-04-11.md'];
    directories[`${KB_PATH}/domains`] = [];

    fileSystem[`${KB_PATH}/logs/2026-04-11.md`] = '## Content\n';

    mockSendQueryChunks = [
      {
        type: 'assistant',
        content: JSON.stringify({ articles: [], domainSummaries: {}, indexSummary: '' }),
      },
    ];

    await flushKnowledge('acme', 'widget');

    // Check that flush_started and flush_completed were logged
    const infoMessages = mockLogger.info.mock.calls.map((call: unknown[]) => call[1] as string);
    expect(infoMessages).toContain('knowledge.flush_started');
    expect(infoMessages).toContain('knowledge.flush_completed');
  });

  test('acquires and releases flush lock', async () => {
    directories[`${KB_PATH}/logs`] = ['2026-04-11.md'];
    directories[`${KB_PATH}/domains`] = [];

    fileSystem[`${KB_PATH}/logs/2026-04-11.md`] = '## Content\n';

    mockSendQueryChunks = [
      {
        type: 'assistant',
        content: JSON.stringify({ articles: [], domainSummaries: {}, indexSummary: '' }),
      },
    ];

    await flushKnowledge('acme', 'widget');

    // Lock file was written with PID
    const lockWrite = writeFileCalls.find(c => c.path.includes('flush.lock'));
    expect(lockWrite).toBeDefined();
    expect(lockWrite!.content).toBe(String(process.pid));

    // Lock was released (unlinked)
    const lockUnlink = unlinkCalls.find(p => p.includes('flush.lock'));
    expect(lockUnlink).toBeDefined();
  });

  test('skips flush when lock held by another live process', async () => {
    // Simulate lock held by our own process (which is alive)
    fileSystem[`${KB_PATH}/meta/flush.lock`] = String(process.pid);

    const result = await flushKnowledge('acme', 'widget');

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain('lock held');

    // Warning logged
    const warnMessages = mockLogger.warn.mock.calls.map((call: unknown[]) => call[1] as string);
    expect(warnMessages).toContain('knowledge.flush_lock_held');
  });

  test('reclaims stale lock from dead process', async () => {
    // Use a PID that definitely doesn't exist (very large number)
    fileSystem[`${KB_PATH}/meta/flush.lock`] = '99999999';

    directories[`${KB_PATH}/logs`] = ['2026-04-11.md'];
    directories[`${KB_PATH}/domains`] = [];
    fileSystem[`${KB_PATH}/logs/2026-04-11.md`] = '## Content\n';

    mockSendQueryChunks = [
      {
        type: 'assistant',
        content: JSON.stringify({ articles: [], domainSummaries: {}, indexSummary: '' }),
      },
    ];

    const result = await flushKnowledge('acme', 'widget');

    // Should have reclaimed the stale lock and proceeded
    expect(result.skipped).toBe(false);

    // Info log about reclaiming
    const infoMessages = mockLogger.info.mock.calls.map((call: unknown[]) => call[1] as string);
    expect(infoMessages).toContain('knowledge.flush_lock_reclaimed');
  });

  test('releases lock even when flush throws', async () => {
    directories[`${KB_PATH}/logs`] = ['2026-04-11.md'];
    directories[`${KB_PATH}/domains`] = [];
    fileSystem[`${KB_PATH}/logs/2026-04-11.md`] = '## Content\n';

    mockSendQuery.mockImplementation(function* () {
      throw new Error('Synthesis failed');
    });

    await expect(flushKnowledge('acme', 'widget')).rejects.toThrow('Synthesis failed');

    // Lock should still be released via finally
    const lockUnlink = unlinkCalls.find(p => p.includes('flush.lock'));
    expect(lockUnlink).toBeDefined();
  });

  test('writes articles to temp dir then renames to final paths', async () => {
    directories[`${KB_PATH}/logs`] = ['2026-04-11.md'];
    directories[`${KB_PATH}/domains`] = [];

    fileSystem[`${KB_PATH}/logs/2026-04-11.md`] = '## Content\n';

    const synthesisResponse = JSON.stringify({
      articles: [
        {
          domain: 'decisions',
          concept: 'test-concept',
          content: '# Test Concept\n\nContent.\n',
        },
      ],
      domainSummaries: { decisions: 'Decisions.' },
      indexSummary: 'Summary.',
    });

    mockSendQueryChunks = [{ type: 'assistant', content: synthesisResponse }];

    await flushKnowledge('acme', 'widget');

    // Articles written to .tmp first
    const tmpArticleWrite = writeFileCalls.find(c =>
      c.path.includes('.tmp/domains/decisions/test-concept.md')
    );
    expect(tmpArticleWrite).toBeDefined();

    // Renamed from tmp to final
    const articleRename = renameCalls.find(
      r =>
        r.oldPath.includes('.tmp/domains/decisions/test-concept.md') &&
        r.newPath.includes('domains/decisions/test-concept.md') &&
        !r.newPath.includes('.tmp')
    );
    expect(articleRename).toBeDefined();
  });

  test('updates last-flush.json via temp+rename', async () => {
    directories[`${KB_PATH}/logs`] = ['2026-04-11.md'];
    directories[`${KB_PATH}/domains`] = [];
    fileSystem[`${KB_PATH}/logs/2026-04-11.md`] = '## Content\n';

    mockSendQueryChunks = [
      {
        type: 'assistant',
        content: JSON.stringify({ articles: [], domainSummaries: {}, indexSummary: '' }),
      },
    ];

    await flushKnowledge('acme', 'widget');

    // last-flush.json written to tmp path first
    const tmpWrite = writeFileCalls.find(c => c.path.includes('last-flush.json.tmp'));
    expect(tmpWrite).toBeDefined();

    // Renamed from tmp to final
    const flushRename = renameCalls.find(
      r => r.oldPath.includes('last-flush.json.tmp') && r.newPath.includes('last-flush.json')
    );
    expect(flushRename).toBeDefined();
  });

  test('cleans up leftover temp dir from crashed flush', async () => {
    directories[`${KB_PATH}/logs`] = ['2026-04-11.md'];
    directories[`${KB_PATH}/domains`] = [];
    fileSystem[`${KB_PATH}/logs/2026-04-11.md`] = '## Content\n';

    mockSendQueryChunks = [
      {
        type: 'assistant',
        content: JSON.stringify({ articles: [], domainSummaries: {}, indexSummary: '' }),
      },
    ];

    await flushKnowledge('acme', 'widget');

    // rm was called to clean up .tmp dir (at least twice — once before, once after)
    const tmpRmCalls = rmCalls.filter(p => p.includes('.tmp'));
    expect(tmpRmCalls.length).toBeGreaterThanOrEqual(1);
  });

  test('stores git SHA in last-flush.json', async () => {
    directories[`${KB_PATH}/logs`] = ['2026-04-11.md'];
    directories[`${KB_PATH}/domains`] = [];
    fileSystem[`${KB_PATH}/logs/2026-04-11.md`] = '## Content\n';

    // Mock git rev-parse HEAD to return a SHA
    mockExecFileAsync.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes('rev-parse')) {
        return { stdout: 'abc123def456\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    mockSendQueryChunks = [
      {
        type: 'assistant',
        content: JSON.stringify({ articles: [], domainSummaries: {}, indexSummary: '' }),
      },
    ];

    await flushKnowledge('acme', 'widget');

    const flushWrite = writeFileCalls.find(c => c.path.includes('last-flush.json'));
    expect(flushWrite).toBeDefined();
    const meta = JSON.parse(flushWrite!.content) as { gitSha: string };
    expect(meta.gitSha).toBe('abc123def456');
  });

  test('validates staleness when last flush has git SHA', async () => {
    // Set up last-flush with a git SHA
    fileSystem[`${KB_PATH}/meta/last-flush.json`] = JSON.stringify({
      timestamp: '2026-04-09T12:00:00Z',
      gitSha: 'oldsha123',
      logsCaptured: ['2026-04-09.md'],
    });

    directories[`${KB_PATH}/logs`] = ['2026-04-10.md'];
    directories[`${KB_PATH}/domains`] = ['decisions'];
    directories[`${KB_PATH}/domains/decisions`] = ['_index.md', 'auth-strategy.md'];

    fileSystem[`${KB_PATH}/logs/2026-04-10.md`] = '## New info\n';
    fileSystem[`${KB_PATH}/domains/decisions/_index.md`] = '# Decisions\n\n## Articles\n';
    fileSystem[`${KB_PATH}/domains/decisions/auth-strategy.md`] =
      '# Auth Strategy\n\nUse JWT with src/auth/tokens.ts.\n\n## Related\n';

    // Mock git commands: rev-parse returns new SHA, diff returns changed files
    mockExecFileAsync.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes('rev-parse')) {
        return { stdout: 'newsha456\n', stderr: '' };
      }
      if (args.includes('diff')) {
        return { stdout: 'src/auth/tokens.ts\nsrc/api/routes.ts\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    // Synthesis call returns no new articles, staleness call returns stale articles
    let callCount = 0;
    mockSendQuery.mockImplementation(function* () {
      callCount++;
      if (callCount === 1) {
        // Synthesis response
        yield {
          type: 'assistant',
          content: JSON.stringify({ articles: [], domainSummaries: {}, indexSummary: '' }),
        };
      } else {
        // Staleness validation response
        yield {
          type: 'assistant',
          content: JSON.stringify(['decisions/auth-strategy']),
        };
      }
    });

    const result = await flushKnowledge('acme', 'widget');

    expect(result.articlesStale).toBe(1);

    // Verify staleness marker was written to the article
    const markerWrite = writeFileCalls.find(
      c =>
        c.path.includes('auth-strategy.md') &&
        c.content.includes('> [!WARNING] This article may be stale')
    );
    expect(markerWrite).toBeDefined();
  });

  test('skips staleness check when no last flush SHA', async () => {
    directories[`${KB_PATH}/logs`] = ['2026-04-11.md'];
    directories[`${KB_PATH}/domains`] = ['patterns'];
    directories[`${KB_PATH}/domains/patterns`] = ['_index.md', 'some-pattern.md'];

    fileSystem[`${KB_PATH}/logs/2026-04-11.md`] = '## Content\n';
    fileSystem[`${KB_PATH}/domains/patterns/_index.md`] = '# Patterns\n';
    fileSystem[`${KB_PATH}/domains/patterns/some-pattern.md`] = '# Some Pattern\n\nContent.\n';

    mockSendQueryChunks = [
      {
        type: 'assistant',
        content: JSON.stringify({ articles: [], domainSummaries: {}, indexSummary: '' }),
      },
    ];

    const result = await flushKnowledge('acme', 'widget');

    // No staleness check because no last flush SHA
    expect(result.articlesStale).toBe(0);

    // Only one sendQuery call (synthesis), no staleness call
    expect(mockSendQuery).toHaveBeenCalledTimes(1);
  });

  test('detects broken wikilinks between articles', async () => {
    directories[`${KB_PATH}/logs`] = ['2026-04-11.md'];
    directories[`${KB_PATH}/domains`] = ['decisions', 'patterns'];
    directories[`${KB_PATH}/domains/decisions`] = ['_index.md', 'auth-strategy.md'];
    directories[`${KB_PATH}/domains/patterns`] = ['_index.md'];

    fileSystem[`${KB_PATH}/logs/2026-04-11.md`] = '## Content\n';
    fileSystem[`${KB_PATH}/domains/decisions/_index.md`] = '# Decisions\n';
    fileSystem[`${KB_PATH}/domains/decisions/auth-strategy.md`] =
      '# Auth Strategy\n\nSee [[patterns/nonexistent-pattern]] and [[decisions/auth-strategy]].\n';

    mockSendQueryChunks = [
      {
        type: 'assistant',
        content: JSON.stringify({ articles: [], domainSummaries: {}, indexSummary: '' }),
      },
    ];

    const result = await flushKnowledge('acme', 'widget');

    // Validation logs should mention broken links
    const validationLog = mockLogger.info.mock.calls.find(
      (call: unknown[]) => (call[1] as string) === 'knowledge.flush_validation_completed'
    );
    expect(validationLog).toBeDefined();
    const logData = validationLog![0] as { brokenLinks: number };
    expect(logData.brokenLinks).toBe(1);
  });

  test('logs validation results', async () => {
    directories[`${KB_PATH}/logs`] = ['2026-04-11.md'];
    directories[`${KB_PATH}/domains`] = ['architecture'];
    directories[`${KB_PATH}/domains/architecture`] = ['_index.md', 'api-design.md'];

    fileSystem[`${KB_PATH}/logs/2026-04-11.md`] = '## Content\n';
    fileSystem[`${KB_PATH}/domains/architecture/_index.md`] = '# Architecture\n';
    fileSystem[`${KB_PATH}/domains/architecture/api-design.md`] =
      '# API Design\n\nREST endpoints.\n';

    mockSendQueryChunks = [
      {
        type: 'assistant',
        content: JSON.stringify({ articles: [], domainSummaries: {}, indexSummary: '' }),
      },
    ];

    await flushKnowledge('acme', 'widget');

    // Validation completed log should include articles checked, stale, broken links
    const validationLog = mockLogger.info.mock.calls.find(
      (call: unknown[]) => (call[1] as string) === 'knowledge.flush_validation_completed'
    );
    expect(validationLog).toBeDefined();
    const data = validationLog![0] as {
      articlesChecked: number;
      articlesFlaggedStale: number;
      brokenLinks: number;
    };
    expect(data.articlesChecked).toBe(1);
    expect(data.articlesFlaggedStale).toBe(0);
    expect(data.brokenLinks).toBe(0);
  });

  test('staleness marker is idempotent', async () => {
    // Set up with a last flush SHA so staleness check runs
    fileSystem[`${KB_PATH}/meta/last-flush.json`] = JSON.stringify({
      timestamp: '2026-04-09T12:00:00Z',
      gitSha: 'oldsha123',
      logsCaptured: ['2026-04-09.md'],
    });

    directories[`${KB_PATH}/logs`] = ['2026-04-10.md'];
    directories[`${KB_PATH}/domains`] = ['decisions'];
    directories[`${KB_PATH}/domains/decisions`] = ['_index.md', 'auth-strategy.md'];

    fileSystem[`${KB_PATH}/logs/2026-04-10.md`] = '## New info\n';
    fileSystem[`${KB_PATH}/domains/decisions/_index.md`] = '# Decisions\n';
    // Article already has staleness marker
    fileSystem[`${KB_PATH}/domains/decisions/auth-strategy.md`] =
      '# Auth Strategy\n\n> [!WARNING] This article may be stale — referenced code has changed since last validation.\n\nContent.\n';

    mockExecFileAsync.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes('rev-parse')) return { stdout: 'newsha\n', stderr: '' };
      if (args.includes('diff')) return { stdout: 'src/auth.ts\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    let callCount = 0;
    mockSendQuery.mockImplementation(function* () {
      callCount++;
      if (callCount === 1) {
        yield {
          type: 'assistant',
          content: JSON.stringify({ articles: [], domainSummaries: {}, indexSummary: '' }),
        };
      } else {
        yield { type: 'assistant', content: JSON.stringify(['decisions/auth-strategy']) };
      }
    });

    await flushKnowledge('acme', 'widget');

    // The marker write should NOT happen since article already has the marker
    const markerWrites = writeFileCalls.filter(
      c =>
        c.path.includes('auth-strategy.md') &&
        c.content.includes('> [!WARNING] This article may be stale')
    );
    // Article already had marker, so writeFile should not be called for marker addition
    expect(markerWrites.length).toBe(0);
  });

  // --- Global KB tier tests ---

  const GLOBAL_KB_PATH = '/home/test/.archon/knowledge';

  test('flushGlobalKnowledge uses global knowledge path', async () => {
    directories[`${GLOBAL_KB_PATH}/logs`] = ['2026-04-11.md'];
    directories[`${GLOBAL_KB_PATH}/domains`] = [];

    fileSystem[`${GLOBAL_KB_PATH}/logs/2026-04-11.md`] =
      '## Global lesson\n- Cross-project pattern\n';

    mockSendQueryChunks = [
      {
        type: 'assistant',
        content: JSON.stringify({
          articles: [
            {
              domain: 'patterns',
              concept: 'cross-project-pattern',
              content: '# Cross Project Pattern\n\nApplies everywhere.\n',
            },
          ],
          domainSummaries: { patterns: 'Cross-project patterns.' },
          indexSummary: 'Global knowledge.',
        }),
      },
    ];

    const result = await flushGlobalKnowledge();

    expect(result.skipped).toBe(false);
    expect(result.articlesCreated).toBe(1);
    expect(result.logsProcessed).toEqual(['2026-04-11.md']);
    expect(mockInitGlobalKnowledgeDir).toHaveBeenCalled();
    expect(mockInitKnowledgeDir).not.toHaveBeenCalled();

    // Articles written to global path
    const articleWrite = writeFileCalls.find(c =>
      c.path.includes('/home/test/.archon/knowledge/.tmp/domains/patterns/cross-project-pattern.md')
    );
    expect(articleWrite).toBeDefined();
  });

  test('flushGlobalKnowledge skips staleness validation (no git repo)', async () => {
    // Set up last-flush with a git SHA (would trigger staleness in project flush)
    fileSystem[`${GLOBAL_KB_PATH}/meta/last-flush.json`] = JSON.stringify({
      timestamp: '2026-04-09T12:00:00Z',
      gitSha: 'someshavalue',
      logsCaptured: ['2026-04-09.md'],
    });

    directories[`${GLOBAL_KB_PATH}/logs`] = ['2026-04-10.md'];
    directories[`${GLOBAL_KB_PATH}/domains`] = ['patterns'];
    directories[`${GLOBAL_KB_PATH}/domains/patterns`] = ['_index.md', 'some-pattern.md'];

    fileSystem[`${GLOBAL_KB_PATH}/logs/2026-04-10.md`] = '## New global info\n';
    fileSystem[`${GLOBAL_KB_PATH}/domains/patterns/_index.md`] = '# Patterns\n';
    fileSystem[`${GLOBAL_KB_PATH}/domains/patterns/some-pattern.md`] =
      '# Some Pattern\n\nContent.\n';

    mockSendQueryChunks = [
      {
        type: 'assistant',
        content: JSON.stringify({ articles: [], domainSummaries: {}, indexSummary: '' }),
      },
    ];

    const result = await flushGlobalKnowledge();

    // No staleness check — only one sendQuery call (synthesis, not staleness)
    expect(result.articlesStale).toBe(0);
    expect(mockSendQuery).toHaveBeenCalledTimes(1);

    // No git diff was requested
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  test('flushGlobalKnowledge stores empty git SHA in last-flush.json', async () => {
    directories[`${GLOBAL_KB_PATH}/logs`] = ['2026-04-11.md'];
    directories[`${GLOBAL_KB_PATH}/domains`] = [];

    fileSystem[`${GLOBAL_KB_PATH}/logs/2026-04-11.md`] = '## Content\n';

    mockSendQueryChunks = [
      {
        type: 'assistant',
        content: JSON.stringify({ articles: [], domainSummaries: {}, indexSummary: '' }),
      },
    ];

    await flushGlobalKnowledge();

    const flushWrite = writeFileCalls.find(
      c => c.path.includes('last-flush.json') && c.path.includes('.archon/knowledge')
    );
    expect(flushWrite).toBeDefined();
    const meta = JSON.parse(flushWrite!.content) as { gitSha: string; logsCaptured: string[] };
    expect(meta.gitSha).toBe('');
    expect(meta.logsCaptured).toEqual(['2026-04-11.md']);
  });

  test('flushGlobalKnowledge operates independently from project flush', async () => {
    // Set up both project and global logs
    directories[`${KB_PATH}/logs`] = ['2026-04-11.md'];
    directories[`${KB_PATH}/domains`] = [];
    fileSystem[`${KB_PATH}/logs/2026-04-11.md`] = '## Project content\n';

    directories[`${GLOBAL_KB_PATH}/logs`] = ['2026-04-11.md'];
    directories[`${GLOBAL_KB_PATH}/domains`] = [];
    fileSystem[`${GLOBAL_KB_PATH}/logs/2026-04-11.md`] = '## Global content\n';

    mockSendQueryChunks = [
      {
        type: 'assistant',
        content: JSON.stringify({ articles: [], domainSummaries: {}, indexSummary: '' }),
      },
    ];

    // Flush global — should NOT touch project KB
    const globalResult = await flushGlobalKnowledge();
    expect(globalResult.skipped).toBe(false);
    expect(mockInitGlobalKnowledgeDir).toHaveBeenCalledTimes(1);
    expect(mockInitKnowledgeDir).not.toHaveBeenCalled();

    // Verify the synthesis prompt includes global log content, not project
    const prompt = mockSendQuery.mock.calls[0]![0] as string;
    expect(prompt).toContain('Global content');
    expect(prompt).not.toContain('Project content');
  });

  test('flushGlobalKnowledge skips when knowledge is disabled', async () => {
    const config = {
      knowledge: { ...defaultKnowledgeConfig, enabled: false },
      assistants: { claude: { model: 'sonnet', settingSources: ['project'] as const }, codex: {} },
      worktree: {},
      docs: { path: 'docs/' },
      defaults: { loadDefaultCommands: true, loadDefaultWorkflows: true },
    };

    const result = await flushGlobalKnowledge(config as never);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain('disabled');
    expect(mockInitGlobalKnowledgeDir).not.toHaveBeenCalled();
    expect(mockSendQuery).not.toHaveBeenCalled();
  });

  test('flushGlobalKnowledge uses codebase-agnostic synthesis prompt with contradiction detection', async () => {
    directories[`${GLOBAL_KB_PATH}/logs`] = ['2026-04-11.md'];
    directories[`${GLOBAL_KB_PATH}/domains`] = [];

    fileSystem[`${GLOBAL_KB_PATH}/logs/2026-04-11.md`] = '## Global pattern\n- Some lesson\n';

    mockSendQueryChunks = [
      {
        type: 'assistant',
        content: JSON.stringify({ articles: [], domainSummaries: {}, indexSummary: '' }),
      },
    ];

    await flushGlobalKnowledge();

    const prompt = mockSendQuery.mock.calls[0]![0] as string;
    // Global prompt should contain codebase-agnostic rules
    expect(prompt).toContain('GLOBAL knowledge base');
    expect(prompt).toContain('codebase-agnostic');
    // Should contain Sources footnotes requirement
    expect(prompt).toContain('## Sources');
    // Should contain contradiction detection
    expect(prompt).toContain('## Contradictions');
    expect(prompt).toContain('contradictory');
  });

  test('flushKnowledge (project) does NOT use global synthesis prompt', async () => {
    directories[`${KB_PATH}/logs`] = ['2026-04-11.md'];
    directories[`${KB_PATH}/domains`] = [];

    fileSystem[`${KB_PATH}/logs/2026-04-11.md`] = '## Content\n';

    mockSendQueryChunks = [
      {
        type: 'assistant',
        content: JSON.stringify({ articles: [], domainSummaries: {}, indexSummary: '' }),
      },
    ];

    await flushKnowledge('acme', 'widget');

    const prompt = mockSendQuery.mock.calls[0]![0] as string;
    // Project prompt should NOT contain global-specific instructions
    expect(prompt).not.toContain('GLOBAL knowledge base');
    expect(prompt).not.toContain('contradictory');
    // But should still contain standard synthesis rules
    expect(prompt).toContain('knowledge base compiler');
  });

  // --- AI JSON parse failure tests ---

  test('throws on malformed JSON from AI synthesis', async () => {
    directories[`${KB_PATH}/logs`] = ['2026-04-11.md'];
    directories[`${KB_PATH}/domains`] = [];

    fileSystem[`${KB_PATH}/logs/2026-04-11.md`] = '## Content\n';

    // AI returns garbage that is not valid JSON
    mockSendQueryChunks = [{ type: 'assistant', content: 'This is not JSON at all!' }];

    await expect(flushKnowledge('acme', 'widget')).rejects.toThrow('invalid JSON');

    // Warning was logged about the parse failure
    const warnMessages = mockLogger.warn.mock.calls.map((call: unknown[]) => call[1] as string);
    expect(warnMessages).toContain('knowledge.flush_synthesis_json_parse_failed');

    // Error was logged at the flush level
    const errorMessages = mockLogger.error.mock.calls.map((call: unknown[]) => call[1] as string);
    expect(errorMessages).toContain('knowledge.flush_failed');

    // Lock was still released despite the error
    const lockUnlink = unlinkCalls.find(p => p.includes('flush.lock'));
    expect(lockUnlink).toBeDefined();
  });

  test('throws on valid JSON with invalid schema from AI synthesis', async () => {
    directories[`${KB_PATH}/logs`] = ['2026-04-11.md'];
    directories[`${KB_PATH}/domains`] = [];

    fileSystem[`${KB_PATH}/logs/2026-04-11.md`] = '## Content\n';

    // AI returns valid JSON but wrong structure (missing required fields)
    mockSendQueryChunks = [
      {
        type: 'assistant',
        content: JSON.stringify({ wrongField: 'not what we expect' }),
      },
    ];

    await expect(flushKnowledge('acme', 'widget')).rejects.toThrow('invalid structure');

    // Warning was logged about schema validation failure
    const warnMessages = mockLogger.warn.mock.calls.map((call: unknown[]) => call[1] as string);
    expect(warnMessages).toContain('knowledge.flush_synthesis_schema_validation_failed');

    // Lock was still released
    const lockUnlink = unlinkCalls.find(p => p.includes('flush.lock'));
    expect(lockUnlink).toBeDefined();
  });

  test('malformed JSON does not write any articles or update flush metadata', async () => {
    directories[`${KB_PATH}/logs`] = ['2026-04-11.md'];
    directories[`${KB_PATH}/domains`] = [];

    fileSystem[`${KB_PATH}/logs/2026-04-11.md`] = '## Content\n';

    // AI returns invalid JSON
    mockSendQueryChunks = [{ type: 'assistant', content: '{broken json' }];

    await expect(flushKnowledge('acme', 'widget')).rejects.toThrow('invalid JSON');

    // No articles were written (only lock file and maybe mkdir calls)
    const articleWrites = writeFileCalls.filter(
      c => c.path.includes('/domains/') || c.path.includes('last-flush.json')
    );
    expect(articleWrites).toHaveLength(0);

    // No renames happened (no atomic writes)
    const articleRenames = renameCalls.filter(
      r => r.newPath.includes('/domains/') || r.newPath.includes('last-flush.json')
    );
    expect(articleRenames).toHaveLength(0);
  });

  test('partial valid JSON array in articles field fails Zod validation', async () => {
    directories[`${KB_PATH}/logs`] = ['2026-04-11.md'];
    directories[`${KB_PATH}/domains`] = [];

    fileSystem[`${KB_PATH}/logs/2026-04-11.md`] = '## Content\n';

    // AI returns JSON that parses but has wrong article shape (missing content field)
    mockSendQueryChunks = [
      {
        type: 'assistant',
        content: JSON.stringify({
          articles: [{ domain: 'decisions', concept: 'test' }], // missing 'content'
          domainSummaries: {},
          indexSummary: '',
        }),
      },
    ];

    await expect(flushKnowledge('acme', 'widget')).rejects.toThrow('invalid structure');

    // Schema validation failure was logged
    const warnMessages = mockLogger.warn.mock.calls.map((call: unknown[]) => call[1] as string);
    expect(warnMessages).toContain('knowledge.flush_synthesis_schema_validation_failed');
  });
});
