import { describe, expect, test } from 'bun:test';
import {
  treeReducer,
  createInitialTreeState,
  buildCopyPath,
  buildRelativePath,
  isLocalHost,
  getHostBadge,
  joinPath,
  matchesCodebasePath,
  getRevealCommand,
  canRevealInOs,
} from './FileTree';
import type { TreeRoot, TreeEntry, TreeState } from './FileTree';

function makeRoot(overrides: Partial<TreeRoot> = {}): TreeRoot {
  return {
    id: 'root-1',
    host: 'linux-beast',
    path: '/home/staxed/projects',
    label: 'projects',
    ...overrides,
  };
}

function makeEntry(overrides: Partial<TreeEntry> = {}): TreeEntry {
  return {
    name: 'src',
    kind: 'dir',
    mtime: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// ── Pure helper tests ─────────────────────────────────────────

describe('buildCopyPath', () => {
  test('remote host gets ssh:// prefix', () => {
    expect(buildCopyPath('linux-beast', '/home/staxed/file.ts')).toBe(
      'ssh://linux-beast/home/staxed/file.ts'
    );
  });

  test('local-windows returns raw path', () => {
    expect(buildCopyPath('local-windows', 'C:\\Users\\staxed\\file.ts')).toBe(
      'C:\\Users\\staxed\\file.ts'
    );
  });

  test('local-macos returns raw path', () => {
    expect(buildCopyPath('local-macos', '/Users/staxed/file.ts')).toBe('/Users/staxed/file.ts');
  });
});

describe('buildRelativePath', () => {
  test('returns relative from root', () => {
    expect(buildRelativePath('/home/staxed', '/home/staxed/src/main.ts')).toBe('src/main.ts');
  });

  test('returns dot for same path', () => {
    expect(buildRelativePath('/home/staxed', '/home/staxed')).toBe('.');
  });

  test('handles root with trailing slash', () => {
    expect(buildRelativePath('/home/staxed/', '/home/staxed/src/main.ts')).toBe('src/main.ts');
  });

  test('returns full path if not within root', () => {
    expect(buildRelativePath('/home/staxed', '/tmp/other')).toBe('/tmp/other');
  });
});

describe('isLocalHost', () => {
  test('local-windows is local', () => {
    expect(isLocalHost('local-windows')).toBe(true);
  });

  test('local-macos is local', () => {
    expect(isLocalHost('local-macos')).toBe(true);
  });

  test('linux-beast is remote', () => {
    expect(isLocalHost('linux-beast')).toBe(false);
  });
});

describe('getHostBadge', () => {
  test('local-windows returns window badge', () => {
    const badge = getHostBadge('local-windows');
    expect(badge).toBe('\ud83e\ude9f');
  });

  test('remote host returns monitor badge', () => {
    const badge = getHostBadge('linux-beast');
    expect(badge).toBe('\ud83d\udda5\ufe0f');
  });
});

describe('joinPath', () => {
  test('joins parent and child', () => {
    expect(joinPath('/home/staxed', 'src')).toBe('/home/staxed/src');
  });

  test('handles trailing slash on parent', () => {
    expect(joinPath('/home/staxed/', 'src')).toBe('/home/staxed/src');
  });
});

// ── Tree state reducer tests ──────────────────────────────────

describe('treeReducer', () => {
  test('ADD_ROOT adds a root', () => {
    const state = createInitialTreeState();
    const root = makeRoot();
    const next = treeReducer(state, { type: 'ADD_ROOT', root });
    expect(next.roots).toHaveLength(1);
    expect(next.roots[0].id).toBe('root-1');
  });

  test('ADD_ROOT ignores duplicate id', () => {
    let state = createInitialTreeState();
    const root = makeRoot();
    state = treeReducer(state, { type: 'ADD_ROOT', root });
    const next = treeReducer(state, { type: 'ADD_ROOT', root });
    expect(next.roots).toHaveLength(1);
  });

  test('REMOVE_ROOT removes a root and cleans up state', () => {
    let state = createInitialTreeState();
    const root = makeRoot();
    state = treeReducer(state, { type: 'ADD_ROOT', root });
    state = treeReducer(state, {
      type: 'TOGGLE_EXPAND',
      rootId: 'root-1',
      path: '/home/staxed/projects',
    });
    state = treeReducer(state, {
      type: 'SET_CHILDREN',
      rootId: 'root-1',
      path: '/home/staxed/projects',
      entries: [makeEntry()],
    });

    const next = treeReducer(state, { type: 'REMOVE_ROOT', rootId: 'root-1' });
    expect(next.roots).toHaveLength(0);
    expect(next.expanded.size).toBe(0);
    expect(next.children.size).toBe(0);
  });

  test('TOGGLE_EXPAND adds to expanded set', () => {
    const state = createInitialTreeState();
    const next = treeReducer(state, { type: 'TOGGLE_EXPAND', rootId: 'root-1', path: '/dir' });
    expect(next.expanded.has('root-1:/dir')).toBe(true);
  });

  test('TOGGLE_EXPAND removes from expanded set on second call', () => {
    let state = createInitialTreeState();
    state = treeReducer(state, { type: 'TOGGLE_EXPAND', rootId: 'root-1', path: '/dir' });
    const next = treeReducer(state, { type: 'TOGGLE_EXPAND', rootId: 'root-1', path: '/dir' });
    expect(next.expanded.has('root-1:/dir')).toBe(false);
  });

  test('SET_CHILDREN stores entries', () => {
    const state = createInitialTreeState();
    const entries = [makeEntry({ name: 'foo' }), makeEntry({ name: 'bar', kind: 'file' })];
    const next = treeReducer(state, { type: 'SET_CHILDREN', rootId: 'r1', path: '/dir', entries });
    expect(next.children.get('r1:/dir')).toEqual(entries);
  });

  test('SET_LOADING toggles loading state', () => {
    let state = createInitialTreeState();
    state = treeReducer(state, { type: 'SET_LOADING', rootId: 'r1', path: '/dir', loading: true });
    expect(state.loading.has('r1:/dir')).toBe(true);

    state = treeReducer(state, { type: 'SET_LOADING', rootId: 'r1', path: '/dir', loading: false });
    expect(state.loading.has('r1:/dir')).toBe(false);
  });

  test('COLLAPSE_ALL collapses all paths under a root', () => {
    let state = createInitialTreeState();
    state = treeReducer(state, { type: 'TOGGLE_EXPAND', rootId: 'r1', path: '/a' });
    state = treeReducer(state, { type: 'TOGGLE_EXPAND', rootId: 'r1', path: '/a/b' });
    state = treeReducer(state, { type: 'TOGGLE_EXPAND', rootId: 'r2', path: '/x' });

    const next = treeReducer(state, { type: 'COLLAPSE_ALL', rootId: 'r1' });
    expect(next.expanded.has('r1:/a')).toBe(false);
    expect(next.expanded.has('r1:/a/b')).toBe(false);
    expect(next.expanded.has('r2:/x')).toBe(true); // Other root unaffected
  });
});

// ── Context menu action logic tests ───────────────────────────

describe('context menu actions', () => {
  test('copy-path for remote host produces ssh:// URL', () => {
    const result = buildCopyPath('linux-beast', '/home/staxed/projects/README.md');
    expect(result).toBe('ssh://linux-beast/home/staxed/projects/README.md');
  });

  test('copy-relative-path from root', () => {
    const result = buildRelativePath('/home/staxed/projects', '/home/staxed/projects/src/index.ts');
    expect(result).toBe('src/index.ts');
  });

  test('new file path is correctly joined', () => {
    const parentPath = '/home/staxed/projects/src';
    const fileName = 'newfile.ts';
    expect(joinPath(parentPath, fileName)).toBe('/home/staxed/projects/src/newfile.ts');
  });

  test('new folder path is correctly joined', () => {
    const parentPath = '/home/staxed/projects';
    const folderName = 'new-dir';
    expect(joinPath(parentPath, folderName)).toBe('/home/staxed/projects/new-dir');
  });
});

// ── Archon codebase badge tests ──────────────────────────────

describe('matchesCodebasePath', () => {
  test('exact match returns true', () => {
    expect(
      matchesCodebasePath('/home/staxed/projects/Archon', '/home/staxed/projects/Archon')
    ).toBe(true);
  });

  test('matches with trailing slash on root', () => {
    expect(
      matchesCodebasePath('/home/staxed/projects/Archon/', '/home/staxed/projects/Archon')
    ).toBe(true);
  });

  test('matches with trailing slash on codebase cwd', () => {
    expect(
      matchesCodebasePath('/home/staxed/projects/Archon', '/home/staxed/projects/Archon/')
    ).toBe(true);
  });

  test('non-matching paths return false', () => {
    expect(matchesCodebasePath('/home/staxed/projects/Other', '/home/staxed/projects/Archon')).toBe(
      false
    );
  });

  test('partial prefix does not match', () => {
    expect(matchesCodebasePath('/home/staxed/projects/Arch', '/home/staxed/projects/Archon')).toBe(
      false
    );
  });
});

describe('codebase badge visibility', () => {
  test('badge shown when root path matches any codebase', () => {
    const codebasePaths = ['/home/staxed/projects/Archon', '/home/staxed/projects/Other'];
    const rootPath = '/home/staxed/projects/Archon';
    const hasBadge = codebasePaths.some(cwd => matchesCodebasePath(rootPath, cwd));
    expect(hasBadge).toBe(true);
  });

  test('badge not shown when root path matches no codebase', () => {
    const codebasePaths = ['/home/staxed/projects/Archon'];
    const rootPath = '/home/staxed/projects/Unknown';
    const hasBadge = codebasePaths.some(cwd => matchesCodebasePath(rootPath, cwd));
    expect(hasBadge).toBe(false);
  });

  test('badge shown with trailing slash normalization', () => {
    const codebasePaths = ['/home/staxed/projects/Archon/'];
    const rootPath = '/home/staxed/projects/Archon';
    const hasBadge = codebasePaths.some(cwd => matchesCodebasePath(rootPath, cwd));
    expect(hasBadge).toBe(true);
  });
});

// ── Reveal in OS tests ──────────────────────────────────────

describe('getRevealCommand', () => {
  test('windows returns explorer.exe /select,<path>', () => {
    const result = getRevealCommand('windows', 'C:\\Users\\staxed\\file.ts');
    expect(result).toEqual({
      command: 'explorer.exe',
      args: ['/select,C:\\Users\\staxed\\file.ts'],
    });
  });

  test('macos returns open -R <path>', () => {
    const result = getRevealCommand('macos', '/Users/staxed/file.ts');
    expect(result).toEqual({
      command: 'open',
      args: ['-R', '/Users/staxed/file.ts'],
    });
  });

  test('unknown platform returns null', () => {
    const result = getRevealCommand('linux', '/home/staxed/file.ts');
    expect(result).toBeNull();
  });
});

describe('canRevealInOs', () => {
  test('local-windows can reveal', () => {
    expect(canRevealInOs('local-windows')).toBe(true);
  });

  test('local-macos can reveal', () => {
    expect(canRevealInOs('local-macos')).toBe(true);
  });

  test('remote host cannot reveal', () => {
    expect(canRevealInOs('linux-beast')).toBe(false);
  });

  test('remote host shows no-op for reveal', () => {
    // Simulates the action path: remote → toast message, no OS command
    const host = 'linux-beast';
    const canReveal = canRevealInOs(host);
    expect(canReveal).toBe(false);
    // In the component, !canReveal triggers onToast('Remote paths cannot be opened...')
  });
});

// ── Open Archon Web UI visibility tests ──────────────────────

describe('Open Archon Web UI visibility', () => {
  test('shown when root is an Archon codebase', () => {
    const codebasePaths = ['/home/staxed/projects/Archon'];
    const rootPath = '/home/staxed/projects/Archon';
    const isArchonCodebase = codebasePaths.some(cwd => matchesCodebasePath(rootPath, cwd));
    expect(isArchonCodebase).toBe(true);
  });

  test('hidden when root is not an Archon codebase', () => {
    const codebasePaths = ['/home/staxed/projects/Archon'];
    const rootPath = '/home/staxed/projects/Other';
    const isArchonCodebase = codebasePaths.some(cwd => matchesCodebasePath(rootPath, cwd));
    expect(isArchonCodebase).toBe(false);
  });
});
