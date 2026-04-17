import { useState, useCallback, useEffect, useRef } from 'react';

// ── Types ──────────────────────────────────────────────────────

export interface TreeRoot {
  id: string;
  host: string;
  path: string;
  label: string;
}

export interface TreeEntry {
  name: string;
  kind: 'file' | 'dir';
  size?: number;
  mtime: string;
}

export interface TreeNodeData {
  /** Full path of this node */
  path: string;
  name: string;
  kind: 'file' | 'dir';
  rootId: string;
}

/** Context menu action types */
export type ContextMenuAction =
  | 'new-file'
  | 'new-folder'
  | 'copy-path'
  | 'copy-relative-path'
  | 'remove-from-workspace';

interface ContextMenuState {
  x: number;
  y: number;
  node: TreeNodeData;
  root: TreeRoot;
}

// ── Pure helpers (exported for testing) ────────────────────────

/**
 * Build the display path for Copy Path action.
 * Remote hosts get ssh:// prefix; local hosts get the raw path.
 */
export function buildCopyPath(host: string, fullPath: string): string {
  if (host.startsWith('local-')) {
    return fullPath;
  }
  return `ssh://${host}${fullPath}`;
}

/**
 * Build a relative path from a root path.
 */
export function buildRelativePath(rootPath: string, fullPath: string): string {
  if (fullPath === rootPath) return '.';
  const prefix = rootPath.endsWith('/') ? rootPath : rootPath + '/';
  if (fullPath.startsWith(prefix)) {
    return fullPath.slice(prefix.length);
  }
  return fullPath;
}

/**
 * Determine whether a host is local (handled by Tauri) or remote (handled by server API).
 */
export function isLocalHost(host: string): boolean {
  return host.startsWith('local-');
}

/**
 * Get the host badge for display.
 */
export function getHostBadge(host: string): string {
  if (host === 'local-windows') return '\ud83e\ude9f';
  if (host === 'local-macos') return '\ud83e\ude9f';
  return '\ud83d\udda5\ufe0f';
}

/**
 * Join a parent path and child name.
 */
export function joinPath(parentPath: string, childName: string): string {
  if (parentPath.endsWith('/')) return parentPath + childName;
  return parentPath + '/' + childName;
}

/**
 * Check whether a root path matches a codebase's default_cwd.
 * Normalizes trailing slashes for comparison.
 */
export function matchesCodebasePath(rootPath: string, codebaseCwd: string): boolean {
  const normalize = (p: string): string => (p.endsWith('/') ? p.slice(0, -1) : p);
  return normalize(rootPath) === normalize(codebaseCwd);
}

// ── Tree state reducer ────────────────────────────────────────

export interface TreeState {
  roots: TreeRoot[];
  expanded: Set<string>; // keys: `${rootId}:${path}`
  children: Map<string, TreeEntry[]>; // keys: `${rootId}:${path}`
  loading: Set<string>; // keys: `${rootId}:${path}`
}

export type TreeAction =
  | { type: 'ADD_ROOT'; root: TreeRoot }
  | { type: 'REMOVE_ROOT'; rootId: string }
  | { type: 'TOGGLE_EXPAND'; rootId: string; path: string }
  | { type: 'SET_CHILDREN'; rootId: string; path: string; entries: TreeEntry[] }
  | { type: 'SET_LOADING'; rootId: string; path: string; loading: boolean }
  | { type: 'COLLAPSE_ALL'; rootId: string };

function nodeKey(rootId: string, path: string): string {
  return `${rootId}:${path}`;
}

export function treeReducer(state: TreeState, action: TreeAction): TreeState {
  switch (action.type) {
    case 'ADD_ROOT': {
      if (state.roots.some(r => r.id === action.root.id)) return state;
      return { ...state, roots: [...state.roots, action.root] };
    }
    case 'REMOVE_ROOT': {
      const newRoots = state.roots.filter(r => r.id !== action.rootId);
      // Clean up expanded/children/loading for this root
      const newExpanded = new Set(state.expanded);
      const newChildren = new Map(state.children);
      const newLoading = new Set(state.loading);
      const prefix = action.rootId + ':';
      for (const key of state.expanded) {
        if (key.startsWith(prefix)) newExpanded.delete(key);
      }
      for (const key of state.children.keys()) {
        if (key.startsWith(prefix)) newChildren.delete(key);
      }
      for (const key of state.loading) {
        if (key.startsWith(prefix)) newLoading.delete(key);
      }
      return { roots: newRoots, expanded: newExpanded, children: newChildren, loading: newLoading };
    }
    case 'TOGGLE_EXPAND': {
      const key = nodeKey(action.rootId, action.path);
      const newExpanded = new Set(state.expanded);
      if (newExpanded.has(key)) {
        newExpanded.delete(key);
      } else {
        newExpanded.add(key);
      }
      return { ...state, expanded: newExpanded };
    }
    case 'SET_CHILDREN': {
      const key = nodeKey(action.rootId, action.path);
      const newChildren = new Map(state.children);
      newChildren.set(key, action.entries);
      return { ...state, children: newChildren };
    }
    case 'SET_LOADING': {
      const key = nodeKey(action.rootId, action.path);
      const newLoading = new Set(state.loading);
      if (action.loading) {
        newLoading.add(key);
      } else {
        newLoading.delete(key);
      }
      return { ...state, loading: newLoading };
    }
    case 'COLLAPSE_ALL': {
      const newExpanded = new Set(state.expanded);
      const prefix = action.rootId + ':';
      for (const key of state.expanded) {
        if (key.startsWith(prefix)) newExpanded.delete(key);
      }
      return { ...state, expanded: newExpanded };
    }
    default:
      return state;
  }
}

export function createInitialTreeState(): TreeState {
  return {
    roots: [],
    expanded: new Set(),
    children: new Map(),
    loading: new Set(),
  };
}

// ── Fetch helpers ─────────────────────────────────────────────

async function fetchRemoteChildren(
  serverUrl: string,
  host: string,
  rootPath: string
): Promise<TreeEntry[]> {
  const params = new URLSearchParams({ host, root: rootPath });
  const res = await fetch(`${serverUrl}/api/desktop/fs/tree?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`Failed to list directory: ${res.status}`);
  }
  const data = (await res.json()) as { entries: TreeEntry[] };
  return data.entries;
}

async function createRemoteFile(
  serverUrl: string,
  host: string,
  filePath: string,
  isDir: boolean
): Promise<void> {
  if (isDir) {
    // Create a directory by creating a placeholder and relying on mkdir
    const params = new URLSearchParams({ host, path: filePath + '/.keep', mkdir: '1' });
    const res = await fetch(`${serverUrl}/api/desktop/fs/file?${params.toString()}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '' }),
    });
    if (!res.ok) throw new Error(`Failed to create folder: ${res.status}`);
  } else {
    const params = new URLSearchParams({ host, path: filePath, mkdir: '1' });
    const res = await fetch(`${serverUrl}/api/desktop/fs/file?${params.toString()}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '' }),
    });
    if (!res.ok) throw new Error(`Failed to create file: ${res.status}`);
  }
}

// ── Codebase fetch helper ────────────────────────────────────

interface CodebaseEntry {
  id: string;
  default_cwd: string;
}

async function fetchCodebases(serverUrl: string): Promise<CodebaseEntry[]> {
  try {
    const res = await fetch(`${serverUrl}/api/codebases`);
    if (!res.ok) return [];
    const data = (await res.json()) as CodebaseEntry[];
    return data;
  } catch {
    return [];
  }
}

// ── React component ───────────────────────────────────────────

interface FileTreeProps {
  serverUrl: string;
  roots: TreeRoot[];
  onRemoveRoot: (rootId: string) => void;
  onAddRoot?: () => void;
}

interface NamePromptState {
  rootId: string;
  parentPath: string;
  kind: 'file' | 'dir';
}

interface ConfirmModalState {
  rootId: string;
  rootLabel: string;
}

function TreeNode({
  entry,
  depth,
  rootId,
  parentPath,
  treeState,
  onToggle,
  onContextMenu,
}: {
  entry: TreeEntry;
  depth: number;
  rootId: string;
  parentPath: string;
  treeState: TreeState;
  onToggle: (rootId: string, path: string) => void;
  onContextMenu: (e: React.MouseEvent, node: TreeNodeData) => void;
}): React.JSX.Element {
  const fullPath = joinPath(parentPath, entry.name);
  const key = nodeKey(rootId, fullPath);
  const isExpanded = treeState.expanded.has(key);
  const isLoading = treeState.loading.has(key);
  const children = treeState.children.get(key);
  const isDir = entry.kind === 'dir';

  const handleClick = useCallback((): void => {
    if (isDir) {
      onToggle(rootId, fullPath);
    }
  }, [isDir, rootId, fullPath, onToggle]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      onContextMenu(e, { path: fullPath, name: entry.name, kind: entry.kind, rootId });
    },
    [fullPath, entry.name, entry.kind, rootId, onContextMenu]
  );

  return (
    <>
      <div
        className="tree-node"
        style={{ paddingLeft: depth * 16 + 4 }}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        role="treeitem"
        aria-expanded={isDir ? isExpanded : undefined}
      >
        <span className="tree-node-icon">
          {isDir ? (isExpanded ? '\u25be' : '\u25b8') : '\u00a0'}
        </span>
        <span className={`tree-node-label ${isDir ? 'dir' : 'file'}`}>{entry.name}</span>
        {isLoading && <span className="tree-node-spinner">...</span>}
      </div>
      {isDir && isExpanded && children && (
        <div role="group">
          {children.map(child => (
            <TreeNode
              key={child.name}
              entry={child}
              depth={depth + 1}
              rootId={rootId}
              parentPath={fullPath}
              treeState={treeState}
              onToggle={onToggle}
              onContextMenu={onContextMenu}
            />
          ))}
        </div>
      )}
    </>
  );
}

export function FileTree({
  serverUrl,
  roots,
  onRemoveRoot,
  onAddRoot,
}: FileTreeProps): React.JSX.Element {
  const [treeState, dispatch] = useState<TreeState>(() => createInitialTreeState());
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [namePrompt, setNamePrompt] = useState<NamePromptState | null>(null);
  const [nameInput, setNameInput] = useState('');
  const [confirmModal, setConfirmModal] = useState<ConfirmModalState | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Archon codebase badge state — cached in memory, refreshed on reload
  const [archonCodebasePaths, setArchonCodebasePaths] = useState<string[]>([]);

  const loadCodebases = useCallback((): void => {
    void fetchCodebases(serverUrl).then(codebases => {
      setArchonCodebasePaths(codebases.map(cb => cb.default_cwd));
    });
  }, [serverUrl]);

  // Fetch codebases on mount
  useEffect(() => {
    loadCodebases();
  }, [loadCodebases]);

  // Sync roots prop into tree state
  useEffect(() => {
    dispatch(prev => {
      let state = prev;
      // Add new roots
      for (const root of roots) {
        if (!state.roots.some(r => r.id === root.id)) {
          state = treeReducer(state, { type: 'ADD_ROOT', root });
        }
      }
      // Remove old roots
      for (const existing of state.roots) {
        if (!roots.some(r => r.id === existing.id)) {
          state = treeReducer(state, { type: 'REMOVE_ROOT', rootId: existing.id });
        }
      }
      return state;
    });
  }, [roots]);

  // Focus name input when prompt opens
  useEffect(() => {
    if (namePrompt && nameInputRef.current) {
      nameInputRef.current.focus();
    }
  }, [namePrompt]);

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    const handler = (): void => {
      setContextMenu(null);
    };
    window.addEventListener('click', handler);
    return (): void => {
      window.removeEventListener('click', handler);
    };
  }, [contextMenu]);

  const fetchChildren = useCallback(
    async (rootId: string, dirPath: string): Promise<void> => {
      const root = roots.find(r => r.id === rootId);
      if (!root) return;

      const key = nodeKey(rootId, dirPath);
      dispatch(prev =>
        treeReducer(prev, { type: 'SET_LOADING', rootId, path: dirPath, loading: true })
      );

      try {
        let entries: TreeEntry[];
        if (isLocalHost(root.host)) {
          // Local host — would use Tauri command in real app; stub for now
          entries = [];
        } else {
          entries = await fetchRemoteChildren(serverUrl, root.host, dirPath);
        }
        // Sort: dirs first, then alphabetical
        entries.sort((a, b) => {
          if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        dispatch(prev => {
          let state = treeReducer(prev, { type: 'SET_CHILDREN', rootId, path: dirPath, entries });
          // Also mark as no longer loading
          state = treeReducer(state, {
            type: 'SET_LOADING',
            rootId,
            path: dirPath,
            loading: false,
          });
          // Ensure expanded
          if (!state.expanded.has(key)) {
            state = treeReducer(state, { type: 'TOGGLE_EXPAND', rootId, path: dirPath });
          }
          return state;
        });
      } catch {
        dispatch(prev =>
          treeReducer(prev, { type: 'SET_LOADING', rootId, path: dirPath, loading: false })
        );
      }
    },
    [roots, serverUrl]
  );

  const handleToggle = useCallback(
    (rootId: string, dirPath: string): void => {
      const key = nodeKey(rootId, dirPath);
      dispatch(prev => {
        if (prev.expanded.has(key)) {
          // Collapse
          return treeReducer(prev, { type: 'TOGGLE_EXPAND', rootId, path: dirPath });
        }
        // Expand — fetch if no children cached
        if (!prev.children.has(key)) {
          void fetchChildren(rootId, dirPath);
          return prev;
        }
        return treeReducer(prev, { type: 'TOGGLE_EXPAND', rootId, path: dirPath });
      });
    },
    [fetchChildren]
  );

  const handleRootToggle = useCallback(
    (rootId: string, rootPath: string): void => {
      handleToggle(rootId, rootPath);
    },
    [handleToggle]
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, node: TreeNodeData): void => {
      e.preventDefault();
      const root = roots.find(r => r.id === node.rootId);
      if (!root) return;
      setContextMenu({ x: e.clientX, y: e.clientY, node, root });
    },
    [roots]
  );

  const handleRootContextMenu = useCallback((e: React.MouseEvent, root: TreeRoot): void => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      node: { path: root.path, name: root.label, kind: 'dir', rootId: root.id },
      root,
    });
  }, []);

  const handleMenuAction = useCallback(
    (action: ContextMenuAction): void => {
      if (!contextMenu) return;
      const { node, root } = contextMenu;
      setContextMenu(null);

      switch (action) {
        case 'copy-path': {
          const copyPath = buildCopyPath(root.host, node.path);
          void navigator.clipboard.writeText(copyPath);
          break;
        }
        case 'copy-relative-path': {
          const relPath = buildRelativePath(root.path, node.path);
          void navigator.clipboard.writeText(relPath);
          break;
        }
        case 'new-file': {
          const parentPath =
            node.kind === 'dir' ? node.path : node.path.substring(0, node.path.lastIndexOf('/'));
          setNamePrompt({ rootId: root.id, parentPath, kind: 'file' });
          setNameInput('');
          break;
        }
        case 'new-folder': {
          const parentPath =
            node.kind === 'dir' ? node.path : node.path.substring(0, node.path.lastIndexOf('/'));
          setNamePrompt({ rootId: root.id, parentPath, kind: 'dir' });
          setNameInput('');
          break;
        }
        case 'remove-from-workspace': {
          setConfirmModal({ rootId: root.id, rootLabel: root.label });
          break;
        }
      }
    },
    [contextMenu]
  );

  const handleNameSubmit = useCallback((): void => {
    if (!namePrompt || !nameInput.trim()) return;
    const root = roots.find(r => r.id === namePrompt.rootId);
    if (!root) return;

    const newPath = joinPath(namePrompt.parentPath, nameInput.trim());

    if (!isLocalHost(root.host)) {
      void createRemoteFile(serverUrl, root.host, newPath, namePrompt.kind === 'dir').then(() => {
        // Refresh parent directory
        void fetchChildren(namePrompt.rootId, namePrompt.parentPath);
      });
    }
    // For local hosts, would use Tauri FS command — stub for now

    setNamePrompt(null);
    setNameInput('');
  }, [namePrompt, nameInput, roots, serverUrl, fetchChildren]);

  const handleConfirmRemove = useCallback((): void => {
    if (!confirmModal) return;
    onRemoveRoot(confirmModal.rootId);
    setConfirmModal(null);
  }, [confirmModal, onRemoveRoot]);

  return (
    <div className="file-tree">
      <div className="file-tree-header">
        <span className="file-tree-title">Explorer</span>
        <div className="file-tree-header-actions">
          <button
            className="file-tree-reload-btn"
            onClick={loadCodebases}
            title="Reload tree (refresh codebase badges)"
          >
            &#x21bb;
          </button>
          {onAddRoot && (
            <button
              className="file-tree-add-btn"
              onClick={onAddRoot}
              title="Add Folder to Workspace"
            >
              +
            </button>
          )}
        </div>
      </div>
      <div className="file-tree-content" role="tree">
        {roots.length === 0 && <div className="file-tree-empty">No folders in workspace</div>}
        {roots.map(root => {
          const key = nodeKey(root.id, root.path);
          const isExpanded = treeState.expanded.has(key);
          const isLoading = treeState.loading.has(key);
          const children = treeState.children.get(key);

          return (
            <div key={root.id} className="tree-root">
              <div
                className="tree-root-header"
                onClick={(): void => {
                  handleRootToggle(root.id, root.path);
                }}
                onContextMenu={(e): void => {
                  handleRootContextMenu(e, root);
                }}
                role="treeitem"
                aria-expanded={isExpanded}
              >
                <span className="tree-node-icon">{isExpanded ? '\u25be' : '\u25b8'}</span>
                <span className="tree-root-badge" title={root.host}>
                  {getHostBadge(root.host)}
                </span>
                {archonCodebasePaths.some(cwd => matchesCodebasePath(root.path, cwd)) && (
                  <span className="tree-root-archon-badge" title="Archon codebase">
                    A
                  </span>
                )}
                <span className="tree-root-label">{root.label}</span>
                <span className="tree-root-host">{root.host}</span>
                {isLoading && <span className="tree-node-spinner">...</span>}
              </div>
              {isExpanded && children && (
                <div role="group">
                  {children.map(entry => (
                    <TreeNode
                      key={entry.name}
                      entry={entry}
                      depth={1}
                      rootId={root.id}
                      parentPath={root.path}
                      treeState={treeState}
                      onToggle={handleToggle}
                      onContextMenu={handleContextMenu}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          className="tree-context-menu"
          style={{ position: 'fixed', left: contextMenu.x, top: contextMenu.y }}
        >
          {contextMenu.node.kind === 'dir' && (
            <>
              <button
                className="tree-context-item"
                onClick={(): void => {
                  handleMenuAction('new-file');
                }}
              >
                New File
              </button>
              <button
                className="tree-context-item"
                onClick={(): void => {
                  handleMenuAction('new-folder');
                }}
              >
                New Folder
              </button>
              <div className="tree-context-separator" />
            </>
          )}
          <button
            className="tree-context-item"
            onClick={(): void => {
              handleMenuAction('copy-path');
            }}
          >
            Copy Path
          </button>
          <button
            className="tree-context-item"
            onClick={(): void => {
              handleMenuAction('copy-relative-path');
            }}
          >
            Copy Relative Path
          </button>
          {contextMenu.node.path === contextMenu.root.path && (
            <>
              <div className="tree-context-separator" />
              <button
                className="tree-context-item destructive"
                onClick={(): void => {
                  handleMenuAction('remove-from-workspace');
                }}
              >
                Remove from Workspace
              </button>
            </>
          )}
        </div>
      )}

      {/* Name prompt modal */}
      {namePrompt && (
        <div className="tree-modal-overlay">
          <div className="tree-modal">
            <div className="tree-modal-title">
              {namePrompt.kind === 'file' ? 'New File' : 'New Folder'}
            </div>
            <input
              ref={nameInputRef}
              className="tree-modal-input"
              type="text"
              placeholder={namePrompt.kind === 'file' ? 'filename.txt' : 'folder-name'}
              value={nameInput}
              onChange={(e): void => {
                setNameInput(e.target.value);
              }}
              onKeyDown={(e): void => {
                if (e.key === 'Enter') handleNameSubmit();
                if (e.key === 'Escape') {
                  setNamePrompt(null);
                  setNameInput('');
                }
              }}
            />
            <div className="tree-modal-actions">
              <button className="tree-modal-btn" onClick={handleNameSubmit}>
                Create
              </button>
              <button
                className="tree-modal-btn secondary"
                onClick={(): void => {
                  setNamePrompt(null);
                  setNameInput('');
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm remove modal */}
      {confirmModal && (
        <div className="tree-modal-overlay">
          <div className="tree-modal">
            <div className="tree-modal-title">Remove from Workspace</div>
            <div className="tree-modal-text">
              Remove &quot;{confirmModal.rootLabel}&quot; from workspace? No files will be deleted
              on disk.
            </div>
            <div className="tree-modal-actions">
              <button className="tree-modal-btn destructive" onClick={handleConfirmRemove}>
                Remove
              </button>
              <button
                className="tree-modal-btn secondary"
                onClick={(): void => {
                  setConfirmModal(null);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
