/**
 * Tests for knowledge lint command
 */
import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';

// Mock filesystem state
let fileSystem: Record<string, string> = {};
let directories: Record<string, string[]> = {};

const mockReadFile = mock(async (path: string) => {
  const p = String(path);
  if (p in fileSystem) return fileSystem[p];
  const err = new Error(`ENOENT: no such file or directory, open '${p}'`) as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  throw err;
});

const mockReaddir = mock(async (path: string) => {
  const p = String(path);
  if (p in directories) return directories[p];
  const err = new Error(
    `ENOENT: no such file or directory, scandir '${p}'`
  ) as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  throw err;
});

mock.module('node:fs/promises', () => ({
  readFile: mockReadFile,
  readdir: mockReaddir,
  writeFile: mock(() => Promise.resolve()),
  mkdir: mock(() => Promise.resolve()),
  rename: mock(() => Promise.resolve()),
  unlink: mock(() => Promise.resolve()),
  rm: mock(() => Promise.resolve()),
}));

const mockGetRemoteUrl = mock(() => Promise.resolve('https://github.com/acme/widget.git'));
const mockToRepoPath = mock((p: string) => p);

mock.module('@archon/git', () => ({
  getRemoteUrl: mockGetRemoteUrl,
  toRepoPath: mockToRepoPath,
  execFileAsync: mock(() => Promise.resolve({ stdout: '', stderr: '' })),
}));

const PROJECT_KB = '/home/user/.archon/workspaces/acme/widget/knowledge';

mock.module('@archon/paths', () => ({
  createLogger: mock(() => ({
    fatal: mock(() => undefined),
    error: mock(() => undefined),
    warn: mock(() => undefined),
    info: mock(() => undefined),
    debug: mock(() => undefined),
    trace: mock(() => undefined),
  })),
  parseOwnerRepo: (name: string) => {
    const parts = name.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    return { owner: parts[0], repo: parts[1] };
  },
  getProjectKnowledgePath: (_owner: string, _repo: string) => PROJECT_KB,
  getGlobalKnowledgePath: () => '/home/user/.archon/knowledge',
  getProjectSourcePath: (_owner: string, _repo: string) =>
    '/home/user/.archon/workspaces/acme/widget/source',
}));

// Mock the flush module's AI-dependent functions
const mockIdentifyStaleArticles = mock(async () => [] as string[]);
const mockCollectAllArticles = mock(async (knowledgePath: string) => {
  const domainsDir = `${knowledgePath}/domains`;
  const articles: { key: string; content: string }[] = [];

  let domains: string[];
  try {
    domains = (await mockReaddir(domainsDir)) as string[];
  } catch {
    return [];
  }

  for (const domain of domains) {
    let files: string[];
    try {
      files = (await mockReaddir(`${domainsDir}/${domain}`)) as string[];
    } catch {
      continue;
    }
    for (const file of files) {
      if (file === '_index.md' || !file.endsWith('.md')) continue;
      try {
        const content = (await mockReadFile(`${domainsDir}/${domain}/${file}`)) as string;
        const concept = file.replace('.md', '');
        articles.push({ key: `${domain}/${concept}`, content });
      } catch {
        continue;
      }
    }
  }
  return articles;
});

const mockCheckBrokenWikilinks = mock((articles: { key: string; content: string }[]) => {
  const articleKeys = new Set(articles.map(a => a.key));
  const brokenLinks: { source: string; target: string }[] = [];
  const wikilinkPattern = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

  for (const article of articles) {
    let match: RegExpExecArray | null;
    wikilinkPattern.lastIndex = 0;
    while ((match = wikilinkPattern.exec(article.content)) !== null) {
      const target = match[1];
      if (!target || target.includes('_index')) continue;
      const normalizedTarget = target.replace(/^domains\//, '');
      if (normalizedTarget.includes('/') && !articleKeys.has(normalizedTarget)) {
        brokenLinks.push({ source: article.key, target: normalizedTarget });
      }
    }
  }
  return brokenLinks;
});

const mockReadLastFlush = mock(async (knowledgePath: string) => {
  try {
    const content = (await mockReadFile(`${knowledgePath}/meta/last-flush.json`)) as string;
    return JSON.parse(content) as { timestamp: string; gitSha: string; logsCaptured: string[] };
  } catch {
    return null;
  }
});

const mockGetGitDiffNameOnly = mock(async () => '');

mock.module('@archon/core/services/knowledge-flush', () => ({
  flushKnowledge: mock(() => Promise.resolve({})),
  collectAllArticles: mockCollectAllArticles,
  checkBrokenWikilinks: mockCheckBrokenWikilinks,
  identifyStaleArticles: mockIdentifyStaleArticles,
  readLastFlush: mockReadLastFlush,
  getGitDiffNameOnly: mockGetGitDiffNameOnly,
  getCurrentGitSha: mock(async () => ''),
}));

mock.module('@archon/core', () => ({
  loadConfig: mock(() =>
    Promise.resolve({
      knowledge: {
        enabled: true,
        captureModel: 'haiku',
        compileModel: 'sonnet',
        flushDebounceMinutes: 10,
        domains: ['architecture', 'decisions', 'patterns', 'lessons', 'connections'],
      },
    })
  ),
}));

mock.module('node:path', () => ({
  join: (...parts: string[]) => parts.join('/'),
}));

// Import AFTER mocks
import { knowledgeLintCommand } from './knowledge';

describe('knowledgeLintCommand', () => {
  let stderrSpy: ReturnType<typeof spyOn>;
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    fileSystem = {};
    directories = {};
    mockReadFile.mockReset();
    mockReaddir.mockReset();
    mockGetRemoteUrl.mockReset();
    mockToRepoPath.mockReset();
    mockIdentifyStaleArticles.mockReset();
    mockGetGitDiffNameOnly.mockReset();

    mockReadFile.mockImplementation(async (path: string) => {
      const p = String(path);
      if (p in fileSystem) return fileSystem[p];
      const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });

    mockReaddir.mockImplementation(async (path: string) => {
      const p = String(path);
      if (p in directories) return directories[p];
      const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });

    mockGetRemoteUrl.mockResolvedValue('https://github.com/acme/widget.git');
    mockToRepoPath.mockImplementation((p: string) => p);
    mockIdentifyStaleArticles.mockResolvedValue([]);
    mockGetGitDiffNameOnly.mockResolvedValue('');

    stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('should return 0 for empty KB (no articles)', async () => {
    const exitCode = await knowledgeLintCommand('/repo', 'acme/widget');

    expect(exitCode).toBe(0);
    const output = stderrSpy.mock.calls.map(c => String(c[0])).join('');
    expect(output).toContain('Articles checked:    0');
  });

  it('should return 0 for clean KB (no issues)', async () => {
    directories[`${PROJECT_KB}/domains`] = ['architecture'];
    directories[`${PROJECT_KB}/domains/architecture`] = ['_index.md', 'overview.md'];
    fileSystem[`${PROJECT_KB}/domains/architecture/_index.md`] =
      '# Architecture\n\n## Articles\n\n- [[architecture/overview|Overview]]\n';
    fileSystem[`${PROJECT_KB}/domains/architecture/overview.md`] = '# Overview\nClean article.';

    const exitCode = await knowledgeLintCommand('/repo', 'acme/widget');

    expect(exitCode).toBe(0);
    const output = stderrSpy.mock.calls.map(c => String(c[0])).join('');
    expect(output).toContain('Articles checked:    1');
    expect(output).toContain('Stale articles:      0');
    expect(output).toContain('Broken wikilinks:    0');
    expect(output).toContain('Orphaned articles:   0');
  });

  it('should detect broken wikilinks', async () => {
    directories[`${PROJECT_KB}/domains`] = ['decisions'];
    directories[`${PROJECT_KB}/domains/decisions`] = ['_index.md', 'auth-strategy.md'];
    fileSystem[`${PROJECT_KB}/domains/decisions/_index.md`] =
      '# Decisions\n\n## Articles\n\n- [[decisions/auth-strategy|Auth Strategy]]\n';
    fileSystem[`${PROJECT_KB}/domains/decisions/auth-strategy.md`] =
      '# Auth Strategy\nSee [[decisions/nonexistent-article|Missing]] for details.';

    const exitCode = await knowledgeLintCommand('/repo', 'acme/widget');

    expect(exitCode).toBe(1);
    const output = stderrSpy.mock.calls.map(c => String(c[0])).join('');
    expect(output).toContain('Broken wikilinks (1)');
    expect(output).toContain('decisions/auth-strategy');
    expect(output).toContain('decisions/nonexistent-article');
  });

  it('should detect orphaned articles not in _index.md', async () => {
    directories[`${PROJECT_KB}/domains`] = ['patterns'];
    directories[`${PROJECT_KB}/domains/patterns`] = ['_index.md', 'tracked.md', 'orphan.md'];
    fileSystem[`${PROJECT_KB}/domains/patterns/_index.md`] =
      '# Patterns\n\n## Articles\n\n- [[patterns/tracked|Tracked]]\n';
    fileSystem[`${PROJECT_KB}/domains/patterns/tracked.md`] = '# Tracked\nContent.';
    fileSystem[`${PROJECT_KB}/domains/patterns/orphan.md`] = '# Orphan\nNot referenced.';

    const exitCode = await knowledgeLintCommand('/repo', 'acme/widget');

    expect(exitCode).toBe(1);
    const output = stderrSpy.mock.calls.map(c => String(c[0])).join('');
    expect(output).toContain('Orphaned articles (1)');
    expect(output).toContain('patterns/orphan');
  });

  it('should detect stale articles when git SHA exists', async () => {
    fileSystem[`${PROJECT_KB}/meta/last-flush.json`] = JSON.stringify({
      timestamp: '2026-04-10T10:00:00.000Z',
      gitSha: 'abc123',
      logsCaptured: ['2026-04-10.md'],
    });
    directories[`${PROJECT_KB}/domains`] = ['architecture'];
    directories[`${PROJECT_KB}/domains/architecture`] = ['_index.md', 'db-schema.md'];
    fileSystem[`${PROJECT_KB}/domains/architecture/_index.md`] =
      '# Architecture\n\n## Articles\n\n- [[architecture/db-schema|DB Schema]]\n';
    fileSystem[`${PROJECT_KB}/domains/architecture/db-schema.md`] =
      '# DB Schema\nReferences src/db/schema.ts.';

    mockGetGitDiffNameOnly.mockResolvedValue('src/db/schema.ts\nsrc/utils/helpers.ts');
    mockIdentifyStaleArticles.mockResolvedValue(['architecture/db-schema']);

    const exitCode = await knowledgeLintCommand('/repo', 'acme/widget');

    expect(exitCode).toBe(1);
    const output = stderrSpy.mock.calls.map(c => String(c[0])).join('');
    expect(output).toContain('Stale articles (1)');
    expect(output).toContain('architecture/db-schema');
  });

  it('should skip staleness check when no git SHA in last-flush', async () => {
    directories[`${PROJECT_KB}/domains`] = ['lessons'];
    directories[`${PROJECT_KB}/domains/lessons`] = ['_index.md', 'testing.md'];
    fileSystem[`${PROJECT_KB}/domains/lessons/_index.md`] =
      '# Lessons\n\n## Articles\n\n- [[lessons/testing|Testing]]\n';
    fileSystem[`${PROJECT_KB}/domains/lessons/testing.md`] = '# Testing\nBe careful with mocks.';

    const exitCode = await knowledgeLintCommand('/repo', 'acme/widget');

    expect(exitCode).toBe(0);
    expect(mockIdentifyStaleArticles).not.toHaveBeenCalled();
  });

  it('should output JSON with --json flag', async () => {
    directories[`${PROJECT_KB}/domains`] = ['decisions'];
    directories[`${PROJECT_KB}/domains/decisions`] = ['_index.md', 'auth.md', 'orphan.md'];
    fileSystem[`${PROJECT_KB}/domains/decisions/_index.md`] =
      '# Decisions\n\n## Articles\n\n- [[decisions/auth|Auth]]\n';
    fileSystem[`${PROJECT_KB}/domains/decisions/auth.md`] =
      '# Auth\nSee [[decisions/missing|Missing]].';
    fileSystem[`${PROJECT_KB}/domains/decisions/orphan.md`] = '# Orphan\nNot indexed.';

    const exitCode = await knowledgeLintCommand('/repo', 'acme/widget', true);

    expect(exitCode).toBe(1);
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0] as string) as {
      articlesChecked: number;
      staleArticles: string[];
      brokenWikilinks: { source: string; target: string }[];
      orphanedArticles: string[];
    };
    expect(jsonOutput.articlesChecked).toBe(2);
    expect(jsonOutput.brokenWikilinks).toHaveLength(1);
    expect(jsonOutput.brokenWikilinks[0].source).toBe('decisions/auth');
    expect(jsonOutput.brokenWikilinks[0].target).toBe('decisions/missing');
    expect(jsonOutput.orphanedArticles).toEqual(['decisions/orphan']);
  });

  it('should suppress output in quiet mode', async () => {
    directories[`${PROJECT_KB}/domains`] = ['architecture'];
    directories[`${PROJECT_KB}/domains/architecture`] = ['_index.md', 'overview.md'];
    fileSystem[`${PROJECT_KB}/domains/architecture/_index.md`] =
      '# Architecture\n\n- [[architecture/overview|Overview]]\n';
    fileSystem[`${PROJECT_KB}/domains/architecture/overview.md`] = '# Overview\nContent.';

    const exitCode = await knowledgeLintCommand('/repo', 'acme/widget', false, true);

    expect(exitCode).toBe(0);
    // Only Pino logger output (JSON strings) should appear, no user-facing output
    const nonLogOutput = stderrSpy.mock.calls
      .map(c => String(c[0]))
      .filter(s => !s.startsWith('{'));
    expect(nonLogOutput).toEqual([]);
  });

  it('should return 1 on invalid --project format', async () => {
    const exitCode = await knowledgeLintCommand('/repo', 'invalid');

    expect(exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it('should detect multiple issues simultaneously', async () => {
    fileSystem[`${PROJECT_KB}/meta/last-flush.json`] = JSON.stringify({
      timestamp: '2026-04-10T10:00:00.000Z',
      gitSha: 'def456',
      logsCaptured: [],
    });
    directories[`${PROJECT_KB}/domains`] = ['architecture', 'patterns'];
    directories[`${PROJECT_KB}/domains/architecture`] = ['_index.md', 'stale-arch.md'];
    directories[`${PROJECT_KB}/domains/patterns`] = ['_index.md', 'good.md', 'orphan-pattern.md'];
    fileSystem[`${PROJECT_KB}/domains/architecture/_index.md`] =
      '# Architecture\n\n- [[architecture/stale-arch|Stale Arch]]\n';
    fileSystem[`${PROJECT_KB}/domains/architecture/stale-arch.md`] =
      '# Stale Arch\nSee [[patterns/nonexistent|Missing]].';
    fileSystem[`${PROJECT_KB}/domains/patterns/_index.md`] =
      '# Patterns\n\n- [[patterns/good|Good]]\n';
    fileSystem[`${PROJECT_KB}/domains/patterns/good.md`] = '# Good\nNo issues.';
    fileSystem[`${PROJECT_KB}/domains/patterns/orphan-pattern.md`] = '# Orphan Pattern\nLost.';

    mockGetGitDiffNameOnly.mockResolvedValue('src/arch/main.ts');
    mockIdentifyStaleArticles.mockResolvedValue(['architecture/stale-arch']);

    const exitCode = await knowledgeLintCommand('/repo', 'acme/widget');

    expect(exitCode).toBe(1);
    const output = stderrSpy.mock.calls.map(c => String(c[0])).join('');
    expect(output).toContain('Stale articles (1)');
    expect(output).toContain('Broken wikilinks (1)');
    expect(output).toContain('Orphaned articles (1)');
  });
});
