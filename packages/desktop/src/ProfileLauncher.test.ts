import { describe, it, expect, beforeEach } from 'bun:test';
import {
  buildSessionName,
  resolveStartupPresetId,
  computeLaunchPanes,
  launchProfile,
} from './ProfileLauncher';
import type { LaunchProfile, ProfilePane } from './LaunchProfile';
import type { GridPane } from './GridEngine';

// ── localStorage mock ────────────────────────────────────────────

let store: Record<string, string> = {};

Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key: string): string | null => store[key] ?? null,
    setItem: (key: string, value: string): void => {
      store[key] = value;
    },
    removeItem: (key: string): void => {
      delete store[key];
    },
    clear: (): void => {
      store = {};
    },
    get length(): number {
      return Object.keys(store).length;
    },
    key: (index: number): string | null => Object.keys(store)[index] ?? null,
  },
  writable: true,
  configurable: true,
});

beforeEach(() => {
  store = {};
});

// ── Helpers ──────────────────────────────────────────────────────

function makeProfile(overrides?: Partial<LaunchProfile>): LaunchProfile {
  return {
    id: 'prof-1',
    name: 'Test Profile',
    slug: 'test-profile',
    createdAt: new Date().toISOString(),
    panes: [],
    ...overrides,
  };
}

function makeProfilePane(overrides?: Partial<ProfilePane>): ProfilePane {
  return {
    id: crypto.randomUUID(),
    name: 'Pane 1',
    type: 'terminal',
    host: 'linux-beast',
    cwd: '/home/user',
    x: 0,
    y: 0,
    w: 1,
    h: 1,
    ...overrides,
  };
}

function makeGridPane(overrides?: Partial<GridPane>): GridPane {
  return {
    id: crypto.randomUUID(),
    name: 'existing',
    host: 'linux-beast',
    cwd: '/home/user',
    sessionName: 'archon-desktop:test:existing',
    x: 0,
    y: 0,
    w: 1,
    h: 1,
    ...overrides,
  };
}

// ── buildSessionName ─────────────────────────────────────────────

describe('buildSessionName', () => {
  it('builds deterministic session name from profile slug and pane name', () => {
    expect(buildSessionName('my-workspace', 'Claude Agent')).toBe(
      'archon-desktop:my-workspace:claude-agent'
    );
  });

  it('handles special characters in pane name', () => {
    expect(buildSessionName('workspace-one', 'Pane #1 (YOLO)')).toBe(
      'archon-desktop:workspace-one:pane-1-yolo'
    );
  });

  it('handles empty pane name with fallback', () => {
    expect(buildSessionName('ws', '')).toBe('archon-desktop:ws:pane');
  });

  it('handles pane name with only special chars', () => {
    expect(buildSessionName('ws', '###')).toBe('archon-desktop:ws:pane');
  });
});

// ── resolveStartupPresetId ───────────────────────────────────────

describe('resolveStartupPresetId', () => {
  it('returns undefined for no startupAction', () => {
    const pane = makeProfilePane();
    expect(resolveStartupPresetId(pane)).toBeUndefined();
  });

  it('returns undefined for kind: none', () => {
    const pane = makeProfilePane({ startupAction: { kind: 'none' } });
    expect(resolveStartupPresetId(pane)).toBeUndefined();
  });

  it('returns presetId for kind: agent', () => {
    const pane = makeProfilePane({
      startupAction: { kind: 'agent', presetId: 'claude-yolo' },
    });
    expect(resolveStartupPresetId(pane)).toEqual({ presetId: 'claude-yolo' });
  });

  it('includes modelOverride when present', () => {
    const pane = makeProfilePane({
      startupAction: {
        kind: 'agent',
        presetId: 'openrouter-aichat',
        modelOverride: 'anthropic/claude-3-haiku',
      },
    });
    expect(resolveStartupPresetId(pane)).toEqual({
      presetId: 'openrouter-aichat',
      modelOverride: 'anthropic/claude-3-haiku',
    });
  });
});

// ── computeLaunchPanes ───────────────────────────────────────────

describe('computeLaunchPanes', () => {
  it('places all panes into an empty grid', () => {
    const profile = makeProfile({
      panes: [
        makeProfilePane({ name: 'A', w: 1, h: 1 }),
        makeProfilePane({ name: 'B', w: 1, h: 1 }),
        makeProfilePane({ name: 'C', w: 1, h: 1 }),
      ],
    });
    const result = computeLaunchPanes(profile, []);
    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.panes).toHaveLength(3);
      expect(result.warning).toBeUndefined();
    }
  });

  it('preserves pane w/h dimensions', () => {
    const profile = makeProfile({
      panes: [makeProfilePane({ name: 'Wide', w: 3, h: 2 })],
    });
    const result = computeLaunchPanes(profile, []);
    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.panes[0].w).toBe(3);
      expect(result.panes[0].h).toBe(2);
    }
  });

  it('places panes additively alongside existing panes', () => {
    const existing = [makeGridPane({ x: 0, y: 0, w: 1, h: 1 })];
    const profile = makeProfile({
      panes: [makeProfilePane({ name: 'New', w: 1, h: 1 })],
    });
    const result = computeLaunchPanes(profile, existing);
    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.panes).toHaveLength(1);
      // Should not overlap with existing pane at (0,0)
      const placed = result.panes[0];
      expect(placed.x !== 0 || placed.y !== 0).toBe(true);
    }
  });

  it('warns when not all panes fit', () => {
    // Fill grid with 17 existing panes, try to add 3 profile panes
    const existing: GridPane[] = [];
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 6; x++) {
        if (existing.length >= 17) break;
        existing.push(makeGridPane({ x, y, w: 1, h: 1, id: `existing-${x}-${y}` }));
      }
    }
    expect(existing).toHaveLength(17);

    const profile = makeProfile({
      panes: [
        makeProfilePane({ name: 'A' }),
        makeProfilePane({ name: 'B' }),
        makeProfilePane({ name: 'C' }),
      ],
    });

    const result = computeLaunchPanes(profile, existing);
    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.panes).toHaveLength(1); // Only 1 slot free
      expect(result.warning).toContain('Only 1 of 3 panes fit');
    }
  });

  it('returns empty panes array for empty profile', () => {
    const profile = makeProfile({ panes: [] });
    const result = computeLaunchPanes(profile, []);
    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.panes).toHaveLength(0);
    }
  });

  it('handles full grid with zero capacity', () => {
    const existing: GridPane[] = [];
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 6; x++) {
        existing.push(makeGridPane({ x, y, w: 1, h: 1, id: `e-${x}-${y}` }));
      }
    }
    expect(existing).toHaveLength(18);

    const profile = makeProfile({
      panes: [makeProfilePane({ name: 'No room' })],
    });

    const result = computeLaunchPanes(profile, existing);
    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.panes).toHaveLength(0);
      expect(result.warning).toContain('Only 0 of 1 panes fit');
    }
  });

  it('handles varying pane sizes', () => {
    const profile = makeProfile({
      panes: [
        makeProfilePane({ name: 'Big', w: 3, h: 2 }),
        makeProfilePane({ name: 'Small', w: 1, h: 1 }),
        makeProfilePane({ name: 'Medium', w: 2, h: 1 }),
      ],
    });
    const result = computeLaunchPanes(profile, []);
    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.panes).toHaveLength(3);
      expect(result.warning).toBeUndefined();
    }
  });

  it('assigns correct session names from profile slug', () => {
    const profile = makeProfile({
      slug: 'my-workspace',
      panes: [makeProfilePane({ name: 'Claude Agent' }), makeProfilePane({ name: 'Codex YOLO' })],
    });
    const result = computeLaunchPanes(profile, []);
    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.panes[0].sessionName).toBe('archon-desktop:my-workspace:claude-agent');
      expect(result.panes[1].sessionName).toBe('archon-desktop:my-workspace:codex-yolo');
    }
  });
});

// ── launchProfile ────────────────────────────────────────────────

describe('launchProfile', () => {
  it('returns error for missing profile', () => {
    const result = launchProfile('nonexistent', []);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).toContain('not found');
    }
  });

  it('launches a stored profile', () => {
    // Store a profile
    const profile = makeProfile({
      panes: [makeProfilePane({ name: 'Term 1' }), makeProfilePane({ name: 'Term 2' })],
    });
    localStorage.setItem('archon-desktop:profiles', JSON.stringify([profile]));

    const result = launchProfile('prof-1', []);
    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.panes).toHaveLength(2);
    }
  });

  it('respects existing panes for additive launch', () => {
    // Fill 17 slots
    const existing: GridPane[] = [];
    for (let i = 0; i < 17; i++) {
      existing.push(makeGridPane({ x: i % 6, y: Math.floor(i / 6), w: 1, h: 1, id: `e-${i}` }));
    }

    const profile = makeProfile({
      panes: [makeProfilePane({ name: 'A' }), makeProfilePane({ name: 'B' })],
    });
    localStorage.setItem('archon-desktop:profiles', JSON.stringify([profile]));

    const result = launchProfile('prof-1', existing);
    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.panes).toHaveLength(1);
      expect(result.warning).toBeDefined();
    }
  });
});
