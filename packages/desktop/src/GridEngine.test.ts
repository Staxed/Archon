import { describe, expect, test } from 'bun:test';
import {
  gridReducer,
  findFreeSlot,
  GRID_COLS,
  GRID_ROWS,
  MAX_PANES,
  type GridState,
  type GridPane,
} from './GridEngine';

function makePane(overrides: Partial<GridPane> = {}): GridPane {
  return {
    id: 'p1',
    name: 'Pane 1',
    host: 'linux-beast',
    cwd: '/home/staxed',
    sessionName: 'archon-desktop:test:p1',
    x: 0,
    y: 0,
    w: 1,
    h: 1,
    ...overrides,
  };
}

function emptyState(): GridState {
  return { panes: [], maximizedId: null };
}

// ── ADD_PANE ──────────────────────────────────────────────────

describe('gridReducer - ADD_PANE', () => {
  test('adds a pane to empty state', () => {
    const pane = makePane();
    const result = gridReducer(emptyState(), { type: 'ADD_PANE', pane });
    expect(result.panes).toHaveLength(1);
    expect(result.panes[0]).toEqual(pane);
  });

  test('rejects duplicate pane id', () => {
    const pane = makePane();
    const state: GridState = { panes: [pane], maximizedId: null };
    const result = gridReducer(state, { type: 'ADD_PANE', pane });
    expect(result.panes).toHaveLength(1);
  });

  test('rejects when at max capacity', () => {
    const panes = Array.from({ length: MAX_PANES }, (_, i) =>
      makePane({ id: `p${i}`, x: i % GRID_COLS, y: Math.floor(i / GRID_COLS) })
    );
    const state: GridState = { panes, maximizedId: null };
    const result = gridReducer(state, { type: 'ADD_PANE', pane: makePane({ id: 'extra' }) });
    expect(result.panes).toHaveLength(MAX_PANES);
  });
});

// ── REMOVE_PANE ───────────────────────────────────────────────

describe('gridReducer - REMOVE_PANE', () => {
  test('removes a pane by id', () => {
    const pane = makePane();
    const state: GridState = { panes: [pane], maximizedId: null };
    const result = gridReducer(state, { type: 'REMOVE_PANE', id: 'p1' });
    expect(result.panes).toHaveLength(0);
  });

  test('clears maximizedId if maximized pane is removed', () => {
    const pane = makePane();
    const state: GridState = { panes: [pane], maximizedId: 'p1' };
    const result = gridReducer(state, { type: 'REMOVE_PANE', id: 'p1' });
    expect(result.maximizedId).toBeNull();
  });

  test('preserves maximizedId if different pane is removed', () => {
    const p1 = makePane({ id: 'p1' });
    const p2 = makePane({ id: 'p2', x: 1 });
    const state: GridState = { panes: [p1, p2], maximizedId: 'p1' };
    const result = gridReducer(state, { type: 'REMOVE_PANE', id: 'p2' });
    expect(result.maximizedId).toBe('p1');
    expect(result.panes).toHaveLength(1);
  });

  test('no-op for non-existent pane id', () => {
    const pane = makePane();
    const state: GridState = { panes: [pane], maximizedId: null };
    const result = gridReducer(state, { type: 'REMOVE_PANE', id: 'nonexistent' });
    expect(result.panes).toHaveLength(1);
  });
});

// ── MOVE_PANE ─────────────────────────────────────────────────

describe('gridReducer - MOVE_PANE', () => {
  test('updates pane position', () => {
    const pane = makePane();
    const state: GridState = { panes: [pane], maximizedId: null };
    const result = gridReducer(state, { type: 'MOVE_PANE', id: 'p1', x: 3, y: 2 });
    expect(result.panes[0].x).toBe(3);
    expect(result.panes[0].y).toBe(2);
  });
});

// ── RESIZE_PANE ───────────────────────────────────────────────

describe('gridReducer - RESIZE_PANE', () => {
  test('updates pane size', () => {
    const pane = makePane();
    const state: GridState = { panes: [pane], maximizedId: null };
    const result = gridReducer(state, { type: 'RESIZE_PANE', id: 'p1', w: 3, h: 2 });
    expect(result.panes[0].w).toBe(3);
    expect(result.panes[0].h).toBe(2);
  });
});

// ── RENAME_PANE ───────────────────────────────────────────────

describe('gridReducer - RENAME_PANE', () => {
  test('updates pane name', () => {
    const pane = makePane();
    const state: GridState = { panes: [pane], maximizedId: null };
    const result = gridReducer(state, { type: 'RENAME_PANE', id: 'p1', name: 'New Name' });
    expect(result.panes[0].name).toBe('New Name');
  });
});

// ── TOGGLE_MAXIMIZE ───────────────────────────────────────────

describe('gridReducer - TOGGLE_MAXIMIZE', () => {
  test('maximizes a pane', () => {
    const pane = makePane();
    const state: GridState = { panes: [pane], maximizedId: null };
    const result = gridReducer(state, { type: 'TOGGLE_MAXIMIZE', id: 'p1' });
    expect(result.maximizedId).toBe('p1');
  });

  test('un-maximizes when toggled again', () => {
    const pane = makePane();
    const state: GridState = { panes: [pane], maximizedId: 'p1' };
    const result = gridReducer(state, { type: 'TOGGLE_MAXIMIZE', id: 'p1' });
    expect(result.maximizedId).toBeNull();
  });

  test('switches maximized pane when toggling a different one', () => {
    const p1 = makePane({ id: 'p1' });
    const p2 = makePane({ id: 'p2', x: 1 });
    const state: GridState = { panes: [p1, p2], maximizedId: 'p1' };
    const result = gridReducer(state, { type: 'TOGGLE_MAXIMIZE', id: 'p2' });
    expect(result.maximizedId).toBe('p2');
  });
});

// ── LAYOUT_CHANGE ─────────────────────────────────────────────

describe('gridReducer - LAYOUT_CHANGE', () => {
  test('updates positions from layout array', () => {
    const p1 = makePane({ id: 'p1', x: 0, y: 0 });
    const p2 = makePane({ id: 'p2', x: 1, y: 0 });
    const state: GridState = { panes: [p1, p2], maximizedId: null };
    const result = gridReducer(state, {
      type: 'LAYOUT_CHANGE',
      layouts: [
        { i: 'p1', x: 2, y: 1, w: 2, h: 2 },
        { i: 'p2', x: 4, y: 0, w: 1, h: 1 },
      ],
    });
    expect(result.panes[0]).toMatchObject({ x: 2, y: 1, w: 2, h: 2 });
    expect(result.panes[1]).toMatchObject({ x: 4, y: 0, w: 1, h: 1 });
  });

  test('preserves panes not in layout update', () => {
    const pane = makePane();
    const state: GridState = { panes: [pane], maximizedId: null };
    const result = gridReducer(state, {
      type: 'LAYOUT_CHANGE',
      layouts: [{ i: 'nonexistent', x: 5, y: 2, w: 1, h: 1 }],
    });
    expect(result.panes[0]).toMatchObject({ x: 0, y: 0 });
  });
});

// ── findFreeSlot ──────────────────────────────────────────────

describe('findFreeSlot', () => {
  test('returns (0,0) for empty grid', () => {
    const slot = findFreeSlot([], 1, 1);
    expect(slot).toEqual({ x: 0, y: 0 });
  });

  test('finds next free slot after occupied', () => {
    const panes = [makePane({ id: 'p1', x: 0, y: 0, w: 1, h: 1 })];
    const slot = findFreeSlot(panes, 1, 1);
    expect(slot).toEqual({ x: 1, y: 0 });
  });

  test('finds slot for 2x2 pane', () => {
    const panes = [
      makePane({ id: 'p1', x: 0, y: 0, w: 1, h: 1 }),
      makePane({ id: 'p2', x: 1, y: 0, w: 1, h: 1 }),
    ];
    const slot = findFreeSlot(panes, 2, 2);
    expect(slot).toEqual({ x: 2, y: 0 });
  });

  test('returns null when grid is full', () => {
    const panes = Array.from({ length: MAX_PANES }, (_, i) =>
      makePane({ id: `p${i}`, x: i % GRID_COLS, y: Math.floor(i / GRID_COLS), w: 1, h: 1 })
    );
    const slot = findFreeSlot(panes, 1, 1);
    expect(slot).toBeNull();
  });

  test('returns null when pane too large for remaining space', () => {
    // Fill first two rows completely
    const panes = Array.from({ length: GRID_COLS * 2 }, (_, i) =>
      makePane({ id: `p${i}`, x: i % GRID_COLS, y: Math.floor(i / GRID_COLS), w: 1, h: 1 })
    );
    // Try to fit a 2-row-tall pane — only 1 row left
    const slot = findFreeSlot(panes, 1, 2);
    expect(slot).toBeNull();
  });

  test('fits pane in gap between occupied slots', () => {
    // Occupy (0,0) and (2,0), leaving (1,0) free
    const panes = [
      makePane({ id: 'p1', x: 0, y: 0, w: 1, h: 1 }),
      makePane({ id: 'p2', x: 2, y: 0, w: 1, h: 1 }),
    ];
    const slot = findFreeSlot(panes, 1, 1);
    expect(slot).toEqual({ x: 1, y: 0 });
  });
});

// ── Constants ─────────────────────────────────────────────────

describe('Grid constants', () => {
  test('grid dimensions are 6x3', () => {
    expect(GRID_COLS).toBe(6);
    expect(GRID_ROWS).toBe(3);
  });

  test('max panes is 18', () => {
    expect(MAX_PANES).toBe(18);
  });
});
