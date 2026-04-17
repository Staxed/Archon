import { z } from 'zod';

// ── Zod Schemas (source of truth) ────────────────────────────────

export const startupActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({
    kind: z.literal('agent'),
    presetId: z.string(),
    modelOverride: z.string().optional(),
  }),
]);

export const profilePaneSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(['terminal', 'editor']),
  host: z.string(),
  cwd: z.string(),
  x: z.number().int().min(0).max(5),
  y: z.number().int().min(0).max(2),
  w: z.number().int().min(1).max(6),
  h: z.number().int().min(1).max(3),
  startupAction: startupActionSchema.optional(),
  initialFile: z.string().optional(),
});

export const launchProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  createdAt: z.string(),
  panes: z.array(profilePaneSchema),
});

// ── Derived types ────────────────────────────────────────────────

export type StartupAction = z.infer<typeof startupActionSchema>;
export type ProfilePane = z.infer<typeof profilePaneSchema>;
export type LaunchProfile = z.infer<typeof launchProfileSchema>;

// ── Storage key ──────────────────────────────────────────────────

const PROFILES_STORAGE_KEY = 'archon-desktop:profiles';

// ── Slug helper ──────────────────────────────────────────────────

export function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// ── Migration-safe parsing ───────────────────────────────────────

/**
 * Parse a single profile from raw JSON, applying defaults for missing fields.
 * Returns null if the object is not recoverable (e.g., missing id).
 */
export function migrateProfile(raw: unknown): LaunchProfile | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  if (typeof obj.id !== 'string' || !obj.id) return null;

  const name = typeof obj.name === 'string' ? obj.name : 'Untitled';
  const slug = typeof obj.slug === 'string' ? obj.slug : toSlug(name);
  const createdAt = typeof obj.createdAt === 'string' ? obj.createdAt : new Date().toISOString();

  const rawPanes = Array.isArray(obj.panes) ? obj.panes : [];
  const panes: ProfilePane[] = [];
  for (const p of rawPanes) {
    if (typeof p !== 'object' || p === null) continue;
    const result = profilePaneSchema.safeParse({
      id:
        typeof (p as Record<string, unknown>).id === 'string'
          ? (p as Record<string, unknown>).id
          : crypto.randomUUID(),
      name:
        typeof (p as Record<string, unknown>).name === 'string'
          ? (p as Record<string, unknown>).name
          : 'Pane',
      type: (p as Record<string, unknown>).type === 'editor' ? 'editor' : 'terminal',
      host:
        typeof (p as Record<string, unknown>).host === 'string'
          ? (p as Record<string, unknown>).host
          : 'local-windows',
      cwd:
        typeof (p as Record<string, unknown>).cwd === 'string'
          ? (p as Record<string, unknown>).cwd
          : '/',
      x:
        typeof (p as Record<string, unknown>).x === 'number' ? (p as Record<string, unknown>).x : 0,
      y:
        typeof (p as Record<string, unknown>).y === 'number' ? (p as Record<string, unknown>).y : 0,
      w:
        typeof (p as Record<string, unknown>).w === 'number' ? (p as Record<string, unknown>).w : 1,
      h:
        typeof (p as Record<string, unknown>).h === 'number' ? (p as Record<string, unknown>).h : 1,
      startupAction: (p as Record<string, unknown>).startupAction,
      initialFile: (p as Record<string, unknown>).initialFile,
    });
    if (result.success) {
      panes.push(result.data);
    }
  }

  return { id: obj.id, name, slug, createdAt, panes };
}

// ── CRUD helpers ─────────────────────────────────────────────────

/**
 * Load all profiles from localStorage.
 * In a real Tauri app this would use Tauri's fs API to read from
 * the per-OS app-data directory (profiles.json).
 */
export function listProfiles(): LaunchProfile[] {
  try {
    const raw = localStorage.getItem(PROFILES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const profiles: LaunchProfile[] = [];
    for (const item of parsed) {
      const profile = migrateProfile(item);
      if (profile) profiles.push(profile);
    }
    return profiles;
  } catch {
    return [];
  }
}

/**
 * Get a single profile by ID.
 */
export function getProfile(id: string): LaunchProfile | undefined {
  return listProfiles().find(p => p.id === id);
}

/**
 * Save (create or update) a profile. If a profile with the same ID exists, it is replaced.
 */
export function saveProfile(profile: LaunchProfile): void {
  const profiles = listProfiles();
  const idx = profiles.findIndex(p => p.id === profile.id);
  if (idx >= 0) {
    profiles[idx] = profile;
  } else {
    profiles.push(profile);
  }
  localStorage.setItem(PROFILES_STORAGE_KEY, JSON.stringify(profiles));
}

/**
 * Delete a profile by ID. No-op if not found.
 */
export function deleteProfile(id: string): void {
  const profiles = listProfiles().filter(p => p.id !== id);
  localStorage.setItem(PROFILES_STORAGE_KEY, JSON.stringify(profiles));
}
