/**
 * Tests for knowledge commands
 */
import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import type { KnowledgeFlushReport } from '@archon/core/services/knowledge-flush';

const mockFlushKnowledge =
  mock<(owner: string, repo: string, config?: unknown) => Promise<KnowledgeFlushReport>>();

const mockLoadConfig = mock(() =>
  Promise.resolve({
    knowledge: {
      enabled: true,
      captureModel: 'haiku',
      compileModel: 'sonnet',
      flushDebounceMinutes: 10,
      domains: ['architecture', 'decisions', 'patterns', 'lessons', 'connections'],
    },
  })
);

const mockGetRemoteUrl = mock(() => Promise.resolve('https://github.com/acme/widget.git'));
const mockToRepoPath = mock((p: string) => p);

const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
};

mock.module('@archon/core/services/knowledge-flush', () => ({
  flushKnowledge: mockFlushKnowledge,
}));

mock.module('@archon/core', () => ({
  loadConfig: mockLoadConfig,
}));

mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  parseOwnerRepo: (name: string) => {
    const parts = name.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    return { owner: parts[0], repo: parts[1] };
  },
}));

mock.module('@archon/git', () => ({
  getRemoteUrl: mockGetRemoteUrl,
  toRepoPath: mockToRepoPath,
}));

// Import AFTER mocks
import { knowledgeFlushCommand } from './knowledge';

describe('knowledgeFlushCommand', () => {
  let stderrSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    mockFlushKnowledge.mockReset();
    mockLoadConfig.mockReset();
    mockGetRemoteUrl.mockReset();
    mockToRepoPath.mockReset();

    mockLoadConfig.mockResolvedValue({
      knowledge: {
        enabled: true,
        captureModel: 'haiku',
        compileModel: 'sonnet',
        flushDebounceMinutes: 10,
        domains: ['architecture', 'decisions', 'patterns', 'lessons', 'connections'],
      },
    } as never);

    mockGetRemoteUrl.mockResolvedValue('https://github.com/acme/widget.git');
    mockToRepoPath.mockImplementation((p: string) => p);

    stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('should flush with --project flag', async () => {
    const report: KnowledgeFlushReport = {
      articlesCreated: 2,
      articlesUpdated: 1,
      articlesStale: 0,
      domainsCreated: ['architecture'],
      logsProcessed: ['2026-04-11.md'],
      skipped: false,
    };
    mockFlushKnowledge.mockResolvedValue(report);

    const exitCode = await knowledgeFlushCommand('/repo', 'acme/widget');

    expect(exitCode).toBe(0);
    expect(mockFlushKnowledge).toHaveBeenCalledTimes(1);
    expect(mockFlushKnowledge.mock.calls[0][0]).toBe('acme');
    expect(mockFlushKnowledge.mock.calls[0][1]).toBe('widget');
  });

  it('should resolve owner/repo from git remote when no --project', async () => {
    const report: KnowledgeFlushReport = {
      articlesCreated: 0,
      articlesUpdated: 0,
      articlesStale: 0,
      domainsCreated: [],
      logsProcessed: [],
      skipped: true,
      skipReason: 'No unprocessed logs to flush',
    };
    mockFlushKnowledge.mockResolvedValue(report);

    const exitCode = await knowledgeFlushCommand('/repo');

    expect(exitCode).toBe(0);
    expect(mockGetRemoteUrl).toHaveBeenCalledTimes(1);
    expect(mockFlushKnowledge).toHaveBeenCalledTimes(1);
    expect(mockFlushKnowledge.mock.calls[0][0]).toBe('acme');
    expect(mockFlushKnowledge.mock.calls[0][1]).toBe('widget');
  });

  it('should display flush results', async () => {
    const report: KnowledgeFlushReport = {
      articlesCreated: 3,
      articlesUpdated: 2,
      articlesStale: 1,
      domainsCreated: ['patterns', 'lessons'],
      logsProcessed: ['2026-04-10.md', '2026-04-11.md'],
      skipped: false,
    };
    mockFlushKnowledge.mockResolvedValue(report);

    await knowledgeFlushCommand('/repo', 'acme/widget');

    // Check stderr output contains report details
    const output = stderrSpy.mock.calls.map(c => c[0]).join('');
    expect(output).toContain('Articles created:  3');
    expect(output).toContain('Articles updated:  2');
    expect(output).toContain('Articles stale:    1');
    expect(output).toContain('patterns, lessons');
    expect(output).toContain('Logs processed:    2');
  });

  it('should display skip reason when skipped', async () => {
    const report: KnowledgeFlushReport = {
      articlesCreated: 0,
      articlesUpdated: 0,
      articlesStale: 0,
      domainsCreated: [],
      logsProcessed: [],
      skipped: true,
      skipReason: 'Knowledge is disabled',
    };
    mockFlushKnowledge.mockResolvedValue(report);

    await knowledgeFlushCommand('/repo', 'acme/widget');

    const output = stderrSpy.mock.calls.map(c => c[0]).join('');
    expect(output).toContain('Skipped: Knowledge is disabled');
  });

  it('should suppress output in quiet mode', async () => {
    const report: KnowledgeFlushReport = {
      articlesCreated: 1,
      articlesUpdated: 0,
      articlesStale: 0,
      domainsCreated: [],
      logsProcessed: ['2026-04-11.md'],
      skipped: false,
    };
    mockFlushKnowledge.mockResolvedValue(report);

    await knowledgeFlushCommand('/repo', 'acme/widget', true);

    // No progress/report output in quiet mode (ignore pino logger output)
    const output = stderrSpy.mock.calls.map(c => String(c[0])).filter(s => !s.startsWith('{'));
    expect(output).toEqual([]);
  });

  it('should return 1 on invalid --project format', async () => {
    const exitCode = await knowledgeFlushCommand('/repo', 'invalid');

    expect(exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(mockFlushKnowledge).not.toHaveBeenCalled();
  });

  it('should return 1 when flush throws', async () => {
    mockFlushKnowledge.mockRejectedValue(new Error('AI client unavailable'));

    const exitCode = await knowledgeFlushCommand('/repo', 'acme/widget');

    expect(exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it('should return 1 when no git remote found', async () => {
    mockGetRemoteUrl.mockResolvedValue(null);

    const exitCode = await knowledgeFlushCommand('/repo');

    expect(exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(mockFlushKnowledge).not.toHaveBeenCalled();
  });
});
