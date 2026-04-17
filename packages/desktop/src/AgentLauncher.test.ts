import { describe, test, expect, beforeEach } from 'bun:test';
import {
  loadRecentModels,
  addRecentModel,
  buildDropdownOptions,
  isYoloPreset,
  isYoloSelection,
  needsModelPrompt,
  resolveStartupCommand,
} from './AgentLauncher';
import type { LauncherSelection } from './AgentLauncher';
import type { AgentPreset } from './AgentPresets';

// ── localStorage mock ───────────────────────────────────────────

const store: Record<string, string> = {};

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
      for (const key of Object.keys(store)) delete store[key];
    },
  },
  writable: true,
  configurable: true,
});

beforeEach(() => {
  localStorage.clear();
});

// ── Recent models ───────────────────────────────────────────────

describe('loadRecentModels', () => {
  test('returns empty array when no data', () => {
    expect(loadRecentModels()).toEqual([]);
  });

  test('returns stored models', () => {
    localStorage.setItem('archon-desktop:recent-models', JSON.stringify(['model-a', 'model-b']));
    expect(loadRecentModels()).toEqual(['model-a', 'model-b']);
  });

  test('limits to 10 entries', () => {
    const models = Array.from({ length: 15 }, (_, i) => `model-${i}`);
    localStorage.setItem('archon-desktop:recent-models', JSON.stringify(models));
    expect(loadRecentModels()).toHaveLength(10);
  });

  test('handles invalid JSON gracefully', () => {
    localStorage.setItem('archon-desktop:recent-models', 'not-json');
    expect(loadRecentModels()).toEqual([]);
  });
});

describe('addRecentModel', () => {
  test('adds model to front', () => {
    addRecentModel('model-a');
    addRecentModel('model-b');
    expect(loadRecentModels()).toEqual(['model-b', 'model-a']);
  });

  test('deduplicates by moving to front (LRU)', () => {
    addRecentModel('model-a');
    addRecentModel('model-b');
    addRecentModel('model-a');
    expect(loadRecentModels()).toEqual(['model-a', 'model-b']);
  });

  test('caps at 10 entries', () => {
    for (let i = 0; i < 12; i++) {
      addRecentModel(`model-${i}`);
    }
    const result = loadRecentModels();
    expect(result).toHaveLength(10);
    expect(result[0]).toBe('model-11');
  });
});

// ── Dropdown options ────────────────────────────────────────────

describe('buildDropdownOptions', () => {
  test('starts with None and ends with Custom…', () => {
    // Seed default presets
    localStorage.setItem('archon-desktop:agent-presets-seeded', 'true');
    localStorage.setItem(
      'archon-desktop:agent-presets',
      JSON.stringify([{ id: 'claude', label: 'Claude', command: 'claude', args: [] }])
    );

    const opts = buildDropdownOptions();
    expect(opts[0]).toEqual({ id: '__none__', label: 'None' });
    expect(opts[opts.length - 1]).toEqual({ id: '__custom__', label: 'Custom…' });
  });

  test('includes all presets from storage', () => {
    localStorage.setItem('archon-desktop:agent-presets-seeded', 'true');
    localStorage.setItem(
      'archon-desktop:agent-presets',
      JSON.stringify([
        { id: 'claude', label: 'Claude', command: 'claude', args: [] },
        { id: 'codex', label: 'Codex', command: 'codex', args: [] },
      ])
    );

    const opts = buildDropdownOptions();
    // None + 2 presets + Custom
    expect(opts).toHaveLength(4);
    expect(opts[1].id).toBe('claude');
    expect(opts[2].id).toBe('codex');
  });
});

// ── YOLO detection ──────────────────────────────────────────────

describe('isYoloPreset', () => {
  test('detects YOLO in label', () => {
    const p: AgentPreset = { id: 'x', label: 'Claude (YOLO)', command: 'claude', args: [] };
    expect(isYoloPreset(p)).toBe(true);
  });

  test('case insensitive', () => {
    const p: AgentPreset = { id: 'x', label: 'Codex yolo mode', command: 'codex', args: [] };
    expect(isYoloPreset(p)).toBe(true);
  });

  test('returns false for non-YOLO', () => {
    const p: AgentPreset = { id: 'x', label: 'Claude', command: 'claude', args: [] };
    expect(isYoloPreset(p)).toBe(false);
  });
});

describe('isYoloSelection', () => {
  test('returns true for YOLO preset selection', () => {
    const sel: LauncherSelection = {
      kind: 'preset',
      preset: { id: 'x', label: 'Claude (YOLO)', command: 'claude', args: [] },
    };
    expect(isYoloSelection(sel)).toBe(true);
  });

  test('returns false for none selection', () => {
    expect(isYoloSelection({ kind: 'none' })).toBe(false);
  });

  test('returns false for custom selection', () => {
    expect(isYoloSelection({ kind: 'custom', command: 'claude', args: [] })).toBe(false);
  });
});

// ── Model prompt detection ──────────────────────────────────────

describe('needsModelPrompt', () => {
  test('detects {MODEL} placeholder', () => {
    const p: AgentPreset = {
      id: 'x',
      label: 'OR',
      command: 'aichat',
      args: ['-m', 'openrouter:{MODEL}'],
    };
    expect(needsModelPrompt(p)).toBe(true);
  });

  test('returns false when no placeholder', () => {
    const p: AgentPreset = { id: 'x', label: 'Claude', command: 'claude', args: [] };
    expect(needsModelPrompt(p)).toBe(false);
  });
});

// ── Resolve startup command ─────────────────────────────────────

describe('resolveStartupCommand', () => {
  test('returns undefined for none', () => {
    expect(resolveStartupCommand({ kind: 'none' })).toBeUndefined();
  });

  test('builds command from preset', () => {
    const sel: LauncherSelection = {
      kind: 'preset',
      preset: {
        id: 'x',
        label: 'Claude',
        command: 'claude',
        args: ['--dangerously-skip-permissions'],
      },
    };
    expect(resolveStartupCommand(sel)).toBe('claude --dangerously-skip-permissions');
  });

  test('substitutes {MODEL} with override', () => {
    const sel: LauncherSelection = {
      kind: 'preset',
      preset: { id: 'x', label: 'OR', command: 'aichat', args: ['-m', 'openrouter:{MODEL}'] },
      modelOverride: 'anthropic/claude-3-haiku',
    };
    expect(resolveStartupCommand(sel)).toBe('aichat -m openrouter:anthropic/claude-3-haiku');
  });

  test('prepends env vars for preset', () => {
    const sel: LauncherSelection = {
      kind: 'preset',
      preset: {
        id: 'x',
        label: 'LC',
        command: 'aichat',
        args: ['-m', 'llamacpp:{MODEL}'],
        env: { LLAMACPP_API_BASE: 'http://localhost:8093/v1' },
      },
      modelOverride: 'test-model',
    };
    const result = resolveStartupCommand(sel);
    expect(result).toBe('LLAMACPP_API_BASE=http://localhost:8093/v1 aichat -m llamacpp:test-model');
  });

  test('builds command from custom selection', () => {
    const sel: LauncherSelection = {
      kind: 'custom',
      command: 'my-agent',
      args: ['--verbose'],
    };
    expect(resolveStartupCommand(sel)).toBe('my-agent --verbose');
  });

  test('prepends env vars for custom selection', () => {
    const sel: LauncherSelection = {
      kind: 'custom',
      command: 'my-agent',
      args: [],
      env: { FOO: 'bar' },
    };
    expect(resolveStartupCommand(sel)).toBe('FOO=bar my-agent');
  });
});
