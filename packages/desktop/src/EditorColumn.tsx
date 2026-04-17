import { loadWorkspace, saveWorkspace } from './AddFolderModal';
import type { EditorColumnPersistedState } from './AddFolderModal';

// ── Snap logic ──────────────────────────────────────────────────

/**
 * Snap points as percentages of the panel group.
 * 1× grid-column-width ≈ viewport/6 ≈ 17%
 * 2× ≈ 33%
 * 3× ≈ 50%
 */
export const SNAP_WIDTHS: readonly number[] = [17, 33, 50];

/** How close (in %) the panel must be to a snap point to snap. */
const SNAP_THRESHOLD = 4;

/**
 * Snap a width percentage to the nearest snap point if within threshold.
 * Returns the width unchanged if no snap point is close enough.
 */
export function snapWidth(width: number): number {
  let nearest = SNAP_WIDTHS[0];
  let minDist = Math.abs(width - nearest);
  for (const sw of SNAP_WIDTHS) {
    const dist = Math.abs(width - sw);
    if (dist < minDist) {
      minDist = dist;
      nearest = sw;
    }
  }
  return minDist <= SNAP_THRESHOLD ? nearest : width;
}

// ── Persistence ─────────────────────────────────────────────────

export type { EditorColumnPersistedState };

/**
 * Load editor column state from workspace persistence.
 */
export function loadEditorColumnState(): EditorColumnPersistedState {
  const ws = loadWorkspace();
  if (ws.editorColumn) {
    return ws.editorColumn;
  }
  return { collapsed: false, width: SNAP_WIDTHS[0] };
}

/**
 * Save editor column state to workspace persistence.
 */
export function saveEditorColumnState(state: EditorColumnPersistedState): void {
  const ws = loadWorkspace();
  ws.editorColumn = state;
  saveWorkspace(ws);
}

// ── Component ───────────────────────────────────────────────────

export interface OpenFile {
  path: string;
  host: string;
  name: string;
}

interface EditorColumnContentProps {
  collapsed: boolean;
  openFiles: OpenFile[];
  onToggleCollapse: () => void;
}

/**
 * Content rendered inside the editor Panel.
 * Shows a thin clickable rail when collapsed (with open-file icons).
 * Shows the full editor placeholder when expanded.
 */
export function EditorColumnContent({
  collapsed,
  openFiles,
  onToggleCollapse,
}: EditorColumnContentProps): React.JSX.Element {
  if (collapsed) {
    return (
      <div
        className="editor-rail"
        onClick={onToggleCollapse}
        role="button"
        tabIndex={0}
        title="Expand editor column"
        onKeyDown={(e): void => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggleCollapse();
          }
        }}
      >
        {openFiles.map(f => (
          <div key={`${f.host}:${f.path}`} className="editor-rail-icon" title={f.name}>
            {f.name.charAt(0).toUpperCase()}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="editor-column">
      <div className="editor-column-header">
        <span className="editor-column-title">Editor</span>
        <button
          className="editor-column-collapse-btn"
          onClick={onToggleCollapse}
          title="Collapse editor column"
        >
          ◀
        </button>
      </div>
      <div className="editor-column-body">
        <span className="region-label">Editor</span>
        <span className="region-sublabel">Column</span>
      </div>
    </div>
  );
}
