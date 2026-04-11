import { mock, describe, test, expect, beforeEach } from 'bun:test';

// Track mkdir calls
const mkdirCalls: Array<{ path: string; options: { recursive: boolean } }> = [];
const mockMkdir = mock(async (path: string, options: { recursive: boolean }) => {
  mkdirCalls.push({ path, options });
  return undefined;
});

mock.module('node:fs/promises', () => ({
  mkdir: mockMkdir,
}));

// Mock @archon/paths
mock.module('@archon/paths', () => ({
  getProjectKnowledgePath: (owner: string, repo: string) =>
    `/home/test/.archon/workspaces/${owner}/${repo}/knowledge`,
  getGlobalKnowledgePath: () => '/home/test/.archon/knowledge',
}));

import { initKnowledgeDir, initGlobalKnowledgeDir, DEFAULT_DOMAINS } from './knowledge-init';

describe('knowledge-init', () => {
  beforeEach(() => {
    mkdirCalls.length = 0;
    mockMkdir.mockClear();
  });

  describe('initKnowledgeDir', () => {
    test('creates full directory tree for a project', async () => {
      await initKnowledgeDir('acme', 'widget');

      const base = '/home/test/.archon/workspaces/acme/widget/knowledge';
      const createdPaths = mkdirCalls.map(c => c.path);

      // Top-level dirs
      expect(createdPaths).toContain(base);
      expect(createdPaths).toContain(`${base}/meta`);
      expect(createdPaths).toContain(`${base}/logs`);
      expect(createdPaths).toContain(`${base}/domains`);

      // Domain subdirs
      for (const domain of DEFAULT_DOMAINS) {
        expect(createdPaths).toContain(`${base}/domains/${domain}`);
      }
    });

    test('all mkdir calls use recursive: true', async () => {
      await initKnowledgeDir('acme', 'widget');

      for (const call of mkdirCalls) {
        expect(call.options.recursive).toBe(true);
      }
    });

    test('is idempotent (can be called multiple times)', async () => {
      await initKnowledgeDir('acme', 'widget');
      const firstCount = mkdirCalls.length;

      await initKnowledgeDir('acme', 'widget');
      // Should make the same calls again without error (mkdir recursive is idempotent)
      expect(mkdirCalls.length).toBe(firstCount * 2);
    });
  });

  describe('initGlobalKnowledgeDir', () => {
    test('creates full directory tree at global path', async () => {
      await initGlobalKnowledgeDir();

      const base = '/home/test/.archon/knowledge';
      const createdPaths = mkdirCalls.map(c => c.path);

      // Top-level dirs
      expect(createdPaths).toContain(base);
      expect(createdPaths).toContain(`${base}/meta`);
      expect(createdPaths).toContain(`${base}/logs`);
      expect(createdPaths).toContain(`${base}/domains`);

      // Domain subdirs
      for (const domain of DEFAULT_DOMAINS) {
        expect(createdPaths).toContain(`${base}/domains/${domain}`);
      }
    });

    test('all mkdir calls use recursive: true', async () => {
      await initGlobalKnowledgeDir();

      for (const call of mkdirCalls) {
        expect(call.options.recursive).toBe(true);
      }
    });
  });

  describe('DEFAULT_DOMAINS', () => {
    test('contains all starting domains', () => {
      expect(DEFAULT_DOMAINS).toContain('architecture');
      expect(DEFAULT_DOMAINS).toContain('decisions');
      expect(DEFAULT_DOMAINS).toContain('patterns');
      expect(DEFAULT_DOMAINS).toContain('lessons');
      expect(DEFAULT_DOMAINS).toContain('connections');
      expect(DEFAULT_DOMAINS).toHaveLength(5);
    });
  });
});
