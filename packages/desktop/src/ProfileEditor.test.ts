import { describe, test, expect, beforeEach } from 'bun:test';
import {
  createBlankProfile,
  createBlankPane,
  duplicateProfile,
  updatePaneField,
  removePane,
  addPane,
} from './ProfileEditor';
import type { LaunchProfile, ProfilePane } from './LaunchProfile';
import { saveProfile, listProfiles, deleteProfile, toSlug } from './LaunchProfile';

// ── localStorage mock ────────────────────────────────────────────

const store: Record<string, string> = {};
const localStorageMock = {
  getItem: (key: string): string | null => store[key] ?? null,
  setItem: (key: string, value: string): void => {
    store[key] = value;
  },
  removeItem: (key: string): void => {
    delete store[key];
  },
  clear: (): void => {
    for (const key of Object.keys(store)) {
      delete store[key];
    }
  },
  get length(): number {
    return Object.keys(store).length;
  },
  key: (_index: number): string | null => null,
};

// Use writable + configurable so this doesn't block other tests in the same process
Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
  configurable: true,
});

// ── Tests ────────────────────────────────────────────────────────

describe('createBlankProfile', () => {
  test('returns a profile with valid defaults', () => {
    const p = createBlankProfile();
    expect(p.id).toBeTruthy();
    expect(p.name).toBe('New Profile');
    expect(p.slug).toBe('new-profile');
    expect(p.panes).toEqual([]);
    expect(p.createdAt).toBeTruthy();
  });

  test('generates unique IDs', () => {
    const a = createBlankProfile();
    const b = createBlankProfile();
    expect(a.id).not.toBe(b.id);
  });
});

describe('createBlankPane', () => {
  test('returns a pane with valid defaults', () => {
    const p = createBlankPane();
    expect(p.id).toBeTruthy();
    expect(p.name).toBe('Pane');
    expect(p.type).toBe('terminal');
    expect(p.host).toBe('linux-beast');
    expect(p.cwd).toBe('/home');
    expect(p.x).toBe(0);
    expect(p.y).toBe(0);
    expect(p.w).toBe(1);
    expect(p.h).toBe(1);
  });
});

describe('duplicateProfile', () => {
  test('creates a copy with new ID and "(Copy)" suffix', () => {
    const original: LaunchProfile = {
      id: 'orig-id',
      name: 'My Profile',
      slug: 'my-profile',
      createdAt: '2026-01-01T00:00:00.000Z',
      panes: [
        {
          id: 'pane-1',
          name: 'Terminal',
          type: 'terminal',
          host: 'linux-beast',
          cwd: '/home',
          x: 0,
          y: 0,
          w: 2,
          h: 1,
        },
      ],
    };
    const dup = duplicateProfile(original);
    expect(dup.id).not.toBe(original.id);
    expect(dup.name).toBe('My Profile (Copy)');
    expect(dup.slug).toBe('my-profile-copy');
    expect(dup.panes.length).toBe(1);
    expect(dup.panes[0].id).not.toBe('pane-1');
    expect(dup.panes[0].name).toBe('Terminal');
    expect(dup.panes[0].w).toBe(2);
  });

  test('preserves pane data except ID', () => {
    const original: LaunchProfile = {
      id: 'p1',
      name: 'Test',
      slug: 'test',
      createdAt: '2026-01-01T00:00:00.000Z',
      panes: [
        {
          id: 'pane-a',
          name: 'Editor',
          type: 'editor',
          host: 'local-windows',
          cwd: 'C:\\Users',
          x: 1,
          y: 2,
          w: 3,
          h: 1,
          initialFile: 'test.ts',
        },
      ],
    };
    const dup = duplicateProfile(original);
    expect(dup.panes[0].type).toBe('editor');
    expect(dup.panes[0].host).toBe('local-windows');
    expect(dup.panes[0].initialFile).toBe('test.ts');
  });
});

describe('updatePaneField', () => {
  const baseProfile: LaunchProfile = {
    id: 'p1',
    name: 'Test',
    slug: 'test',
    createdAt: '2026-01-01T00:00:00.000Z',
    panes: [
      {
        id: 'pane-1',
        name: 'Terminal',
        type: 'terminal',
        host: 'linux-beast',
        cwd: '/home',
        x: 0,
        y: 0,
        w: 1,
        h: 1,
      },
      {
        id: 'pane-2',
        name: 'Editor',
        type: 'editor',
        host: 'local-windows',
        cwd: 'C:\\',
        x: 1,
        y: 0,
        w: 2,
        h: 1,
      },
    ],
  };

  test('updates a specific field on the target pane', () => {
    const updated = updatePaneField(baseProfile, 'pane-1', 'name', 'Renamed');
    expect(updated.panes[0].name).toBe('Renamed');
    expect(updated.panes[1].name).toBe('Editor');
  });

  test('updates numeric field', () => {
    const updated = updatePaneField(baseProfile, 'pane-2', 'w', 4);
    expect(updated.panes[1].w).toBe(4);
    expect(updated.panes[0].w).toBe(1);
  });

  test('does not mutate original', () => {
    const updated = updatePaneField(baseProfile, 'pane-1', 'cwd', '/tmp');
    expect(baseProfile.panes[0].cwd).toBe('/home');
    expect(updated.panes[0].cwd).toBe('/tmp');
  });
});

describe('removePane', () => {
  test('removes a pane by id', () => {
    const profile: LaunchProfile = {
      id: 'p1',
      name: 'Test',
      slug: 'test',
      createdAt: '2026-01-01T00:00:00.000Z',
      panes: [
        { id: 'a', name: 'A', type: 'terminal', host: 'h', cwd: '/', x: 0, y: 0, w: 1, h: 1 },
        { id: 'b', name: 'B', type: 'terminal', host: 'h', cwd: '/', x: 1, y: 0, w: 1, h: 1 },
      ],
    };
    const result = removePane(profile, 'a');
    expect(result.panes.length).toBe(1);
    expect(result.panes[0].id).toBe('b');
  });

  test('no-op for nonexistent pane', () => {
    const profile: LaunchProfile = {
      id: 'p1',
      name: 'Test',
      slug: 'test',
      createdAt: '2026-01-01T00:00:00.000Z',
      panes: [
        { id: 'a', name: 'A', type: 'terminal', host: 'h', cwd: '/', x: 0, y: 0, w: 1, h: 1 },
      ],
    };
    const result = removePane(profile, 'nonexistent');
    expect(result.panes.length).toBe(1);
  });
});

describe('addPane', () => {
  test('adds a pane to the profile', () => {
    const profile: LaunchProfile = {
      id: 'p1',
      name: 'Test',
      slug: 'test',
      createdAt: '2026-01-01T00:00:00.000Z',
      panes: [],
    };
    const pane: ProfilePane = {
      id: 'new-pane',
      name: 'New',
      type: 'terminal',
      host: 'linux-beast',
      cwd: '/home',
      x: 0,
      y: 0,
      w: 1,
      h: 1,
    };
    const result = addPane(profile, pane);
    expect(result.panes.length).toBe(1);
    expect(result.panes[0].id).toBe('new-pane');
  });
});

describe('persistence round-trip', () => {
  beforeEach(() => {
    localStorageMock.clear();
  });

  test('save → list → edit → save → list shows updated data', () => {
    const profile = createBlankProfile();
    profile.name = 'My Workspace';
    profile.slug = toSlug(profile.name);
    saveProfile(profile);

    let profiles = listProfiles();
    expect(profiles.length).toBe(1);
    expect(profiles[0].name).toBe('My Workspace');

    // Edit
    const edited = { ...profiles[0], name: 'Renamed Workspace', slug: toSlug('Renamed Workspace') };
    saveProfile(edited);
    profiles = listProfiles();
    expect(profiles.length).toBe(1);
    expect(profiles[0].name).toBe('Renamed Workspace');
  });

  test('duplicate creates a second profile', () => {
    const profile = createBlankProfile();
    profile.name = 'Original';
    profile.slug = toSlug(profile.name);
    saveProfile(profile);

    const dup = duplicateProfile(profile);
    saveProfile(dup);

    const profiles = listProfiles();
    expect(profiles.length).toBe(2);
    expect(profiles.find(p => p.name === 'Original')).toBeTruthy();
    expect(profiles.find(p => p.name === 'Original (Copy)')).toBeTruthy();
  });

  test('delete removes a profile', () => {
    const p1 = createBlankProfile();
    p1.name = 'Keep';
    saveProfile(p1);

    const p2 = createBlankProfile();
    p2.name = 'Remove';
    saveProfile(p2);

    deleteProfile(p2.id);
    const profiles = listProfiles();
    expect(profiles.length).toBe(1);
    expect(profiles[0].name).toBe('Keep');
  });

  test('save with panes persists pane data', () => {
    const profile = createBlankProfile();
    const pane = createBlankPane();
    pane.name = 'Claude YOLO';
    pane.startupAction = { kind: 'agent', presetId: 'claude-yolo' };
    const withPane = addPane(profile, pane);
    saveProfile(withPane);

    const loaded = listProfiles();
    expect(loaded[0].panes.length).toBe(1);
    expect(loaded[0].panes[0].name).toBe('Claude YOLO');
    expect(loaded[0].panes[0].startupAction).toEqual({ kind: 'agent', presetId: 'claude-yolo' });
  });
});
