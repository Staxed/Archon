import { describe, it, expect, beforeEach } from 'bun:test';
import {
  snapWidth,
  SNAP_WIDTHS,
  loadEditorColumnState,
  saveEditorColumnState,
} from './EditorColumn';

// ── localStorage mock ───────────────────────────────────────────
let mockStorage: Record<string, string> = {};

Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key: string): string | null => mockStorage[key] ?? null,
    setItem: (key: string, value: string): void => {
      mockStorage[key] = value;
    },
    removeItem: (key: string): void => {
      delete mockStorage[key];
    },
    clear: (): void => {
      mockStorage = {};
    },
    get length(): number {
      return Object.keys(mockStorage).length;
    },
    key: (index: number): string | null => Object.keys(mockStorage)[index] ?? null,
  },
  writable: true,
  configurable: true,
});

beforeEach(() => {
  mockStorage = {};
});

// ── snapWidth tests ─────────────────────────────────────────────

describe('snapWidth', () => {
  it('snaps to 17% when within threshold', () => {
    expect(snapWidth(15)).toBe(17);
    expect(snapWidth(19)).toBe(17);
    expect(snapWidth(17)).toBe(17);
    expect(snapWidth(20)).toBe(17);
    expect(snapWidth(21)).toBe(17);
  });

  it('snaps to 33% when within threshold', () => {
    expect(snapWidth(31)).toBe(33);
    expect(snapWidth(35)).toBe(33);
    expect(snapWidth(33)).toBe(33);
  });

  it('snaps to 50% when within threshold', () => {
    expect(snapWidth(48)).toBe(50);
    expect(snapWidth(52)).toBe(50);
    expect(snapWidth(50)).toBe(50);
  });

  it('does not snap when far from all snap points', () => {
    // 25 is equidistant from 17 (8 away) and 33 (8 away) — both > threshold(4)
    expect(snapWidth(25)).toBe(25);
    // 42 is 9 from 33 and 8 from 50 — both > threshold
    expect(snapWidth(42)).toBe(42);
  });

  it('snaps to nearest when between two snap points', () => {
    // 24 is 7 from 17 and 9 from 33 — neither within threshold(4)
    expect(snapWidth(24)).toBe(24);
    // 30 is 3 from 33 — within threshold
    expect(snapWidth(30)).toBe(33);
    // 47 is 3 from 50 — within threshold
    expect(snapWidth(47)).toBe(50);
  });

  it('uses expected snap widths', () => {
    expect(SNAP_WIDTHS).toEqual([17, 33, 50]);
  });
});

// ── Persistence tests ───────────────────────────────────────────

describe('loadEditorColumnState', () => {
  it('returns defaults when no saved state', () => {
    const state = loadEditorColumnState();
    expect(state.collapsed).toBe(false);
    expect(state.width).toBe(17);
  });

  it('loads saved state', () => {
    saveEditorColumnState({ collapsed: true, width: 33 });
    const state = loadEditorColumnState();
    expect(state.collapsed).toBe(true);
    expect(state.width).toBe(33);
  });

  it('round-trips correctly', () => {
    const original = { collapsed: false, width: 50 };
    saveEditorColumnState(original);
    const loaded = loadEditorColumnState();
    expect(loaded).toEqual(original);
  });
});

describe('saveEditorColumnState', () => {
  it('preserves workspace roots when saving column state', () => {
    const wsKey = 'archon-desktop:workspace';
    mockStorage[wsKey] = JSON.stringify({
      roots: [{ id: 'r1', host: 'linux-beast', path: '/home', label: 'Home' }],
    });

    saveEditorColumnState({ collapsed: false, width: 33 });

    const ws = JSON.parse(mockStorage[wsKey]) as { roots: unknown[]; editorColumn: unknown };
    expect(ws.roots).toHaveLength(1);
    expect(ws.editorColumn).toEqual({ collapsed: false, width: 33 });
  });

  it('overwrites previous column state', () => {
    saveEditorColumnState({ collapsed: false, width: 17 });
    saveEditorColumnState({ collapsed: true, width: 50 });

    const state = loadEditorColumnState();
    expect(state.collapsed).toBe(true);
    expect(state.width).toBe(50);
  });
});

// ── Collapse/expand state logic ─────────────────────────────────

describe('collapse/expand state', () => {
  it('defaults to not collapsed', () => {
    const state = loadEditorColumnState();
    expect(state.collapsed).toBe(false);
  });

  it('persists collapsed state', () => {
    saveEditorColumnState({ collapsed: true, width: 17 });
    expect(loadEditorColumnState().collapsed).toBe(true);

    saveEditorColumnState({ collapsed: false, width: 17 });
    expect(loadEditorColumnState().collapsed).toBe(false);
  });

  it('preserves width when toggling collapse', () => {
    saveEditorColumnState({ collapsed: false, width: 33 });
    // Collapse: width is preserved for restoring later
    saveEditorColumnState({ collapsed: true, width: 33 });
    const state = loadEditorColumnState();
    expect(state.collapsed).toBe(true);
    expect(state.width).toBe(33);
  });
});
