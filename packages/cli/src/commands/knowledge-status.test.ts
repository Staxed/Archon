/**
 * Tests for knowledge status command
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
}));

const PROJECT_KB = '/home/user/.archon/workspaces/acme/widget/knowledge';
const GLOBAL_KB = '/home/user/.archon/knowledge';

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
  getGlobalKnowledgePath: () => GLOBAL_KB,
}));

mock.module('@archon/core/services/knowledge-flush', () => ({
  flushKnowledge: mock(() => Promise.resolve({})),
}));

mock.module('@archon/core', () => ({
  loadConfig: mock(() => Promise.resolve({})),
}));

mock.module('node:path', () => ({
  join: (...parts: string[]) => parts.join('/'),
}));

// Import AFTER mocks
import { knowledgeStatusCommand } from './knowledge';

describe('knowledgeStatusCommand', () => {
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

    stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('should display stats for empty KB', async () => {
    const exitCode = await knowledgeStatusCommand('/repo', 'acme/widget');

    expect(exitCode).toBe(0);
    const output = stderrSpy.mock.calls.map(c => String(c[0])).join('');
    expect(output).toContain('Project KB (acme/widget)');
    expect(output).toContain('Total articles:       0');
    expect(output).toContain('Last flush:           never');
    expect(output).toContain('Unprocessed logs:     0');
    expect(output).toContain('Stale articles:       0');
    expect(output).toContain('Global KB');
  });

  it('should count articles per domain', async () => {
    directories[`${PROJECT_KB}/domains`] = ['architecture', 'decisions'];
    directories[`${PROJECT_KB}/domains/architecture`] = [
      '_index.md',
      'auth-flow.md',
      'db-schema.md',
    ];
    directories[`${PROJECT_KB}/domains/decisions`] = ['_index.md', 'token-strategy.md'];
    fileSystem[`${PROJECT_KB}/domains/architecture/auth-flow.md`] = '# Auth Flow\nContent here.';
    fileSystem[`${PROJECT_KB}/domains/architecture/db-schema.md`] = '# DB Schema\nContent here.';
    fileSystem[`${PROJECT_KB}/domains/decisions/token-strategy.md`] = '# Token Strategy\nContent.';

    const exitCode = await knowledgeStatusCommand('/repo', 'acme/widget');

    expect(exitCode).toBe(0);
    const output = stderrSpy.mock.calls.map(c => String(c[0])).join('');
    expect(output).toContain('Total articles:       3');
    expect(output).toContain('architecture: 2');
    expect(output).toContain('decisions: 1');
  });

  it('should show last flush timestamp', async () => {
    fileSystem[`${PROJECT_KB}/meta/last-flush.json`] = JSON.stringify({
      timestamp: '2026-04-11T10:30:00.000Z',
      gitSha: 'abc123',
      logsCaptured: ['2026-04-11.md'],
    });

    const exitCode = await knowledgeStatusCommand('/repo', 'acme/widget');

    expect(exitCode).toBe(0);
    const output = stderrSpy.mock.calls.map(c => String(c[0])).join('');
    expect(output).toContain('Last flush:           2026-04-11T10:30:00.000Z');
  });

  it('should count unprocessed logs since last flush', async () => {
    fileSystem[`${PROJECT_KB}/meta/last-flush.json`] = JSON.stringify({
      timestamp: '2026-04-09T10:00:00.000Z',
      gitSha: '',
      logsCaptured: ['2026-04-09.md'],
    });
    directories[`${PROJECT_KB}/logs`] = [
      '2026-04-08.md',
      '2026-04-09.md',
      '2026-04-10.md',
      '2026-04-11.md',
    ];

    const exitCode = await knowledgeStatusCommand('/repo', 'acme/widget');

    expect(exitCode).toBe(0);
    const output = stderrSpy.mock.calls.map(c => String(c[0])).join('');
    // Logs newer than 2026-04-09: 2026-04-10.md and 2026-04-11.md
    expect(output).toContain('Unprocessed logs:     2');
  });

  it('should count all logs as unprocessed when no last-flush exists', async () => {
    directories[`${PROJECT_KB}/logs`] = ['2026-04-10.md', '2026-04-11.md'];

    const exitCode = await knowledgeStatusCommand('/repo', 'acme/widget');

    expect(exitCode).toBe(0);
    const output = stderrSpy.mock.calls.map(c => String(c[0])).join('');
    expect(output).toContain('Unprocessed logs:     2');
  });

  it('should count stale articles', async () => {
    directories[`${PROJECT_KB}/domains`] = ['patterns'];
    directories[`${PROJECT_KB}/domains/patterns`] = ['_index.md', 'fresh.md', 'stale-one.md'];
    fileSystem[`${PROJECT_KB}/domains/patterns/fresh.md`] = '# Fresh\nNot stale content.';
    fileSystem[`${PROJECT_KB}/domains/patterns/stale-one.md`] =
      '# Stale One\n\n> [!WARNING] This article may be stale — referenced code has changed.\n\nContent.';

    const exitCode = await knowledgeStatusCommand('/repo', 'acme/widget');

    expect(exitCode).toBe(0);
    const output = stderrSpy.mock.calls.map(c => String(c[0])).join('');
    expect(output).toContain('Stale articles:       1');
  });

  it('should output JSON with --json flag', async () => {
    fileSystem[`${PROJECT_KB}/meta/last-flush.json`] = JSON.stringify({
      timestamp: '2026-04-11T10:30:00.000Z',
      gitSha: 'abc123',
      logsCaptured: [],
    });
    directories[`${PROJECT_KB}/domains`] = ['architecture'];
    directories[`${PROJECT_KB}/domains/architecture`] = ['_index.md', 'overview.md'];
    fileSystem[`${PROJECT_KB}/domains/architecture/overview.md`] = '# Overview\nContent.';

    const exitCode = await knowledgeStatusCommand('/repo', 'acme/widget', true);

    expect(exitCode).toBe(0);
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0] as string) as {
      project: {
        totalArticles: number;
        owner: string;
        repo: string;
        articlesPerDomain: Record<string, number>;
        lastFlushTimestamp: string;
      };
      global: { totalArticles: number };
    };
    expect(jsonOutput.project.totalArticles).toBe(1);
    expect(jsonOutput.project.owner).toBe('acme');
    expect(jsonOutput.project.repo).toBe('widget');
    expect(jsonOutput.project.articlesPerDomain.architecture).toBe(1);
    expect(jsonOutput.project.lastFlushTimestamp).toBe('2026-04-11T10:30:00.000Z');
    expect(jsonOutput.global.totalArticles).toBe(0);
  });

  it('should suppress output in quiet mode', async () => {
    const exitCode = await knowledgeStatusCommand('/repo', 'acme/widget', false, true);

    expect(exitCode).toBe(0);
    const output = stderrSpy.mock.calls.map(c => String(c[0])).filter(s => !s.startsWith('{'));
    expect(output).toEqual([]);
  });

  it('should show global KB stats', async () => {
    directories[`${GLOBAL_KB}/domains`] = ['lessons'];
    directories[`${GLOBAL_KB}/domains/lessons`] = ['_index.md', 'testing-tips.md'];
    fileSystem[`${GLOBAL_KB}/domains/lessons/testing-tips.md`] = '# Testing Tips\nContent.';
    directories[`${GLOBAL_KB}/logs`] = ['2026-04-11.md'];

    const exitCode = await knowledgeStatusCommand('/repo', 'acme/widget');

    expect(exitCode).toBe(0);
    const output = stderrSpy.mock.calls.map(c => String(c[0])).join('');
    expect(output).toContain('Global KB');
    expect(output).toContain('lessons: 1');
  });

  it('should return 1 on invalid --project format', async () => {
    const exitCode = await knowledgeStatusCommand('/repo', 'invalid');

    expect(exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});
