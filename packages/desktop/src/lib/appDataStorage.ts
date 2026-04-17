/**
 * Bridge between the sync-facing storage API used by the UI and Tauri's
 * async app-data filesystem.
 *
 * Problem this solves:
 *   Workspace roots and agent presets need to live as JSON files at the
 *   per-OS app-data path (PRD §10.6, §10.8, §13 Decision 9). The original
 *   implementation used localStorage, which is WebView-scoped and can be
 *   wiped by the OS.
 *
 * How it works:
 *   1. At app start, `hydrateAppData()` reads each registered file from
 *      AppData and populates localStorage. Callers (React useState
 *      initializers) then read synchronously from localStorage and see
 *      the persisted data.
 *   2. Every write goes through `writeAppData()`, which updates
 *      localStorage immediately (so subsequent sync reads see the new
 *      value) and fires an async write to the AppData JSON file.
 *
 *   localStorage is still the in-session cache but is no longer the
 *   source of truth — the AppData JSON wins on next hydrate.
 *
 * Tauri vs browser detection:
 *   Outside Tauri (vitest/jsdom, Vite dev in a regular browser tab) the
 *   plugin-fs import fails or `isTauri()` returns false. Writes degrade
 *   gracefully to localStorage-only. This keeps the test suite running
 *   without a Tauri runtime.
 */

const APP_DATA_SUBDIR = 'ArchonDesktop';

/**
 * Lazy-loaded Tauri plugin-fs module. `null` means we aren't running
 * inside Tauri; `undefined` means we haven't tried yet.
 *
 * The union type is intentional — we check for it and skip all FS work
 * when the plugin isn't available rather than throwing.
 */
type FsPlugin = typeof import('@tauri-apps/plugin-fs');
let fsPluginCache: FsPlugin | null | undefined;

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function loadFsPlugin(): Promise<FsPlugin | null> {
  if (fsPluginCache !== undefined) return fsPluginCache;
  if (!isTauri()) {
    fsPluginCache = null;
    return null;
  }
  try {
    const mod = await import('@tauri-apps/plugin-fs');
    fsPluginCache = mod;
    return mod;
  } catch (e) {
    console.warn('[appDataStorage] @tauri-apps/plugin-fs failed to load:', e);
    fsPluginCache = null;
    return null;
  }
}

/**
 * Description of one file managed by this module. `storageKey` is the
 * localStorage key callers already use; `filename` is the basename of
 * the JSON file inside the ArchonDesktop app-data subdirectory.
 */
export interface AppDataFileSpec {
  storageKey: string;
  filename: string;
}

/**
 * Read a single file from AppData. Returns `null` if the file is missing,
 * if the plugin isn't available, or if anything goes wrong — no exception
 * should ever escape into the React render tree.
 */
async function readAppDataFile(filename: string): Promise<string | null> {
  const fs = await loadFsPlugin();
  if (!fs) return null;
  try {
    const path = `${APP_DATA_SUBDIR}/${filename}`;
    const exists = await fs.exists(path, { baseDir: fs.BaseDirectory.AppData });
    if (!exists) return null;
    return await fs.readTextFile(path, { baseDir: fs.BaseDirectory.AppData });
  } catch (e) {
    console.warn(`[appDataStorage] failed to read ${filename}:`, e);
    return null;
  }
}

/**
 * Write a single file to AppData. Creates the ArchonDesktop subdirectory
 * if it doesn't yet exist. Silent on failure — failing a write must not
 * crash the app.
 */
async function writeAppDataFile(filename: string, data: string): Promise<void> {
  const fs = await loadFsPlugin();
  if (!fs) return;
  try {
    await fs.mkdir(APP_DATA_SUBDIR, {
      baseDir: fs.BaseDirectory.AppData,
      recursive: true,
    });
    await fs.writeTextFile(`${APP_DATA_SUBDIR}/${filename}`, data, {
      baseDir: fs.BaseDirectory.AppData,
    });
  } catch (e) {
    console.warn(`[appDataStorage] failed to write ${filename}:`, e);
  }
}

/**
 * Hydrate localStorage from AppData JSON files. Must be awaited before
 * the first React render so sync `loadWorkspace()` / `listPresets()`
 * calls see the persisted data.
 *
 * If a file exists in AppData, its contents replace the localStorage
 * value. If AppData has no file but localStorage does, the localStorage
 * value is promoted to AppData on next write — no explicit migration
 * step needed.
 *
 * Idempotent.
 */
export async function hydrateAppData(specs: AppDataFileSpec[]): Promise<void> {
  if (!isTauri()) return;
  await Promise.all(
    specs.map(async ({ storageKey, filename }) => {
      const value = await readAppDataFile(filename);
      if (value !== null) {
        try {
          localStorage.setItem(storageKey, value);
        } catch (e) {
          console.warn(`[appDataStorage] localStorage.setItem failed for ${storageKey}:`, e);
        }
      }
    })
  );
}

/**
 * Write a value to both localStorage (sync, so subsequent reads see it)
 * and AppData (async, canonical). Fire-and-forget on the AppData side —
 * writes don't block UI.
 */
export function writeAppData(spec: AppDataFileSpec, data: string): void {
  try {
    localStorage.setItem(spec.storageKey, data);
  } catch (e) {
    console.warn(`[appDataStorage] localStorage.setItem failed for ${spec.storageKey}:`, e);
  }
  void writeAppDataFile(spec.filename, data);
}

/**
 * Read the current value for a spec, preferring localStorage (populated
 * by hydrate or by prior writes). Returns null if nothing is stored.
 */
export function readAppData(spec: AppDataFileSpec): string | null {
  try {
    return localStorage.getItem(spec.storageKey);
  } catch {
    return null;
  }
}

// ── Registered file specs ───────────────────────────────────────────
// Single source of truth for which files land where. `AddFolderModal.tsx`
// and `AgentPresets.ts` import these so the storageKey/filename pair
// stays consistent.

export const WORKSPACE_SPEC: AppDataFileSpec = {
  storageKey: 'archon-desktop:workspace',
  filename: 'workspace.json',
};

export const AGENT_PRESETS_SPEC: AppDataFileSpec = {
  storageKey: 'archon-desktop:agent-presets',
  filename: 'agents.json',
};

export const ALL_APP_DATA_SPECS: AppDataFileSpec[] = [WORKSPACE_SPEC, AGENT_PRESETS_SPEC];

/**
 * Test hook — lets tests reset the plugin cache so each test can decide
 * whether to simulate Tauri being present. Not for production use.
 */
export function resetFsPluginCacheForTests(): void {
  fsPluginCache = undefined;
}
