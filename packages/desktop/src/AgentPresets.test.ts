import { describe, test, expect, beforeEach } from 'bun:test';
import {
  DEFAULT_PRESETS,
  seedDefaultPresets,
  listPresets,
  getPreset,
  savePreset,
  deletePreset,
  migratePreset,
  hasModelPlaceholder,
  duplicatePreset,
  agentPresetSchema,
} from './AgentPresets';
import {
  createBlankPreset,
  formatArgs,
  parseArgs,
  formatEnv,
  parseEnv,
} from './AgentPresetsEditor';

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

// ── Default presets ──────────────────────────────────────────────

describe('DEFAULT_PRESETS', () => {
  test('contains exactly 8 presets', () => {
    expect(DEFAULT_PRESETS).toHaveLength(8);
  });

  test('does not contain OpenCode', () => {
    const labels = DEFAULT_PRESETS.map(p => p.label.toLowerCase());
    expect(labels.some(l => l.includes('opencode'))).toBe(false);
  });

  test('all default presets pass schema validation', () => {
    for (const preset of DEFAULT_PRESETS) {
      const result = agentPresetSchema.safeParse(preset);
      expect(result.success).toBe(true);
    }
  });

  test('includes Claude, Codex, Gemini, OpenRouter, Llama.cpp presets', () => {
    const ids = DEFAULT_PRESETS.map(p => p.id);
    expect(ids).toContain('claude');
    expect(ids).toContain('claude-yolo');
    expect(ids).toContain('codex');
    expect(ids).toContain('codex-yolo');
    expect(ids).toContain('gemini');
    expect(ids).toContain('gemini-yolo');
    expect(ids).toContain('openrouter-aichat');
    expect(ids).toContain('llamacpp-aichat');
  });

  test('Llama.cpp preset has LLAMACPP_API_BASE env var', () => {
    const llamacpp = DEFAULT_PRESETS.find(p => p.id === 'llamacpp-aichat');
    expect(llamacpp?.env).toEqual({ LLAMACPP_API_BASE: 'http://localhost:8093/v1' });
  });

  test('OpenRouter and Llama.cpp presets have MODEL prompt', () => {
    const or = DEFAULT_PRESETS.find(p => p.id === 'openrouter-aichat');
    expect(or?.prompts).toEqual(['MODEL']);
    const lc = DEFAULT_PRESETS.find(p => p.id === 'llamacpp-aichat');
    expect(lc?.prompts).toEqual(['MODEL']);
  });
});

// ── Seed idempotency ─────────────────────────────────────────────

describe('seedDefaultPresets', () => {
  test('seeds defaults on first call', () => {
    seedDefaultPresets();
    const raw = store['archon-desktop:agent-presets'];
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw) as unknown[];
    expect(parsed).toHaveLength(8);
  });

  test('is idempotent — second call does not overwrite', () => {
    seedDefaultPresets();
    // Delete one preset manually
    const presets = JSON.parse(store['archon-desktop:agent-presets']) as unknown[];
    presets.pop();
    store['archon-desktop:agent-presets'] = JSON.stringify(presets);

    // Second seed should NOT restore the deleted preset
    seedDefaultPresets();
    const after = JSON.parse(store['archon-desktop:agent-presets']) as unknown[];
    expect(after).toHaveLength(7);
  });

  test('seeds only if no presets exist', () => {
    // Pre-populate with custom presets
    const custom = [{ id: 'custom-1', label: 'My Agent', command: 'my-agent', args: [] }];
    store['archon-desktop:agent-presets'] = JSON.stringify(custom);

    seedDefaultPresets();
    const after = JSON.parse(store['archon-desktop:agent-presets']) as unknown[];
    expect(after).toHaveLength(1);
    expect((after[0] as Record<string, unknown>).id).toBe('custom-1');
  });
});

// ── CRUD ─────────────────────────────────────────────────────────

describe('listPresets', () => {
  test('returns seeded defaults on first call', () => {
    const presets = listPresets();
    expect(presets).toHaveLength(8);
    expect(presets[0].id).toBe('claude');
  });

  test('returns empty array on corrupt data', () => {
    store['archon-desktop:agent-presets-seeded'] = 'true';
    store['archon-desktop:agent-presets'] = 'not-json!!!';
    expect(listPresets()).toEqual([]);
  });
});

describe('getPreset', () => {
  test('finds a preset by ID', () => {
    listPresets(); // seed
    const preset = getPreset('claude-yolo');
    expect(preset).toBeTruthy();
    expect(preset?.label).toBe('Claude (YOLO)');
  });

  test('returns undefined for unknown ID', () => {
    listPresets(); // seed
    expect(getPreset('nonexistent')).toBeUndefined();
  });
});

describe('savePreset', () => {
  test('adds a new preset', () => {
    listPresets(); // seed
    savePreset({ id: 'custom-new', label: 'Custom', command: 'my-cmd', args: ['--flag'] });
    expect(listPresets()).toHaveLength(9);
    expect(getPreset('custom-new')?.command).toBe('my-cmd');
  });

  test('updates an existing preset', () => {
    listPresets(); // seed
    const claude = getPreset('claude')!;
    savePreset({ ...claude, label: 'Claude Modified' });
    expect(getPreset('claude')?.label).toBe('Claude Modified');
    expect(listPresets()).toHaveLength(8); // count unchanged
  });
});

describe('deletePreset', () => {
  test('removes a preset by ID', () => {
    listPresets(); // seed
    deletePreset('claude');
    expect(getPreset('claude')).toBeUndefined();
    expect(listPresets()).toHaveLength(7);
  });

  test('no-op for unknown ID', () => {
    listPresets(); // seed
    deletePreset('nonexistent');
    expect(listPresets()).toHaveLength(8);
  });
});

// ── Migration ────────────────────────────────────────────────────

describe('migratePreset', () => {
  test('returns null for non-object', () => {
    expect(migratePreset(null)).toBeNull();
    expect(migratePreset('string')).toBeNull();
    expect(migratePreset(42)).toBeNull();
  });

  test('returns null for missing required fields', () => {
    expect(migratePreset({ id: 'x' })).toBeNull(); // missing label, command
    expect(migratePreset({ label: 'X', command: 'x' })).toBeNull(); // missing id
  });

  test('parses a valid preset', () => {
    const result = migratePreset({
      id: 'test',
      label: 'Test',
      command: 'test-cmd',
      args: ['--flag'],
      env: { KEY: 'val' },
      prompts: ['MODEL'],
    });
    expect(result).toBeTruthy();
    expect(result?.id).toBe('test');
    expect(result?.env).toEqual({ KEY: 'val' });
  });

  test('defaults args to empty array if missing', () => {
    const result = migratePreset({
      id: 'test',
      label: 'Test',
      command: 'test-cmd',
    });
    expect(result?.args).toEqual([]);
  });
});

// ── Helpers ──────────────────────────────────────────────────────

describe('hasModelPlaceholder', () => {
  test('detects {MODEL} in args', () => {
    expect(hasModelPlaceholder(['-m', 'openrouter:{MODEL}'])).toBe(true);
  });

  test('returns false when no placeholder', () => {
    expect(hasModelPlaceholder(['--flag', 'value'])).toBe(false);
  });

  test('returns false for empty args', () => {
    expect(hasModelPlaceholder([])).toBe(false);
  });
});

describe('duplicatePreset', () => {
  test('creates a copy with new ID and (Copy) suffix', () => {
    const original = DEFAULT_PRESETS[0];
    const dup = duplicatePreset(original);
    expect(dup.id).not.toBe(original.id);
    expect(dup.label).toBe('Claude (Copy)');
    expect(dup.command).toBe(original.command);
    expect(dup.args).toEqual(original.args);
  });
});

// ── Editor helpers ───────────────────────────────────────────────

describe('createBlankPreset', () => {
  test('creates a preset with unique ID', () => {
    const a = createBlankPreset();
    const b = createBlankPreset();
    expect(a.id).not.toBe(b.id);
    expect(a.label).toBe('Custom Agent');
    expect(a.command).toBe('');
    expect(a.args).toEqual([]);
  });
});

describe('formatArgs / parseArgs', () => {
  test('round-trips args', () => {
    const args = ['--flag', 'value', '-m', 'model:{MODEL}'];
    expect(parseArgs(formatArgs(args))).toEqual(args);
  });

  test('handles empty args', () => {
    expect(formatArgs([])).toBe('');
    expect(parseArgs('')).toEqual([]);
  });
});

describe('formatEnv / parseEnv', () => {
  test('round-trips env record', () => {
    const env = { KEY: 'value', OTHER: 'val2' };
    expect(parseEnv(formatEnv(env))).toEqual(env);
  });

  test('returns undefined for empty string', () => {
    expect(parseEnv('')).toBeUndefined();
    expect(formatEnv(undefined)).toBe('');
  });
});
