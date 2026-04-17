import { describe, test, expect, beforeEach } from 'bun:test';
import {
  toSlug,
  migrateProfile,
  listProfiles,
  getProfile,
  saveProfile,
  deleteProfile,
  launchProfileSchema,
  profilePaneSchema,
  startupActionSchema,
} from './LaunchProfile';
import type { LaunchProfile, ProfilePane } from './LaunchProfile';

// ── localStorage mock ────────────────────────────────────────────

const storage = new Map<string, string>();

// @ts-expect-error — minimal localStorage mock for testing
globalThis.localStorage = {
  getItem: (key: string): string | null => storage.get(key) ?? null,
  setItem: (key: string, value: string): void => {
    storage.set(key, value);
  },
  removeItem: (key: string): void => {
    storage.delete(key);
  },
  clear: (): void => {
    storage.clear();
  },
};

beforeEach(() => {
  storage.clear();
});

// ── Helper ───────────────────────────────────────────────────────

function makeProfile(overrides?: Partial<LaunchProfile>): LaunchProfile {
  return {
    id: 'p-1',
    name: 'Workspace One',
    slug: 'workspace-one',
    createdAt: '2026-04-17T00:00:00.000Z',
    panes: [],
    ...overrides,
  };
}

function makePane(overrides?: Partial<ProfilePane>): ProfilePane {
  return {
    id: 'pane-1',
    name: 'Terminal 1',
    type: 'terminal',
    host: 'linux-beast',
    cwd: '/home/staxed',
    x: 0,
    y: 0,
    w: 2,
    h: 1,
    ...overrides,
  };
}

// ── Schema tests ─────────────────────────────────────────────────

describe('Zod schemas', () => {
  test('startupActionSchema validates none', () => {
    const result = startupActionSchema.safeParse({ kind: 'none' });
    expect(result.success).toBe(true);
  });

  test('startupActionSchema validates agent with modelOverride', () => {
    const result = startupActionSchema.safeParse({
      kind: 'agent',
      presetId: 'claude-yolo',
      modelOverride: 'opus',
    });
    expect(result.success).toBe(true);
  });

  test('startupActionSchema rejects invalid kind', () => {
    const result = startupActionSchema.safeParse({ kind: 'invalid' });
    expect(result.success).toBe(false);
  });

  test('profilePaneSchema validates a full pane', () => {
    const result = profilePaneSchema.safeParse(makePane());
    expect(result.success).toBe(true);
  });

  test('profilePaneSchema rejects x > 5', () => {
    const result = profilePaneSchema.safeParse(makePane({ x: 6 }));
    expect(result.success).toBe(false);
  });

  test('profilePaneSchema rejects w > 6', () => {
    const result = profilePaneSchema.safeParse(makePane({ w: 7 }));
    expect(result.success).toBe(false);
  });

  test('launchProfileSchema validates a full profile', () => {
    const result = launchProfileSchema.safeParse(makeProfile({ panes: [makePane()] }));
    expect(result.success).toBe(true);
  });
});

// ── toSlug tests ─────────────────────────────────────────────────

describe('toSlug', () => {
  test('converts spaces to hyphens', () => {
    expect(toSlug('Workspace One')).toBe('workspace-one');
  });

  test('strips special characters', () => {
    expect(toSlug('My Profile #1!')).toBe('my-profile-1');
  });

  test('trims leading/trailing hyphens', () => {
    expect(toSlug('  Hello World  ')).toBe('hello-world');
  });
});

// ── migrateProfile tests ─────────────────────────────────────────

describe('migrateProfile', () => {
  test('returns null for non-objects', () => {
    expect(migrateProfile(null)).toBeNull();
    expect(migrateProfile('string')).toBeNull();
    expect(migrateProfile(42)).toBeNull();
  });

  test('returns null if id is missing', () => {
    expect(migrateProfile({ name: 'test' })).toBeNull();
  });

  test('fills defaults for missing fields', () => {
    const result = migrateProfile({ id: 'test-id' });
    expect(result).not.toBeNull();
    expect(result!.name).toBe('Untitled');
    expect(result!.slug).toBe('untitled');
    expect(result!.panes).toEqual([]);
    expect(result!.createdAt).toBeTruthy();
  });

  test('preserves existing valid fields', () => {
    const result = migrateProfile({
      id: 'test-id',
      name: 'My Profile',
      slug: 'my-profile',
      createdAt: '2026-01-01T00:00:00Z',
      panes: [],
    });
    expect(result).toEqual({
      id: 'test-id',
      name: 'My Profile',
      slug: 'my-profile',
      createdAt: '2026-01-01T00:00:00Z',
      panes: [],
    });
  });

  test('migrates panes with missing fields to defaults', () => {
    const result = migrateProfile({
      id: 'test-id',
      panes: [{ id: 'p1', name: 'Shell' }],
    });
    expect(result).not.toBeNull();
    expect(result!.panes).toHaveLength(1);
    expect(result!.panes[0].type).toBe('terminal');
    expect(result!.panes[0].host).toBe('local-windows');
    expect(result!.panes[0].w).toBe(1);
    expect(result!.panes[0].h).toBe(1);
  });

  test('drops invalid panes silently', () => {
    const result = migrateProfile({
      id: 'test-id',
      panes: [{ id: 'p1', name: 'Shell' }, 'not-an-object', { id: 'p2', name: 'Good', x: 1 }],
    });
    expect(result).not.toBeNull();
    expect(result!.panes).toHaveLength(2);
  });

  test('handles older shape without slug field', () => {
    const result = migrateProfile({
      id: 'old-id',
      name: 'Legacy Profile',
      createdAt: '2025-01-01T00:00:00Z',
      panes: [],
    });
    expect(result).not.toBeNull();
    expect(result!.slug).toBe('legacy-profile');
  });
});

// ── CRUD tests ───────────────────────────────────────────────────

describe('CRUD helpers', () => {
  test('listProfiles returns empty array when no data', () => {
    expect(listProfiles()).toEqual([]);
  });

  test('saveProfile + listProfiles round-trip', () => {
    const profile = makeProfile({ panes: [makePane()] });
    saveProfile(profile);
    const profiles = listProfiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0].id).toBe('p-1');
    expect(profiles[0].panes).toHaveLength(1);
  });

  test('saveProfile updates existing profile', () => {
    saveProfile(makeProfile({ name: 'Original' }));
    saveProfile(makeProfile({ name: 'Updated' }));
    const profiles = listProfiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0].name).toBe('Updated');
  });

  test('getProfile returns matching profile', () => {
    saveProfile(makeProfile());
    const result = getProfile('p-1');
    expect(result).toBeDefined();
    expect(result!.id).toBe('p-1');
  });

  test('getProfile returns undefined for missing', () => {
    expect(getProfile('nonexistent')).toBeUndefined();
  });

  test('deleteProfile removes the profile', () => {
    saveProfile(makeProfile({ id: 'p-1' }));
    saveProfile(makeProfile({ id: 'p-2', name: 'Second', slug: 'second' }));
    deleteProfile('p-1');
    const profiles = listProfiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0].id).toBe('p-2');
  });

  test('deleteProfile is no-op for missing id', () => {
    saveProfile(makeProfile());
    deleteProfile('nonexistent');
    expect(listProfiles()).toHaveLength(1);
  });

  test('listProfiles handles corrupted localStorage gracefully', () => {
    storage.set('archon-desktop:profiles', 'not-valid-json!!!');
    expect(listProfiles()).toEqual([]);
  });

  test('listProfiles handles non-array JSON gracefully', () => {
    storage.set('archon-desktop:profiles', '{"foo": "bar"}');
    expect(listProfiles()).toEqual([]);
  });

  test('full round-trip with migration on read', () => {
    // Simulate older data shape saved by previous version
    const oldData = [
      {
        id: 'migrated-1',
        name: 'Old Profile',
        // missing slug and createdAt
        panes: [
          { id: 'mp1', name: 'Shell', cwd: '/home' },
          // missing type, host, x, y, w, h — should get defaults
        ],
      },
    ];
    storage.set('archon-desktop:profiles', JSON.stringify(oldData));

    const profiles = listProfiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0].slug).toBe('old-profile');
    expect(profiles[0].createdAt).toBeTruthy();
    expect(profiles[0].panes).toHaveLength(1);
    expect(profiles[0].panes[0].type).toBe('terminal');
    expect(profiles[0].panes[0].w).toBe(1);
  });
});
