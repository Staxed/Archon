/**
 * Tab state machine for the editor column.
 *
 * Manages preview vs pinned tabs, dirty state, and close flow.
 * Pure functions — no React dependency.
 */

// ── Types ──────────────────────────────────────────────────────

export interface EditorTab {
  /** Unique key: `${host}:${path}` */
  id: string;
  host: string;
  path: string;
  name: string;
  /** Preview tabs are italic and get replaced on next single-click */
  preview: boolean;
  /** File has unsaved changes */
  dirty: boolean;
}

export interface TabState {
  tabs: EditorTab[];
  activeTabId: string | null;
}

export type TabAction =
  | { type: 'OPEN_PREVIEW'; host: string; path: string; name: string }
  | { type: 'OPEN_PINNED'; host: string; path: string; name: string }
  | { type: 'PIN_TAB'; id: string }
  | { type: 'SET_DIRTY'; id: string; dirty: boolean }
  | { type: 'CLOSE_TAB'; id: string }
  | { type: 'ACTIVATE_TAB'; id: string };

// ── Helpers ────────────────────────────────────────────────────

export function tabId(host: string, path: string): string {
  return `${host}:${path}`;
}

/** Get the file extension (lowercase, without dot). */
export function getExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot === -1 || dot === filename.length - 1) return '';
  return filename.slice(dot + 1).toLowerCase();
}

/** Map file extension to a CodeMirror language identifier. */
export function extensionToLanguage(ext: string): string | null {
  switch (ext) {
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'ts':
    case 'tsx':
    case 'mts':
    case 'cts':
      return 'typescript';
    case 'py':
    case 'pyw':
      return 'python';
    case 'md':
    case 'markdown':
      return 'markdown';
    case 'json':
      return 'json';
    case 'css':
      return 'css';
    case 'html':
    case 'htm':
      return 'html';
    default:
      return null;
  }
}

// ── Initial state ──────────────────────────────────────────────

export function createInitialTabState(): TabState {
  return { tabs: [], activeTabId: null };
}

// ── Reducer ────────────────────────────────────────────────────

export function tabReducer(state: TabState, action: TabAction): TabState {
  switch (action.type) {
    case 'OPEN_PREVIEW': {
      const id = tabId(action.host, action.path);
      // If tab already exists, just activate it
      const existing = state.tabs.find(t => t.id === id);
      if (existing) {
        return { ...state, activeTabId: id };
      }
      // Replace existing preview tab (if any) with new preview
      const newTab: EditorTab = {
        id,
        host: action.host,
        path: action.path,
        name: action.name,
        preview: true,
        dirty: false,
      };
      const tabs = state.tabs.filter(t => !t.preview);
      return { tabs: [...tabs, newTab], activeTabId: id };
    }

    case 'OPEN_PINNED': {
      const id = tabId(action.host, action.path);
      const existing = state.tabs.find(t => t.id === id);
      if (existing) {
        // Pin it if it was a preview
        if (existing.preview) {
          const tabs = state.tabs.map(t => (t.id === id ? { ...t, preview: false } : t));
          return { tabs, activeTabId: id };
        }
        return { ...state, activeTabId: id };
      }
      const newTab: EditorTab = {
        id,
        host: action.host,
        path: action.path,
        name: action.name,
        preview: false,
        dirty: false,
      };
      return { tabs: [...state.tabs, newTab], activeTabId: id };
    }

    case 'PIN_TAB': {
      const tabs = state.tabs.map(t => (t.id === action.id ? { ...t, preview: false } : t));
      return { ...state, tabs };
    }

    case 'SET_DIRTY': {
      const tabs = state.tabs.map(t => (t.id === action.id ? { ...t, dirty: action.dirty } : t));
      return { ...state, tabs };
    }

    case 'CLOSE_TAB': {
      const tabs = state.tabs.filter(t => t.id !== action.id);
      let activeTabId = state.activeTabId;
      if (activeTabId === action.id) {
        // Activate the next tab, or the previous one, or null
        const idx = state.tabs.findIndex(t => t.id === action.id);
        if (tabs.length === 0) {
          activeTabId = null;
        } else if (idx >= tabs.length) {
          activeTabId = tabs[tabs.length - 1].id;
        } else {
          activeTabId = tabs[idx].id;
        }
      }
      return { tabs, activeTabId };
    }

    case 'ACTIVATE_TAB': {
      if (!state.tabs.some(t => t.id === action.id)) return state;
      return { ...state, activeTabId: action.id };
    }

    default:
      return state;
  }
}

// ── Split state (multiple side-by-side tab groups) ────────────

export interface SplitState {
  splits: TabState[];
  activeSplitIndex: number;
}

export type SplitAction =
  | { type: 'SPLIT_RIGHT'; tabId: string }
  | { type: 'ACTIVATE_SPLIT'; splitIndex: number }
  | { type: 'SPLIT_TAB'; splitIndex: number; action: TabAction };

export function createInitialSplitState(): SplitState {
  return { splits: [createInitialTabState()], activeSplitIndex: 0 };
}

/** Check if all splits are empty (no tabs in any split). */
export function isSplitEmpty(state: SplitState): boolean {
  return state.splits.every(s => s.tabs.length === 0);
}

/** Get all tabs across all splits. */
export function getAllSplitTabs(state: SplitState): EditorTab[] {
  return state.splits.flatMap(s => s.tabs);
}

/** Get the active split's TabState. */
export function getActiveSplit(state: SplitState): TabState {
  return state.splits[state.activeSplitIndex] ?? createInitialTabState();
}

/** Find which split index contains a given tab id. Returns -1 if not found. */
export function findSplitForTab(state: SplitState, id: string): number {
  return state.splits.findIndex(s => s.tabs.some(t => t.id === id));
}

export function splitReducer(state: SplitState, action: SplitAction): SplitState {
  switch (action.type) {
    case 'SPLIT_RIGHT': {
      // Find the tab to split into a new pane
      const srcIdx = findSplitForTab(state, action.tabId);
      if (srcIdx === -1) return state;
      const tab = state.splits[srcIdx].tabs.find(t => t.id === action.tabId);
      if (!tab) return state;

      // Create a new split with a pinned copy of the tab
      const newSplit: TabState = {
        tabs: [{ ...tab, preview: false }],
        activeTabId: tab.id,
      };

      // Insert new split after the source split
      const newSplits = [
        ...state.splits.slice(0, srcIdx + 1),
        newSplit,
        ...state.splits.slice(srcIdx + 1),
      ];

      return {
        splits: newSplits,
        activeSplitIndex: srcIdx + 1,
      };
    }

    case 'ACTIVATE_SPLIT': {
      if (action.splitIndex < 0 || action.splitIndex >= state.splits.length) return state;
      return { ...state, activeSplitIndex: action.splitIndex };
    }

    case 'SPLIT_TAB': {
      const { splitIndex, action: tabAction } = action;
      if (splitIndex < 0 || splitIndex >= state.splits.length) return state;

      const updatedSplit = tabReducer(state.splits[splitIndex], tabAction);
      let newSplits = state.splits.map((s, i) => (i === splitIndex ? updatedSplit : s));

      // If the split is now empty and there are other splits, remove it
      if (updatedSplit.tabs.length === 0 && newSplits.length > 1) {
        newSplits = newSplits.filter((_, i) => i !== splitIndex);
        const newActiveIdx =
          state.activeSplitIndex >= newSplits.length
            ? newSplits.length - 1
            : state.activeSplitIndex > splitIndex
              ? state.activeSplitIndex - 1
              : state.activeSplitIndex;
        return { splits: newSplits, activeSplitIndex: newActiveIdx };
      }

      return { ...state, splits: newSplits };
    }

    default:
      return state;
  }
}
