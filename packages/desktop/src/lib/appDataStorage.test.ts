import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  WORKSPACE_SPEC,
  AGENT_PRESETS_SPEC,
  ALL_APP_DATA_SPECS,
  readAppData,
  writeAppData,
  hydrateAppData,
  resetFsPluginCacheForTests,
} from './appDataStorage';

// jsdom-style localStorage stand-in. bun:test runs in a node-ish env with
// no DOM, so we install a minimal Map-backed replacement per test.
class MemoryStorage {
  private data = new Map<string, string>();
  get length(): number {
    return this.data.size;
  }
  clear(): void {
    this.data.clear();
  }
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  key(index: number): string | null {
    return Array.from(this.data.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  });
  // Make isTauri() return false by ensuring no __TAURI_INTERNALS__ marker
  // is present on the synthetic window. We don't stub window at all; the
  // storage module handles `typeof window === 'undefined'`.
  resetFsPluginCacheForTests();
});

afterEach(() => {
  if (storageDescriptor) {
    Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
  } else {
    // `unknown` cast needed because TS doesn't know localStorage is optional.
    delete (globalThis as unknown as { localStorage?: Storage }).localStorage;
  }
});

describe('file spec constants', () => {
  test('workspace spec targets the PRD-specified filename', () => {
    expect(WORKSPACE_SPEC.filename).toBe('workspace.json');
    expect(WORKSPACE_SPEC.storageKey).toBe('archon-desktop:workspace');
  });

  test('agent presets spec targets agents.json', () => {
    expect(AGENT_PRESETS_SPEC.filename).toBe('agents.json');
    expect(AGENT_PRESETS_SPEC.storageKey).toBe('archon-desktop:agent-presets');
  });

  test('ALL_APP_DATA_SPECS exposes both specs for hydrate', () => {
    expect(ALL_APP_DATA_SPECS).toContain(WORKSPACE_SPEC);
    expect(ALL_APP_DATA_SPECS).toContain(AGENT_PRESETS_SPEC);
    expect(ALL_APP_DATA_SPECS).toHaveLength(2);
  });
});

describe('readAppData / writeAppData (non-Tauri path)', () => {
  test('readAppData returns null when nothing is stored', () => {
    expect(readAppData(WORKSPACE_SPEC)).toBeNull();
  });

  test('writeAppData stores to localStorage synchronously', () => {
    writeAppData(WORKSPACE_SPEC, '{"roots":[]}');
    expect(readAppData(WORKSPACE_SPEC)).toBe('{"roots":[]}');
  });

  test('writeAppData overwrites prior values', () => {
    writeAppData(WORKSPACE_SPEC, '{"roots":[1]}');
    writeAppData(WORKSPACE_SPEC, '{"roots":[2]}');
    expect(readAppData(WORKSPACE_SPEC)).toBe('{"roots":[2]}');
  });

  test('different specs do not collide', () => {
    writeAppData(WORKSPACE_SPEC, 'ws');
    writeAppData(AGENT_PRESETS_SPEC, 'ap');
    expect(readAppData(WORKSPACE_SPEC)).toBe('ws');
    expect(readAppData(AGENT_PRESETS_SPEC)).toBe('ap');
  });
});

describe('hydrateAppData (non-Tauri path)', () => {
  test('is a no-op when not running inside Tauri', async () => {
    // Pre-populate localStorage with a value that, if hydrate ran, would
    // be overwritten by a null read from the missing plugin.
    localStorage.setItem(WORKSPACE_SPEC.storageKey, '{"roots":["preserved"]}');

    await hydrateAppData([WORKSPACE_SPEC]);

    expect(readAppData(WORKSPACE_SPEC)).toBe('{"roots":["preserved"]}');
  });

  test('handles empty spec list without error', async () => {
    await expect(hydrateAppData([])).resolves.toBeUndefined();
  });
});

describe('write-through semantics', () => {
  test('round-trip: write then read returns the same payload', () => {
    const payload = JSON.stringify({
      roots: [{ id: 'a', host: 'linux-beast', path: '/home/x', label: 'x' }],
    });
    writeAppData(WORKSPACE_SPEC, payload);
    expect(readAppData(WORKSPACE_SPEC)).toBe(payload);
  });

  test('sync read immediately after write (hydrate semantics)', () => {
    // Simulates a useState initializer firing right after a writeAppData
    // call — the value must be observable via sync read.
    writeAppData(AGENT_PRESETS_SPEC, '[{"id":"claude"}]');
    const cached = readAppData(AGENT_PRESETS_SPEC);
    expect(cached).toBe('[{"id":"claude"}]');
  });
});
