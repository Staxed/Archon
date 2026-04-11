import { describe, test, expect, mock, beforeEach } from 'bun:test';

// Mock node:fs/promises before importing the module under test
const mockReadFile = mock<(path: string, encoding: string) => Promise<string>>(async () => '');
const mockReaddir = mock<(path: string) => Promise<string[]>>(async () => []);

mock.module('node:fs/promises', () => ({
  readFile: mockReadFile,
  readdir: mockReaddir,
}));

mock.module('@archon/paths', () => ({
  getGlobalKnowledgePath: () => '/home/user/.archon/knowledge',
  getProjectKnowledgePath: (owner: string, repo: string) =>
    `/home/user/.archon/workspaces/${owner}/${repo}/knowledge`,
  parseOwnerRepo: (name: string) => {
    const parts = name.split('/');
    if (parts.length !== 2) return null;
    return { owner: parts[0], repo: parts[1] };
  },
}));

import {
  buildOrchestratorPrompt,
  buildProjectScopedPrompt,
  formatKnowledgeSection,
} from './prompt-builder';
import type { Codebase } from '../types';
import type { WorkflowDefinition } from '@archon/workflows/schemas/workflow';

const makeCodebase = (overrides: Partial<Codebase> = {}): Codebase => ({
  id: 'cb-1',
  name: 'acme/widget',
  repository_url: 'https://github.com/acme/widget',
  default_cwd: '/home/user/.archon/workspaces/acme/widget/source',
  ai_assistant_type: 'claude',
  commands: {},
  created_at: new Date(),
  updated_at: new Date(),
  ...overrides,
});

const emptyWorkflows: WorkflowDefinition[] = [];

describe('formatKnowledgeSection', () => {
  test('returns empty string when both indexes are empty', () => {
    expect(formatKnowledgeSection('', '')).toBe('');
  });

  test('formats global index only', () => {
    const result = formatKnowledgeSection('Global KB content', '');
    expect(result).toContain('## Knowledge Base');
    expect(result).toContain('### Global Knowledge');
    expect(result).toContain('Global KB content');
    expect(result).not.toContain('### Project Knowledge');
  });

  test('formats project index only', () => {
    const result = formatKnowledgeSection('', 'Project KB content');
    expect(result).toContain('## Knowledge Base');
    expect(result).toContain('### Project Knowledge');
    expect(result).toContain('Project KB content');
    expect(result).not.toContain('### Global Knowledge');
  });

  test('formats both indexes with project after global', () => {
    const result = formatKnowledgeSection('Global content', 'Project content');
    expect(result).toContain('### Global Knowledge');
    expect(result).toContain('### Project Knowledge');
    // Project section appears after global
    const globalPos = result.indexOf('### Global Knowledge');
    const projectPos = result.indexOf('### Project Knowledge');
    expect(projectPos).toBeGreaterThan(globalPos);
  });
});

describe('buildOrchestratorPrompt — knowledge loading', () => {
  beforeEach(() => {
    mockReadFile.mockReset();
    mockReadFile.mockImplementation(async () => '');
    mockReaddir.mockReset();
    mockReaddir.mockImplementation(async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
  });

  test('loads global knowledge index', async () => {
    mockReadFile.mockImplementation(async (path: string) => {
      if (path === '/home/user/.archon/knowledge/index.md') {
        return '# Global KB\n\n- Architecture overview\n- Decision log';
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const result = await buildOrchestratorPrompt([], emptyWorkflows);
    expect(result).toContain('## Knowledge Base');
    expect(result).toContain('### Global Knowledge');
    expect(result).toContain('Global KB');
  });

  test('skips knowledge section when no index.md exists', async () => {
    mockReadFile.mockImplementation(async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const result = await buildOrchestratorPrompt([], emptyWorkflows);
    expect(result).not.toContain('## Knowledge Base');
  });

  test('still includes routing rules and projects', async () => {
    mockReadFile.mockImplementation(async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const codebase = makeCodebase();
    const result = await buildOrchestratorPrompt([codebase], emptyWorkflows);
    expect(result).toContain('acme/widget');
    expect(result).toContain('## Routing Rules');
  });

  test('truncates index content that exceeds budget', async () => {
    const longContent = 'x'.repeat(3000);
    mockReadFile.mockImplementation(async (path: string) => {
      if (path === '/home/user/.archon/knowledge/index.md') {
        return longContent;
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const result = await buildOrchestratorPrompt([], emptyWorkflows);
    expect(result).toContain('*(index truncated)*');
    // Should not contain the full 3000-char string
    expect(result).not.toContain(longContent);
  });
});

describe('buildProjectScopedPrompt — knowledge loading', () => {
  beforeEach(() => {
    mockReadFile.mockReset();
    mockReadFile.mockImplementation(async () => '');
    mockReaddir.mockReset();
    mockReaddir.mockImplementation(async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
  });

  test('loads both global and project knowledge indexes', async () => {
    mockReadFile.mockImplementation(async (path: string) => {
      if (path === '/home/user/.archon/knowledge/index.md') {
        return '# Global KB';
      }
      if (path === '/home/user/.archon/workspaces/acme/widget/knowledge/index.md') {
        return '# Project KB';
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const codebase = makeCodebase();
    const result = await buildProjectScopedPrompt(codebase, [codebase], emptyWorkflows);
    expect(result).toContain('### Global Knowledge');
    expect(result).toContain('# Global KB');
    expect(result).toContain('### Project Knowledge');
    expect(result).toContain('# Project KB');
  });

  test('loads project index only when global does not exist', async () => {
    mockReadFile.mockImplementation(async (path: string) => {
      if (path === '/home/user/.archon/workspaces/acme/widget/knowledge/index.md') {
        return '# Project KB';
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const codebase = makeCodebase();
    const result = await buildProjectScopedPrompt(codebase, [codebase], emptyWorkflows);
    expect(result).not.toContain('### Global Knowledge');
    expect(result).toContain('### Project Knowledge');
    expect(result).toContain('# Project KB');
  });

  test('skips project index when codebase name is not owner/repo format', async () => {
    mockReadFile.mockImplementation(async (path: string) => {
      if (path === '/home/user/.archon/knowledge/index.md') {
        return '# Global KB';
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const codebase = makeCodebase({ name: 'local-project' });
    const result = await buildProjectScopedPrompt(codebase, [codebase], emptyWorkflows);
    expect(result).toContain('### Global Knowledge');
    expect(result).not.toContain('### Project Knowledge');
  });

  test('gracefully skips when neither index exists', async () => {
    mockReadFile.mockImplementation(async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const codebase = makeCodebase();
    const result = await buildProjectScopedPrompt(codebase, [codebase], emptyWorkflows);
    expect(result).not.toContain('## Knowledge Base');
    expect(result).toContain('## Routing Rules');
  });

  test('project index appears after global index (project overrides)', async () => {
    mockReadFile.mockImplementation(async (path: string) => {
      if (path === '/home/user/.archon/knowledge/index.md') return 'Global content';
      if (path === '/home/user/.archon/workspaces/acme/widget/knowledge/index.md')
        return 'Project content';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const codebase = makeCodebase();
    const result = await buildProjectScopedPrompt(codebase, [codebase], emptyWorkflows);
    const globalPos = result.indexOf('Global content');
    const projectPos = result.indexOf('Project content');
    expect(globalPos).toBeGreaterThan(-1);
    expect(projectPos).toBeGreaterThan(globalPos);
  });
});

describe('buildProjectScopedPrompt — unprocessed logs fallback', () => {
  beforeEach(() => {
    mockReadFile.mockReset();
    mockReadFile.mockImplementation(async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockReaddir.mockReset();
    mockReaddir.mockImplementation(async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
  });

  test('includes all daily logs when no last-flush.json exists', async () => {
    mockReadFile.mockImplementation(async (path: string) => {
      if (path === '/home/user/.archon/workspaces/acme/widget/knowledge/logs/2026-04-10.md') {
        return '## Decisions\n- Use Haiku for capture\n';
      }
      if (path === '/home/user/.archon/workspaces/acme/widget/knowledge/logs/2026-04-11.md') {
        return '## Patterns\n- Builder pattern for prompts\n';
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockReaddir.mockImplementation(async (path: string) => {
      if (path === '/home/user/.archon/workspaces/acme/widget/knowledge/logs') {
        return ['2026-04-10.md', '2026-04-11.md'];
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const codebase = makeCodebase();
    const result = await buildProjectScopedPrompt(codebase, [codebase], emptyWorkflows);
    expect(result).toContain('### Recent Knowledge (unprocessed)');
    expect(result).toContain('Use Haiku for capture');
    expect(result).toContain('Builder pattern for prompts');
  });

  test('includes only logs newer than last-flush timestamp', async () => {
    mockReadFile.mockImplementation(async (path: string) => {
      if (path === '/home/user/.archon/workspaces/acme/widget/knowledge/meta/last-flush.json') {
        return JSON.stringify({ timestamp: '2026-04-10T12:00:00Z', gitSha: 'abc123' });
      }
      if (path === '/home/user/.archon/workspaces/acme/widget/knowledge/logs/2026-04-11.md') {
        return '## New knowledge\n- Fresh insight\n';
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockReaddir.mockImplementation(async (path: string) => {
      if (path === '/home/user/.archon/workspaces/acme/widget/knowledge/logs') {
        return ['2026-04-09.md', '2026-04-10.md', '2026-04-11.md'];
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const codebase = makeCodebase();
    const result = await buildProjectScopedPrompt(codebase, [codebase], emptyWorkflows);
    expect(result).toContain('### Recent Knowledge (unprocessed)');
    expect(result).toContain('Fresh insight');
    // Should NOT include logs from 2026-04-09 or 2026-04-10 (at or before flush date)
    expect(result).not.toContain('2026-04-09');
  });

  test('truncates logs that exceed token budget', async () => {
    const largeContent = 'x'.repeat(9000);
    mockReadFile.mockImplementation(async (path: string) => {
      if (path === '/home/user/.archon/workspaces/acme/widget/knowledge/logs/2026-04-11.md') {
        return largeContent;
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockReaddir.mockImplementation(async (path: string) => {
      if (path === '/home/user/.archon/workspaces/acme/widget/knowledge/logs') {
        return ['2026-04-11.md'];
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const codebase = makeCodebase();
    const result = await buildProjectScopedPrompt(codebase, [codebase], emptyWorkflows);
    expect(result).toContain('*(log truncated)*');
    expect(result).not.toContain(largeContent);
  });

  test('skips unprocessed logs section when no logs exist', async () => {
    const codebase = makeCodebase();
    const result = await buildProjectScopedPrompt(codebase, [codebase], emptyWorkflows);
    expect(result).not.toContain('### Recent Knowledge (unprocessed)');
  });

  test('shows logs section after knowledge index', async () => {
    mockReadFile.mockImplementation(async (path: string) => {
      if (path === '/home/user/.archon/workspaces/acme/widget/knowledge/index.md') {
        return '# Project Index';
      }
      if (path === '/home/user/.archon/workspaces/acme/widget/knowledge/logs/2026-04-11.md') {
        return '## Log entry';
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockReaddir.mockImplementation(async (path: string) => {
      if (path === '/home/user/.archon/workspaces/acme/widget/knowledge/logs') {
        return ['2026-04-11.md'];
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const codebase = makeCodebase();
    const result = await buildProjectScopedPrompt(codebase, [codebase], emptyWorkflows);
    const indexPos = result.indexOf('# Project Index');
    const logsPos = result.indexOf('### Recent Knowledge (unprocessed)');
    expect(indexPos).toBeGreaterThan(-1);
    expect(logsPos).toBeGreaterThan(indexPos);
  });

  test('falls back to global logs when no project logs exist', async () => {
    mockReadFile.mockImplementation(async (path: string) => {
      if (path === '/home/user/.archon/knowledge/logs/2026-04-11.md') {
        return '## Global log\n- Cross-project insight\n';
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockReaddir.mockImplementation(async (path: string) => {
      if (path === '/home/user/.archon/knowledge/logs') {
        return ['2026-04-11.md'];
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const codebase = makeCodebase();
    const result = await buildProjectScopedPrompt(codebase, [codebase], emptyWorkflows);
    expect(result).toContain('### Recent Knowledge (unprocessed)');
    expect(result).toContain('Cross-project insight');
  });
});
