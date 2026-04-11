import { mock, describe, test, expect, beforeEach } from 'bun:test';

// Track mkdir calls
const mkdirCalls: Array<{ path: string; options: { recursive: boolean } }> = [];
const mockMkdir = mock(async (path: string, options: { recursive: boolean }) => {
  mkdirCalls.push({ path, options });
  return undefined;
});

// Track writeFile calls
const writeFileCalls: Array<{ path: string; content: string; options: { flag: string } }> = [];
const mockWriteFile = mock(async (path: string, content: string, options: { flag: string }) => {
  writeFileCalls.push({ path, content, options });
  return undefined;
});

mock.module('node:fs/promises', () => ({
  mkdir: mockMkdir,
  writeFile: mockWriteFile,
}));

// Mock @archon/paths
mock.module('@archon/paths', () => ({
  getProjectKnowledgePath: (owner: string, repo: string) =>
    `/home/test/.archon/workspaces/${owner}/${repo}/knowledge`,
  getGlobalKnowledgePath: () => '/home/test/.archon/knowledge',
}));

import {
  initKnowledgeDir,
  initGlobalKnowledgeDir,
  DEFAULT_DOMAINS,
  SCHEMA_TEMPLATE,
  INDEX_TEMPLATE,
  DOMAIN_INDEX_TEMPLATES,
} from './knowledge-init';

describe('knowledge-init', () => {
  beforeEach(() => {
    mkdirCalls.length = 0;
    mockMkdir.mockClear();
    writeFileCalls.length = 0;
    mockWriteFile.mockReset();
    mockWriteFile.mockImplementation(
      async (path: string, content: string, options: { flag: string }) => {
        writeFileCalls.push({ path, content, options });
        return undefined;
      }
    );
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

    test('writes template files with wx flag', async () => {
      await initKnowledgeDir('acme', 'widget');

      const base = '/home/test/.archon/workspaces/acme/widget/knowledge';
      const writtenPaths = writeFileCalls.map(c => c.path);

      // schema.md and index.md
      expect(writtenPaths).toContain(`${base}/meta/schema.md`);
      expect(writtenPaths).toContain(`${base}/index.md`);

      // Domain _index.md files
      for (const domain of DEFAULT_DOMAINS) {
        expect(writtenPaths).toContain(`${base}/domains/${domain}/_index.md`);
      }

      // All writes use 'wx' flag (write-exclusive: fail if exists)
      for (const call of writeFileCalls) {
        expect(call.options.flag).toBe('wx');
      }
    });

    test('writes correct template content', async () => {
      await initKnowledgeDir('acme', 'widget');

      const base = '/home/test/.archon/workspaces/acme/widget/knowledge';

      const schemaCall = writeFileCalls.find(c => c.path === `${base}/meta/schema.md`);
      expect(schemaCall?.content).toBe(SCHEMA_TEMPLATE);

      const indexCall = writeFileCalls.find(c => c.path === `${base}/index.md`);
      expect(indexCall?.content).toBe(INDEX_TEMPLATE);

      for (const domain of DEFAULT_DOMAINS) {
        const domainCall = writeFileCalls.find(
          c => c.path === `${base}/domains/${domain}/_index.md`
        );
        expect(domainCall?.content).toBe(DOMAIN_INDEX_TEMPLATES[domain]);
      }
    });

    test('skips writing if files already exist (EEXIST)', async () => {
      const eexistError = Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
      mockWriteFile.mockRejectedValue(eexistError);

      // Should not throw — EEXIST is silently ignored
      await expect(initKnowledgeDir('acme', 'widget')).resolves.toBeUndefined();
    });

    test('propagates non-EEXIST write errors', async () => {
      const permError = Object.assign(new Error('EACCES'), { code: 'EACCES' });
      mockWriteFile.mockRejectedValue(permError);

      await expect(initKnowledgeDir('acme', 'widget')).rejects.toThrow('EACCES');
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

    test('writes template files at global path', async () => {
      await initGlobalKnowledgeDir();

      const base = '/home/test/.archon/knowledge';
      const writtenPaths = writeFileCalls.map(c => c.path);

      expect(writtenPaths).toContain(`${base}/meta/schema.md`);
      expect(writtenPaths).toContain(`${base}/index.md`);

      for (const domain of DEFAULT_DOMAINS) {
        expect(writtenPaths).toContain(`${base}/domains/${domain}/_index.md`);
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

  describe('templates', () => {
    test('schema template describes KB structure and navigation', () => {
      expect(SCHEMA_TEMPLATE).toContain('# Knowledge Base Schema');
      expect(SCHEMA_TEMPLATE).toContain('[[index]]');
      expect(SCHEMA_TEMPLATE).toContain('[[wikilink]]');
      expect(SCHEMA_TEMPLATE).toContain('architecture');
      expect(SCHEMA_TEMPLATE).toContain('decisions');
      expect(SCHEMA_TEMPLATE).toContain('patterns');
      expect(SCHEMA_TEMPLATE).toContain('lessons');
      expect(SCHEMA_TEMPLATE).toContain('connections');
    });

    test('index template has sections for each domain with wikilinks', () => {
      expect(INDEX_TEMPLATE).toContain('# Knowledge Base Index');
      for (const domain of DEFAULT_DOMAINS) {
        expect(INDEX_TEMPLATE).toContain(`domains/${domain}/_index`);
      }
    });

    test('domain index templates exist for all default domains', () => {
      for (const domain of DEFAULT_DOMAINS) {
        expect(DOMAIN_INDEX_TEMPLATES[domain]).toBeDefined();
        expect(DOMAIN_INDEX_TEMPLATES[domain]).toContain(
          `# ${domain.charAt(0).toUpperCase() + domain.slice(1)}`
        );
      }
    });
  });
});
