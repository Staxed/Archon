/**
 * Save flow logic for the editor column.
 *
 * Handles remote file saves via PUT /api/desktop/fs/file with:
 * - expectedMtime for conflict detection
 * - 409 conflict handling with Reload/Overwrite options
 * - Ctrl+S / Cmd+S keyboard shortcut
 * - Dirty tab close guards
 *
 * Pure functions — no React dependency.
 */

// ── Types ──────────────────────────────────────────────────────

export interface SaveResult {
  kind: 'success';
  mtime: string;
}

export interface SaveConflict {
  kind: 'conflict';
  currentContent: string;
  currentMtime: string;
}

export interface SaveError {
  kind: 'error';
  message: string;
}

export type SaveOutcome = SaveResult | SaveConflict | SaveError;

export type FileMtimeMap = Record<string, string>;

// ── Save function ──────────────────────────────────────────────

/**
 * Save a file to the remote server via PUT /api/desktop/fs/file.
 *
 * @param serverUrl - Base URL of the Archon server
 * @param host - Remote host alias
 * @param filePath - Absolute path on the remote host
 * @param content - File content to write
 * @param expectedMtime - Optional mtime for conflict detection
 * @returns SaveOutcome describing success, conflict, or error
 */
export async function saveFile(
  serverUrl: string,
  host: string,
  filePath: string,
  content: string,
  expectedMtime?: string
): Promise<SaveOutcome> {
  const url = `${serverUrl}/api/desktop/fs/file?host=${encodeURIComponent(host)}&path=${encodeURIComponent(filePath)}`;
  const body: { content: string; expectedMtime?: string } = { content };
  if (expectedMtime) {
    body.expectedMtime = expectedMtime;
  }

  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      const data = (await res.json()) as { ok: boolean; mtime: string };
      return { kind: 'success', mtime: data.mtime };
    }

    if (res.status === 409) {
      const data = (await res.json()) as {
        error: string;
        currentContent: string;
        currentMtime: string;
      };
      return {
        kind: 'conflict',
        currentContent: data.currentContent,
        currentMtime: data.currentMtime,
      };
    }

    const text = await res.text();
    return { kind: 'error', message: `HTTP ${res.status}: ${text}` };
  } catch (err) {
    return { kind: 'error', message: (err as Error).message };
  }
}

// ── Keyboard shortcut detection ────────────────────────────────

/**
 * Returns true if the keyboard event is a save shortcut (Ctrl+S or Cmd+S).
 */
export function isSaveShortcut(e: KeyboardEvent): boolean {
  return (e.ctrlKey || e.metaKey) && e.key === 's';
}

// ── Dirty tab helpers ──────────────────────────────────────────

/**
 * Returns a list of dirty file names from the tab state.
 */
export function getDirtyFileNames(tabs: { dirty: boolean; name: string }[]): string[] {
  return tabs.filter(t => t.dirty).map(t => t.name);
}

/**
 * Returns true if any tab has unsaved changes.
 */
export function hasDirtyTabs(tabs: { dirty: boolean }[]): boolean {
  return tabs.some(t => t.dirty);
}
