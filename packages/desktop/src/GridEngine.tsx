import { useReducer, useCallback, useState, useRef, useEffect } from 'react';
import type { Layout, LayoutItem } from 'react-grid-layout';
import { GridLayout, noCompactor } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';

// ── Types ──────────────────────────────────────────────────────

export interface GridPane {
  id: string;
  name: string;
  host: string;
  cwd: string;
  sessionName: string;
  x: number;
  y: number;
  w: number;
  h: number;
  yolo?: boolean;
}

export interface GridState {
  panes: GridPane[];
  maximizedId: string | null;
}

export type GridAction =
  | { type: 'ADD_PANE'; pane: GridPane }
  | { type: 'REMOVE_PANE'; id: string }
  | { type: 'MOVE_PANE'; id: string; x: number; y: number }
  | { type: 'RESIZE_PANE'; id: string; w: number; h: number }
  | { type: 'RENAME_PANE'; id: string; name: string }
  | { type: 'TOGGLE_MAXIMIZE'; id: string }
  | { type: 'LAYOUT_CHANGE'; layouts: { i: string; x: number; y: number; w: number; h: number }[] };

// ── Constants ──────────────────────────────────────────────────

export const GRID_COLS = 6;
export const GRID_ROWS = 3;
export const MAX_PANES = GRID_COLS * GRID_ROWS;

// ── Reducer ────────────────────────────────────────────────────

export function gridReducer(state: GridState, action: GridAction): GridState {
  switch (action.type) {
    case 'ADD_PANE': {
      if (state.panes.length >= MAX_PANES) return state;
      if (state.panes.some(p => p.id === action.pane.id)) return state;
      return { ...state, panes: [...state.panes, action.pane] };
    }
    case 'REMOVE_PANE':
      return {
        ...state,
        panes: state.panes.filter(p => p.id !== action.id),
        maximizedId: state.maximizedId === action.id ? null : state.maximizedId,
      };
    case 'MOVE_PANE':
      return {
        ...state,
        panes: state.panes.map(p => (p.id === action.id ? { ...p, x: action.x, y: action.y } : p)),
      };
    case 'RESIZE_PANE':
      return {
        ...state,
        panes: state.panes.map(p => (p.id === action.id ? { ...p, w: action.w, h: action.h } : p)),
      };
    case 'RENAME_PANE':
      return {
        ...state,
        panes: state.panes.map(p => (p.id === action.id ? { ...p, name: action.name } : p)),
      };
    case 'TOGGLE_MAXIMIZE': {
      const isCurrentlyMaximized = state.maximizedId === action.id;
      return { ...state, maximizedId: isCurrentlyMaximized ? null : action.id };
    }
    case 'LAYOUT_CHANGE':
      return {
        ...state,
        panes: state.panes.map(p => {
          const item = action.layouts.find(l => l.i === p.id);
          if (!item) return p;
          return { ...p, x: item.x, y: item.y, w: item.w, h: item.h };
        }),
      };
    default:
      return state;
  }
}

// ── Find first free slot ───────────────────────────────────────

export function findFreeSlot(
  panes: GridPane[],
  w: number,
  h: number
): { x: number; y: number } | null {
  const occupied = new Set<string>();
  for (const p of panes) {
    for (let dx = 0; dx < p.w; dx++) {
      for (let dy = 0; dy < p.h; dy++) {
        occupied.add(`${p.x + dx},${p.y + dy}`);
      }
    }
  }
  for (let row = 0; row <= GRID_ROWS - h; row++) {
    for (let col = 0; col <= GRID_COLS - w; col++) {
      let fits = true;
      for (let dx = 0; dx < w && fits; dx++) {
        for (let dy = 0; dy < h && fits; dy++) {
          if (occupied.has(`${col + dx},${row + dy}`)) fits = false;
        }
      }
      if (fits) return { x: col, y: row };
    }
  }
  return null;
}

// ── Pane Header ────────────────────────────────────────────────

interface PaneHeaderProps {
  pane: GridPane;
  onClose: (id: string) => void;
  onCloseAndKill: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onDoubleClick: (id: string) => void;
}

function PaneHeader({
  pane,
  onClose,
  onCloseAndKill,
  onRename,
  onDoubleClick,
}: PaneHeaderProps): React.JSX.Element {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(pane.name);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [renaming]);

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

  const startRename = useCallback((): void => {
    setDraft(pane.name);
    setRenaming(true);
  }, [pane.name]);

  const commitRename = useCallback((): void => {
    setRenaming(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== pane.name) {
      onRename(pane.id, trimmed);
    }
  }, [draft, pane.id, pane.name, onRename]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent): void => {
      if (e.key === 'Enter') {
        commitRename();
      } else if (e.key === 'Escape') {
        setRenaming(false);
      }
    },
    [commitRename]
  );

  const handleContextMenu = useCallback((e: React.MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent): void => {
      e.preventDefault();
      onDoubleClick(pane.id);
    },
    [pane.id, onDoubleClick]
  );

  return (
    <div
      className={`grid-pane-header${pane.yolo ? ' grid-pane-header-yolo' : ''}`}
      onContextMenu={handleContextMenu}
      onDoubleClick={handleDoubleClick}
    >
      <div className="grid-pane-header-left">
        {renaming ? (
          <input
            ref={inputRef}
            className="grid-pane-rename-input"
            value={draft}
            onChange={e => {
              setDraft(e.target.value);
            }}
            onKeyDown={handleKeyDown}
            onBlur={commitRename}
          />
        ) : (
          <button className="grid-pane-name-btn" onClick={startRename} title="Rename pane">
            {pane.name} &#9662;
          </button>
        )}
        <span className="grid-pane-meta">
          {pane.host} &middot; {pane.cwd}
        </span>
      </div>
      <div className="grid-pane-header-right">
        <button
          className="grid-pane-close-btn"
          onClick={() => {
            onClose(pane.id);
          }}
          title="Close (detach)"
        >
          &times;
        </button>
      </div>
      {contextMenu && (
        <div
          className="grid-pane-context-menu"
          style={{ position: 'fixed', left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            className="grid-pane-context-item destructive"
            onClick={() => {
              setContextMenu(null);
              onCloseAndKill(pane.id);
            }}
          >
            Close and Kill
          </button>
        </div>
      )}
    </div>
  );
}

// ── Grid Engine Component ──────────────────────────────────────

export interface GridEngineProps {
  state: GridState;
  dispatch: React.Dispatch<GridAction>;
  onClose?: (pane: GridPane) => void;
  onCloseAndKill?: (pane: GridPane) => void;
  onRename?: (pane: GridPane, newName: string) => void;
  renderPane?: (pane: GridPane) => React.ReactNode;
}

export function useGridEngine(initialState?: GridState): {
  state: GridState;
  dispatch: React.Dispatch<GridAction>;
} {
  const [state, dispatch] = useReducer(
    gridReducer,
    initialState ?? { panes: [], maximizedId: null }
  );
  return { state, dispatch };
}

export function GridEngine({
  state,
  dispatch,
  onClose,
  onCloseAndKill,
  onRename,
  renderPane,
}: GridEngineProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(800);

  // Track container width for react-grid-layout
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    observer.observe(el);
    return (): void => {
      observer.disconnect();
    };
  }, []);

  const rowHeight = containerRef.current
    ? Math.floor(containerRef.current.clientHeight / GRID_ROWS) - 10
    : 200;

  const handleClose = useCallback(
    (id: string): void => {
      const pane = state.panes.find(p => p.id === id);
      if (pane && onClose) onClose(pane);
      dispatch({ type: 'REMOVE_PANE', id });
    },
    [state.panes, onClose, dispatch]
  );

  const handleCloseAndKill = useCallback(
    (id: string): void => {
      const pane = state.panes.find(p => p.id === id);
      if (pane && onCloseAndKill) onCloseAndKill(pane);
      dispatch({ type: 'REMOVE_PANE', id });
    },
    [state.panes, onCloseAndKill, dispatch]
  );

  const handleRename = useCallback(
    (id: string, name: string): void => {
      dispatch({ type: 'RENAME_PANE', id, name });
      const pane = state.panes.find(p => p.id === id);
      if (pane && onRename) onRename(pane, name);
    },
    [state.panes, onRename, dispatch]
  );

  const handleDoubleClick = useCallback(
    (id: string): void => {
      dispatch({ type: 'TOGGLE_MAXIMIZE', id });
    },
    [dispatch]
  );

  const handleLayoutChange = useCallback(
    (layout: Layout): void => {
      dispatch({
        type: 'LAYOUT_CHANGE',
        layouts: layout.map((l: LayoutItem) => ({ i: l.i, x: l.x, y: l.y, w: l.w, h: l.h })),
      });
    },
    [dispatch]
  );

  // Build layout from state
  const layoutItems: LayoutItem[] = state.panes.map(p => {
    if (state.maximizedId === p.id) {
      return { i: p.id, x: 0, y: 0, w: GRID_COLS, h: GRID_ROWS, minW: 1, minH: 1, static: false };
    }
    return { i: p.id, x: p.x, y: p.y, w: p.w, h: p.h, minW: 1, minH: 1 };
  });

  // When maximized, hide other panes
  const visiblePanes = state.maximizedId
    ? state.panes.filter(p => p.id === state.maximizedId)
    : state.panes;

  const visibleLayout = state.maximizedId
    ? layoutItems.filter(l => l.i === state.maximizedId)
    : layoutItems;

  const isMaximized = state.maximizedId !== null;

  return (
    <div ref={containerRef} className="grid-engine-container">
      {visiblePanes.length === 0 ? (
        <div className="grid-engine-empty">
          <span className="region-label">Terminal Grid</span>
          <span className="region-sublabel">3 &times; 6 &mdash; No panes open</span>
        </div>
      ) : (
        <GridLayout
          className="grid-engine-layout"
          layout={visibleLayout}
          width={containerWidth}
          gridConfig={{
            cols: GRID_COLS,
            maxRows: GRID_ROWS,
            rowHeight,
            margin: [2, 2] as const,
            containerPadding: [0, 0] as const,
          }}
          compactor={noCompactor}
          dragConfig={{
            enabled: !isMaximized,
            bounded: false,
            handle: '.grid-pane-header',
          }}
          resizeConfig={{
            enabled: !isMaximized,
            handles: ['se'],
          }}
          onLayoutChange={handleLayoutChange}
        >
          {visiblePanes.map(pane => (
            <div key={pane.id} className="grid-pane">
              <PaneHeader
                pane={pane}
                onClose={handleClose}
                onCloseAndKill={handleCloseAndKill}
                onRename={handleRename}
                onDoubleClick={handleDoubleClick}
              />
              <div className="grid-pane-content">{renderPane ? renderPane(pane) : null}</div>
            </div>
          ))}
        </GridLayout>
      )}
    </div>
  );
}
