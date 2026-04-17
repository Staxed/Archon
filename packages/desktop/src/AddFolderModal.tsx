import { useState, useCallback, useEffect, useRef } from 'react';
import type { TreeRoot, TreeEntry } from './FileTree';
import { isLocalHost } from './FileTree';

// ── Types ──────────────────────────────────────────────────────

export interface SavedHost {
  alias: string;
  label: string;
}

export interface EditorColumnPersistedState {
  collapsed: boolean;
  width: number;
}

export interface WorkspaceData {
  roots: TreeRoot[];
  editorColumn?: EditorColumnPersistedState;
}

// ── Workspace persistence helpers (exported for testing) ──────

const WORKSPACE_STORAGE_KEY = 'archon-desktop:workspace';

/**
 * Load workspace data from localStorage.
 * In a real Tauri app this would use Tauri's fs API to read from
 * the per-OS app-data directory. For now, localStorage is used.
 */
export function loadWorkspace(): WorkspaceData {
  try {
    const raw = localStorage.getItem(WORKSPACE_STORAGE_KEY);
    if (!raw) return { roots: [] };
    const parsed = JSON.parse(raw) as Partial<WorkspaceData>;
    return {
      roots: Array.isArray(parsed.roots) ? parsed.roots : [],
      editorColumn: parsed.editorColumn,
    };
  } catch {
    return { roots: [] };
  }
}

/**
 * Save workspace data to localStorage.
 * In a real Tauri app this would write to per-OS app-data JSON.
 */
export function saveWorkspace(data: WorkspaceData): void {
  localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(data));
}

/**
 * Add a root to the workspace and persist.
 */
export function addRootToWorkspace(root: TreeRoot): WorkspaceData {
  const ws = loadWorkspace();
  // Prevent duplicates by path + host
  if (ws.roots.some(r => r.host === root.host && r.path === root.path)) {
    return ws;
  }
  const updated: WorkspaceData = { roots: [...ws.roots, root] };
  saveWorkspace(updated);
  return updated;
}

/**
 * Remove a root from the workspace and persist.
 */
export function removeRootFromWorkspace(rootId: string): WorkspaceData {
  const ws = loadWorkspace();
  const updated: WorkspaceData = { roots: ws.roots.filter(r => r.id !== rootId) };
  saveWorkspace(updated);
  return updated;
}

/**
 * Extract the basename from a path (last segment).
 */
export function pathBasename(p: string): string {
  const trimmed = p.endsWith('/') ? p.slice(0, -1) : p;
  const lastSlash = trimmed.lastIndexOf('/');
  if (lastSlash < 0) return trimmed || '/';
  return trimmed.slice(lastSlash + 1) || '/';
}

/**
 * Build breadcrumb segments from a path.
 * e.g. "/home/staxed/projects" → ["/", "home", "staxed", "projects"]
 */
export function buildBreadcrumbs(p: string): { label: string; path: string }[] {
  const segments: { label: string; path: string }[] = [{ label: '/', path: '/' }];
  if (p === '/' || !p) return segments;
  const parts = p.split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current += '/' + part;
    segments.push({ label: part, path: current });
  }
  return segments;
}

// ── Default hosts ────────────────────────────────────────────

const DEFAULT_HOSTS: SavedHost[] = [
  { alias: 'local-windows', label: 'Local (Windows)' },
  { alias: 'local-macos', label: 'Local (macOS)' },
];

// ── Fetch directory entries ──────────────────────────────────

async function fetchDirectoryEntries(
  serverUrl: string,
  host: string,
  dirPath: string
): Promise<TreeEntry[]> {
  const params = new URLSearchParams({ host, root: dirPath });
  const res = await fetch(`${serverUrl}/api/desktop/fs/tree?${params.toString()}`);
  if (!res.ok) return [];
  const data = (await res.json()) as { entries: TreeEntry[] };
  // Only return directories for browsing
  return data.entries.filter(e => e.kind === 'dir').sort((a, b) => a.name.localeCompare(b.name));
}

// ── React component ───────────────────────────────────────────

interface AddFolderModalProps {
  serverUrl: string;
  savedHosts: SavedHost[];
  onAdd: (root: TreeRoot) => void;
  onCancel: () => void;
}

export function AddFolderModal({
  serverUrl,
  savedHosts,
  onAdd,
  onCancel,
}: AddFolderModalProps): React.JSX.Element {
  const allHosts = [...DEFAULT_HOSTS, ...savedHosts];
  const [selectedHost, setSelectedHost] = useState(allHosts[0]?.alias ?? 'local-windows');
  const [currentPath, setCurrentPath] = useState('/');
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  // Fetch directory contents when path or host changes
  useEffect(() => {
    if (isLocalHost(selectedHost)) {
      // Local host — no server fetch; would use Tauri FS in real app
      setEntries([]);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    void fetchDirectoryEntries(serverUrl, selectedHost, currentPath)
      .then(dirs => {
        setEntries(dirs);
        setLoading(false);
      })
      .catch(() => {
        setEntries([]);
        setError('Failed to list directory');
        setLoading(false);
      });
  }, [serverUrl, selectedHost, currentPath]);

  const handleHostChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>): void => {
    setSelectedHost(e.target.value);
    setCurrentPath('/');
    setEntries([]);
  }, []);

  const handleDirClick = useCallback(
    (dirName: string): void => {
      const newPath = currentPath === '/' ? '/' + dirName : currentPath + '/' + dirName;
      setCurrentPath(newPath);
    },
    [currentPath]
  );

  const handleBreadcrumbClick = useCallback((path: string): void => {
    setCurrentPath(path);
  }, []);

  const handleOk = useCallback((): void => {
    const id = crypto.randomUUID();
    const label = pathBasename(currentPath);
    const root: TreeRoot = {
      id,
      host: selectedHost,
      path: currentPath,
      label,
    };
    addRootToWorkspace(root);
    onAdd(root);
  }, [selectedHost, currentPath, onAdd]);

  const breadcrumbs = buildBreadcrumbs(currentPath);

  return (
    <div className="tree-modal-overlay">
      <div className="tree-modal add-folder-modal" ref={modalRef}>
        <div className="tree-modal-title">Add Folder to Workspace</div>

        {/* Host picker */}
        <div className="add-folder-field">
          <label className="add-folder-label" htmlFor="host-picker">
            Host
          </label>
          <select
            id="host-picker"
            className="add-folder-select"
            value={selectedHost}
            onChange={handleHostChange}
          >
            {allHosts.map(h => (
              <option key={h.alias} value={h.alias}>
                {h.label}
              </option>
            ))}
          </select>
        </div>

        {/* Path breadcrumb */}
        <div className="add-folder-breadcrumb">
          {breadcrumbs.map((crumb, i) => (
            <span key={crumb.path}>
              {i > 0 && <span className="breadcrumb-separator">/</span>}
              <button
                className="breadcrumb-btn"
                onClick={(): void => {
                  handleBreadcrumbClick(crumb.path);
                }}
              >
                {crumb.label}
              </button>
            </span>
          ))}
        </div>

        {/* Path browser */}
        <div className="add-folder-browser">
          {loading && <div className="add-folder-loading">Loading...</div>}
          {error && <div className="add-folder-error">{error}</div>}
          {!loading && !error && isLocalHost(selectedHost) && (
            <div className="add-folder-local-hint">
              Local folder browsing requires Tauri. Enter path manually or use a remote host.
            </div>
          )}
          {!loading && !error && entries.length === 0 && !isLocalHost(selectedHost) && (
            <div className="add-folder-empty">No subdirectories</div>
          )}
          {entries.map(entry => (
            <div
              key={entry.name}
              className="add-folder-dir-item"
              onClick={(): void => {
                handleDirClick(entry.name);
              }}
              role="button"
              tabIndex={0}
              onKeyDown={(e): void => {
                if (e.key === 'Enter') handleDirClick(entry.name);
              }}
            >
              <span className="add-folder-dir-icon">{'\u25b8'}</span>
              <span className="add-folder-dir-name">{entry.name}</span>
            </div>
          ))}
        </div>

        {/* Current path display */}
        <div className="add-folder-current-path">
          <span className="add-folder-path-label">Selected:</span>
          <span className="add-folder-path-value">{currentPath}</span>
        </div>

        {/* Actions */}
        <div className="tree-modal-actions">
          <button className="tree-modal-btn" onClick={handleOk}>
            OK
          </button>
          <button className="tree-modal-btn secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
