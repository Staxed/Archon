import { describe, expect, test, beforeEach } from 'bun:test';
import {
  loadWorkspace,
  saveWorkspace,
  addRootToWorkspace,
  removeRootFromWorkspace,
  pathBasename,
  buildBreadcrumbs,
} from './AddFolderModal';
import type { WorkspaceData } from './AddFolderModal';
import type { TreeRoot } from './FileTree';

// ── Mock localStorage ────────────────────────────────────────

const storage = new Map<string, string>();

const mockLocalStorage = {
  getItem: (key: string): string | null => storage.get(key) ?? null,
  setItem: (key: string, value: string): void => {
    storage.set(key, value);
  },
  removeItem: (key: string): void => {
    storage.delete(key);
  },
  clear: (): void => {
    storage.clear();
  },
  get length(): number {
    return storage.size;
  },
  key: (_index: number): string | null => null,
};

// @ts-expect-error — assigning mock localStorage for testing
globalThis.localStorage = mockLocalStorage;

beforeEach(() => {
  storage.clear();
});

// ── pathBasename tests ───────────────────────────────────────

describe('pathBasename', () => {
  test('returns last segment', () => {
    expect(pathBasename('/home/staxed/projects')).toBe('projects');
  });

  test('handles trailing slash', () => {
    expect(pathBasename('/home/staxed/projects/')).toBe('projects');
  });

  test('returns / for root', () => {
    expect(pathBasename('/')).toBe('/');
  });

  test('returns single segment', () => {
    expect(pathBasename('/foo')).toBe('foo');
  });
});

// ── buildBreadcrumbs tests ───────────────────────────────────

describe('buildBreadcrumbs', () => {
  test('root path returns single segment', () => {
    const crumbs = buildBreadcrumbs('/');
    expect(crumbs).toEqual([{ label: '/', path: '/' }]);
  });

  test('multi-level path returns all segments', () => {
    const crumbs = buildBreadcrumbs('/home/staxed/projects');
    expect(crumbs).toEqual([
      { label: '/', path: '/' },
      { label: 'home', path: '/home' },
      { label: 'staxed', path: '/home/staxed' },
      { label: 'projects', path: '/home/staxed/projects' },
    ]);
  });

  test('empty string returns root', () => {
    const crumbs = buildBreadcrumbs('');
    expect(crumbs).toEqual([{ label: '/', path: '/' }]);
  });
});

// ── Workspace persistence tests ──────────────────────────────

describe('loadWorkspace', () => {
  test('returns empty roots when no data', () => {
    const ws = loadWorkspace();
    expect(ws.roots).toEqual([]);
  });

  test('returns saved data', () => {
    const data: WorkspaceData = {
      roots: [{ id: 'r1', host: 'linux-beast', path: '/home', label: 'home' }],
    };
    storage.set('archon-desktop:workspace', JSON.stringify(data));
    const ws = loadWorkspace();
    expect(ws.roots).toHaveLength(1);
    expect(ws.roots[0].id).toBe('r1');
  });

  test('handles invalid JSON gracefully', () => {
    storage.set('archon-desktop:workspace', 'not-json');
    const ws = loadWorkspace();
    expect(ws.roots).toEqual([]);
  });

  test('handles missing roots field', () => {
    storage.set('archon-desktop:workspace', JSON.stringify({}));
    const ws = loadWorkspace();
    expect(ws.roots).toEqual([]);
  });
});

describe('saveWorkspace', () => {
  test('persists data to localStorage', () => {
    const data: WorkspaceData = {
      roots: [{ id: 'r1', host: 'linux-beast', path: '/home', label: 'home' }],
    };
    saveWorkspace(data);
    const raw = storage.get('archon-desktop:workspace');
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw!) as WorkspaceData;
    expect(parsed.roots).toHaveLength(1);
  });
});

describe('addRootToWorkspace', () => {
  test('adds a new root', () => {
    const root: TreeRoot = { id: 'r1', host: 'linux-beast', path: '/home', label: 'home' };
    const result = addRootToWorkspace(root);
    expect(result.roots).toHaveLength(1);
    expect(result.roots[0].id).toBe('r1');
    // Verify persisted
    const loaded = loadWorkspace();
    expect(loaded.roots).toHaveLength(1);
  });

  test('prevents duplicate host+path', () => {
    const root: TreeRoot = { id: 'r1', host: 'linux-beast', path: '/home', label: 'home' };
    addRootToWorkspace(root);
    const root2: TreeRoot = { id: 'r2', host: 'linux-beast', path: '/home', label: 'home2' };
    const result = addRootToWorkspace(root2);
    expect(result.roots).toHaveLength(1);
  });

  test('allows same path on different hosts', () => {
    const root1: TreeRoot = { id: 'r1', host: 'linux-beast', path: '/home', label: 'home' };
    addRootToWorkspace(root1);
    const root2: TreeRoot = { id: 'r2', host: 'local-windows', path: '/home', label: 'home' };
    const result = addRootToWorkspace(root2);
    expect(result.roots).toHaveLength(2);
  });
});

describe('removeRootFromWorkspace', () => {
  test('removes a root by id', () => {
    const root: TreeRoot = { id: 'r1', host: 'linux-beast', path: '/home', label: 'home' };
    addRootToWorkspace(root);
    const result = removeRootFromWorkspace('r1');
    expect(result.roots).toHaveLength(0);
    // Verify persisted
    const loaded = loadWorkspace();
    expect(loaded.roots).toHaveLength(0);
  });

  test('no-op for missing id', () => {
    const root: TreeRoot = { id: 'r1', host: 'linux-beast', path: '/home', label: 'home' };
    addRootToWorkspace(root);
    const result = removeRootFromWorkspace('r999');
    expect(result.roots).toHaveLength(1);
  });
});

// ── Round-trip test ──────────────────────────────────────────

describe('workspace round-trip', () => {
  test('add multiple roots, remove one, verify persistence', () => {
    const root1: TreeRoot = {
      id: 'r1',
      host: 'linux-beast',
      path: '/home/staxed/project-a',
      label: 'project-a',
    };
    const root2: TreeRoot = {
      id: 'r2',
      host: 'local-windows',
      path: 'C:\\Users\\staxed\\project-b',
      label: 'project-b',
    };

    addRootToWorkspace(root1);
    addRootToWorkspace(root2);

    let ws = loadWorkspace();
    expect(ws.roots).toHaveLength(2);

    removeRootFromWorkspace('r1');
    ws = loadWorkspace();
    expect(ws.roots).toHaveLength(1);
    expect(ws.roots[0].id).toBe('r2');
    expect(ws.roots[0].host).toBe('local-windows');
  });
});
