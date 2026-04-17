import { describe, expect, test } from 'bun:test';
import { openAdHocTerminal } from './AdHocTerminal';
import type { GridPane } from './GridEngine';
import { GRID_COLS, GRID_ROWS } from './GridEngine';

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

describe('openAdHocTerminal', () => {
  test('creates a pane in empty grid at (0,0)', () => {
    const result = openAdHocTerminal([], { host: 'linux-beast', cwd: '/home/staxed' });
    expect(result.kind).toBe('pane');
    if (result.kind === 'pane') {
      expect(result.pane.x).toBe(0);
      expect(result.pane.y).toBe(0);
      expect(result.pane.w).toBe(1);
      expect(result.pane.h).toBe(1);
      expect(result.pane.host).toBe('linux-beast');
      expect(result.pane.cwd).toBe('/home/staxed');
    }
  });

  test('session name follows archon-desktop:adhoc:<uuid> pattern', () => {
    const result = openAdHocTerminal([], { host: 'linux-beast', cwd: '/home/user' });
    expect(result.kind).toBe('pane');
    if (result.kind === 'pane') {
      expect(result.pane.sessionName).toMatch(/^archon-desktop:adhoc:[0-9a-f-]{36}$/);
    }
  });

  test('pane id matches the uuid in session name', () => {
    const result = openAdHocTerminal([], { host: 'linux-beast', cwd: '/tmp' });
    expect(result.kind).toBe('pane');
    if (result.kind === 'pane') {
      const uuidFromSession = result.pane.sessionName.replace('archon-desktop:adhoc:', '');
      expect(result.pane.id).toBe(uuidFromSession);
    }
  });

  test('places pane in first free slot after occupied slots', () => {
    const panes = [makePane({ id: 'p1', x: 0, y: 0, w: 1, h: 1 })];
    const result = openAdHocTerminal(panes, { host: 'linux-beast', cwd: '/home/staxed' });
    expect(result.kind).toBe('pane');
    if (result.kind === 'pane') {
      expect(result.pane.x).toBe(1);
      expect(result.pane.y).toBe(0);
    }
  });

  test('returns toast when grid is full', () => {
    const fullGrid = Array.from({ length: GRID_COLS * GRID_ROWS }, (_, i) =>
      makePane({
        id: `p${i}`,
        x: i % GRID_COLS,
        y: Math.floor(i / GRID_COLS),
        w: 1,
        h: 1,
      })
    );
    const result = openAdHocTerminal(fullGrid, { host: 'linux-beast', cwd: '/home/staxed' });
    expect(result.kind).toBe('toast');
    if (result.kind === 'toast') {
      expect(result.message).toBe('Grid full — close a pane to open another');
    }
  });

  test('pane name includes short uuid prefix', () => {
    const result = openAdHocTerminal([], { host: 'linux-beast', cwd: '/tmp' });
    expect(result.kind).toBe('pane');
    if (result.kind === 'pane') {
      expect(result.pane.name).toMatch(/^adhoc-[0-9a-f]{8}$/);
    }
  });

  test('each call generates a unique pane id', () => {
    const result1 = openAdHocTerminal([], { host: 'h', cwd: '/' });
    const result2 = openAdHocTerminal([], { host: 'h', cwd: '/' });
    expect(result1.kind).toBe('pane');
    expect(result2.kind).toBe('pane');
    if (result1.kind === 'pane' && result2.kind === 'pane') {
      expect(result1.pane.id).not.toBe(result2.pane.id);
    }
  });
});
