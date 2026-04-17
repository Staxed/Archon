import type { AgentPreset } from './AgentPresets';
import { listPresets, hasModelPlaceholder } from './AgentPresets';

// ── Recent models cache ─────────────────────────────────────────

const RECENT_MODELS_KEY = 'archon-desktop:recent-models';
const MAX_RECENT_MODELS = 10;

/**
 * Load recent model choices from localStorage (LRU, max 10).
 */
export function loadRecentModels(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_MODELS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((m): m is string => typeof m === 'string').slice(0, MAX_RECENT_MODELS);
  } catch {
    return [];
  }
}

/**
 * Add a model to the front of the recent-models list (LRU).
 */
export function addRecentModel(model: string): void {
  const recent = loadRecentModels().filter(m => m !== model);
  recent.unshift(model);
  if (recent.length > MAX_RECENT_MODELS) recent.length = MAX_RECENT_MODELS;
  localStorage.setItem(RECENT_MODELS_KEY, JSON.stringify(recent));
}

// ── Launcher selection types ────────────────────────────────────

export interface LauncherSelectionNone {
  kind: 'none';
}

export interface LauncherSelectionPreset {
  kind: 'preset';
  preset: AgentPreset;
  modelOverride?: string;
}

export interface LauncherSelectionCustom {
  kind: 'custom';
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwdOverride?: string;
}

export type LauncherSelection =
  | LauncherSelectionNone
  | LauncherSelectionPreset
  | LauncherSelectionCustom;

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Build the dropdown options list: None + all presets + Custom…
 */
export function buildDropdownOptions(): { id: string; label: string; preset?: AgentPreset }[] {
  const presets = listPresets();
  const options: { id: string; label: string; preset?: AgentPreset }[] = [
    { id: '__none__', label: 'None' },
  ];
  for (const p of presets) {
    options.push({ id: p.id, label: p.label, preset: p });
  }
  options.push({ id: '__custom__', label: 'Custom…' });
  return options;
}

/**
 * Check if a preset is a YOLO variant (label contains "YOLO").
 */
export function isYoloPreset(preset: AgentPreset): boolean {
  return preset.label.toUpperCase().includes('YOLO');
}

/**
 * Check if a launcher selection is YOLO.
 */
export function isYoloSelection(selection: LauncherSelection): boolean {
  if (selection.kind !== 'preset') return false;
  return isYoloPreset(selection.preset);
}

/**
 * Check if a preset needs a model prompt ({MODEL} placeholder in args).
 */
export function needsModelPrompt(preset: AgentPreset): boolean {
  return hasModelPlaceholder(preset.args);
}

/**
 * Resolve the startup command for a launcher selection.
 * Returns the command string that should be passed to tmux as the startup command.
 */
export function resolveStartupCommand(selection: LauncherSelection): string | undefined {
  switch (selection.kind) {
    case 'none':
      return undefined;
    case 'preset': {
      const args = selection.preset.args.map(a => {
        if (selection.modelOverride) {
          return a.replace('{MODEL}', selection.modelOverride);
        }
        return a;
      });
      const parts = [selection.preset.command, ...args];
      // Prepend env vars if any
      if (selection.preset.env) {
        const envPrefix = Object.entries(selection.preset.env)
          .map(([k, v]) => `${k}=${v}`)
          .join(' ');
        return `${envPrefix} ${parts.join(' ')}`;
      }
      return parts.join(' ');
    }
    case 'custom': {
      const parts = [selection.command, ...selection.args];
      if (selection.env) {
        const envPrefix = Object.entries(selection.env)
          .map(([k, v]) => `${k}=${v}`)
          .join(' ');
        return `${envPrefix} ${parts.join(' ')}`;
      }
      return parts.join(' ');
    }
  }
}
