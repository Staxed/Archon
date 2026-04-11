import { mock, describe, test, expect, beforeEach } from 'bun:test';

// Track writeFile calls
const writeFileCalls: Array<{ path: string; content: string; options?: unknown }> = [];
const mockWriteFile = mock(async (path: string, content: string, options?: unknown) => {
  writeFileCalls.push({ path, content, options });
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
  getGlobalKnowledgePath: () => '/home/test/.archon/knowledge',
  createLogger: mock(() => mockLogger),
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

import { flushKnowledge } from './knowledge-flush';

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
    mockSendQuery.mockClear();
    mockGetAssistantClient.mockClear();
    Object.values(mockLogger).forEach(fn => fn.mockClear());

    // Reset default mock implementations
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

    // Should only process logs from 2026-04-10 and 2026-04-11 (after 2026-04-09)
    expect(result.logsProcessed).toEqual(['2026-04-10.md', '2026-04-11.md']);

    // Verify the prompt includes only the newer logs
    const prompt = mockSendQuery.mock.calls[0]![0] as string;
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
});
