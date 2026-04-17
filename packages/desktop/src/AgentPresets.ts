import { z } from 'zod';
import { AGENT_PRESETS_SPEC, readAppData, writeAppData } from './lib/appDataStorage';

// ── Zod Schemas (source of truth) ────────────────────────────────

export const agentPresetSchema = z.object({
  id: z.string(),
  label: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  env: z.record(z.string()).optional(),
  prompts: z.array(z.string()).optional(),
});

export type AgentPreset = z.infer<typeof agentPresetSchema>;

// ── Default presets per §10.8 ────────────────────────────────────

export const DEFAULT_PRESETS: AgentPreset[] = [
  { id: 'claude', label: 'Claude', command: 'claude', args: [] },
  {
    id: 'claude-yolo',
    label: 'Claude (YOLO)',
    command: 'claude',
    args: ['--dangerously-skip-permissions'],
  },
  { id: 'codex', label: 'Codex', command: 'codex', args: [] },
  { id: 'codex-yolo', label: 'Codex (YOLO)', command: 'codex', args: ['--yolo'] },
  { id: 'gemini', label: 'Gemini', command: 'gemini', args: [] },
  { id: 'gemini-yolo', label: 'Gemini (YOLO)', command: 'gemini', args: ['--approval-mode=yolo'] },
  {
    id: 'openrouter-aichat',
    label: 'OpenRouter (aichat)',
    command: 'aichat',
    args: ['-m', 'openrouter:{MODEL}'],
    prompts: ['MODEL'],
  },
  {
    id: 'llamacpp-aichat',
    label: 'Llama.cpp local (aichat)',
    command: 'aichat',
    args: ['-m', 'llamacpp:{MODEL}'],
    env: { LLAMACPP_API_BASE: 'http://localhost:8093/v1' },
    prompts: ['MODEL'],
  },
];

// ── Storage keys ─────────────────────────────────────────────────
//
// Presets themselves go through the AppData storage abstraction (canonical
// location: `%APPDATA%\ArchonDesktop\agents.json` on Windows,
// `~/Library/Application Support/ArchonDesktop/agents.json` on macOS — see
// PRD §10.8 / §13 Decision 9). `SEEDED_KEY` stays localStorage-only since
// "has the seed ever run" is a per-WebView concern, not user data worth
// persisting to disk.

const SEEDED_KEY = 'archon-desktop:agent-presets-seeded';

// ── Seed on first launch ─────────────────────────────────────────

/**
 * Ensure default presets are written on first launch.
 * Idempotent — does nothing if already seeded.
 */
export function seedDefaultPresets(): void {
  const seeded = localStorage.getItem(SEEDED_KEY);
  if (seeded === 'true') return;

  // Only seed if no presets exist yet (hydrateAppData may have loaded
  // user-edited presets from the AppData JSON before we got here)
  const existing = readAppData(AGENT_PRESETS_SPEC);
  if (!existing) {
    writeAppData(AGENT_PRESETS_SPEC, JSON.stringify(DEFAULT_PRESETS));
  }
  localStorage.setItem(SEEDED_KEY, 'true');
}

// ── Migration-safe parsing ───────────────────────────────────────

/**
 * Parse a single preset from raw JSON, returning null if unrecoverable.
 */
export function migratePreset(raw: unknown): AgentPreset | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  if (typeof obj.id !== 'string' || !obj.id) return null;
  if (typeof obj.label !== 'string') return null;
  if (typeof obj.command !== 'string') return null;

  const result = agentPresetSchema.safeParse({
    id: obj.id,
    label: obj.label,
    command: obj.command,
    args: Array.isArray(obj.args) ? obj.args : [],
    env: typeof obj.env === 'object' && obj.env !== null ? obj.env : undefined,
    prompts: Array.isArray(obj.prompts) ? obj.prompts : undefined,
  });

  return result.success ? result.data : null;
}

// ── CRUD helpers ─────────────────────────────────────────────────

/**
 * Load all agent presets. Reads from the in-session cache which is
 * hydrated at startup from `agents.json` in AppData. Seeds defaults on
 * first call if not yet seeded.
 */
export function listPresets(): AgentPreset[] {
  seedDefaultPresets();
  try {
    const raw = readAppData(AGENT_PRESETS_SPEC);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const presets: AgentPreset[] = [];
    for (const item of parsed) {
      const preset = migratePreset(item);
      if (preset) presets.push(preset);
    }
    return presets;
  } catch {
    return [];
  }
}

/**
 * Get a single preset by ID.
 */
export function getPreset(id: string): AgentPreset | undefined {
  return listPresets().find(p => p.id === id);
}

/**
 * Save (create or update) a preset. If a preset with the same ID exists, it is replaced.
 */
export function savePreset(preset: AgentPreset): void {
  const presets = listPresets();
  const idx = presets.findIndex(p => p.id === preset.id);
  if (idx >= 0) {
    presets[idx] = preset;
  } else {
    presets.push(preset);
  }
  writeAppData(AGENT_PRESETS_SPEC, JSON.stringify(presets));
}

/**
 * Delete a preset by ID. No-op if not found.
 */
export function deletePreset(id: string): void {
  const presets = listPresets().filter(p => p.id !== id);
  writeAppData(AGENT_PRESETS_SPEC, JSON.stringify(presets));
}

/**
 * Check if an arg string contains a {MODEL} placeholder.
 */
export function hasModelPlaceholder(args: string[]): boolean {
  return args.some(a => a.includes('{MODEL}'));
}

/**
 * Duplicate a preset with a new ID and "(Copy)" suffix.
 */
export function duplicatePreset(preset: AgentPreset): AgentPreset {
  return {
    ...preset,
    id: crypto.randomUUID(),
    label: `${preset.label} (Copy)`,
  };
}
