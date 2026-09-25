import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalJson,
  codexHookHash,
  codexHookTrustOverride,
  ensureCodexDispatcher,
  ensureGrokDispatcher,
  prepareHookRun,
  unsupportedHookEvents,
} from './cli-hooks';
import {
  mapSandboxForGrok,
  modelRates,
  priceTokens,
  withGrokProfile,
} from './subscription-options';

const home = mkdtempSync(join(tmpdir(), 'cli-hooks-'));
const savedCodex = process.env.CODEX_HOME;
const savedGrok = process.env.GROK_HOME;
process.env.CODEX_HOME = join(home, 'codex');
process.env.GROK_HOME = join(home, 'grok');
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  if (savedCodex === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodex;
  if (savedGrok === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = savedGrok;
});

describe('codex hook trust hash', () => {
  test('reproduces a trusted_hash Codex wrote itself (pre_compact, codex 0.157)', () => {
    const command =
      'STIXED_ROOT=/mnt/volumes/projects/stixed uv run --project /mnt/volumes/projects/stixed python /mnt/volumes/projects/stixed/.claude/hooks/pre-compact-flush.py';
    // Codex's own hash also covers the handler's statusMessage; this one had one,
    // so recompute with it to check the recipe against the real value.
    const normalized = {
      event_name: 'pre_compact',
      hooks: [
        {
          async: false,
          command,
          statusMessage: 'Flushing context to second brain before compaction',
          timeout: 600,
          type: 'command',
        },
      ],
    };
    const hash = new Bun.CryptoHasher('sha256').update(canonicalJson(normalized)).digest('hex');
    expect(hash).toBe('d34b5d3fd8d298a29a80196922c98b6a71b8ed52d67f274adc781adbe6e130b0');
    // and the helper uses the same recipe for a handler without statusMessage
    expect(codexHookHash('pre_tool_use', 'x')).toBe(
      `sha256:${new Bun.CryptoHasher('sha256')
        .update(
          canonicalJson({
            event_name: 'pre_tool_use',
            hooks: [{ async: false, command: 'x', timeout: 600, type: 'command' }],
          })
        )
        .digest('hex')}`
    );
  });

  test('canonicalJson sorts keys at every level and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[1,{"y":2,"z":1}]},"b":1}'
    );
  });
});

describe('ensureCodexDispatcher', () => {
  const hooksPath = (): string => join(home, 'codex', 'hooks.json');
  beforeEach(() => {
    rmSync(join(home, 'codex'), { recursive: true, force: true });
  });

  test('keeps the user hooks, appends Archon, and is idempotent', () => {
    ensureCodexDispatcher('/bin/bun', __filename);
    // the user adds their own Stop hook AFTER Archon's
    const installed = JSON.parse(readFileSync(hooksPath(), 'utf8')) as {
      hooks: Record<string, unknown[]>;
    };
    installed.hooks.Stop.push({ hooks: [{ type: 'command', command: 'user-stop' }] });
    writeFileSync(hooksPath(), JSON.stringify({ description: 'mine', hooks: installed.hooks }));
    const trust1 = ensureCodexDispatcher('/bin/bun', __filename);
    const before = readFileSync(hooksPath(), 'utf8');
    const trust2 = ensureCodexDispatcher('/bin/bun', __filename);
    expect(readFileSync(hooksPath(), 'utf8')).toBe(before);
    expect(trust2).toEqual(trust1);
    const doc = JSON.parse(before) as {
      description: string;
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    expect(doc.description).toBe('mine');
    // Archon's old Stop entry was replaced, not duplicated; the user's comes first
    expect(doc.hooks.Stop.map(g => g.hooks[0].command.includes('ARCHON_HOOK_EVENTS'))).toEqual([
      false,
      true,
    ]);
    expect(trust1[`${hooksPath()}:stop:1:0`]).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test('refuses to clobber a hooks.json it cannot parse', () => {
    ensureCodexDispatcher('/bin/bun', __filename);
    writeFileSync(hooksPath(), '{ nope');
    expect(() => ensureCodexDispatcher('/bin/bun', __filename)).toThrow('not valid JSON');
  });

  test('refuses when the dispatcher script is missing', () => {
    expect(() => ensureCodexDispatcher('/bin/bun', join(home, 'nope.ts'))).toThrow(
      'running from source'
    );
  });

  test('trust override keeps config.toml entries and adds Archon', () => {
    const trust = ensureCodexDispatcher('/bin/bun', __filename);
    writeFileSync(
      join(home, 'codex', 'config.toml'),
      '[hooks.state."/p/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:abc"\nenabled = false\n'
    );
    const override = codexHookTrustOverride(trust);
    expect(override.startsWith('hooks.state={ ')).toBe(true);
    expect(override).toContain(
      '"/p/hooks.json:stop:0:0" = { trusted_hash = "sha256:abc", enabled = false }'
    );
    expect(override).toContain(`"${hooksPath()}:pre_tool_use:0:0" = { trusted_hash = "sha256:`);
    // it parses back as TOML to the intended table
    const parsed = Bun.TOML.parse(override) as {
      hooks: { state: Record<string, { trusted_hash: string }> };
    };
    expect(Object.keys(parsed.hooks.state)).toContain(`${hooksPath()}:pre_tool_use:0:0`);
  });
});

describe('ensureGrokDispatcher', () => {
  test('writes an Archon-owned global hook file covering every Grok event', () => {
    const path = ensureGrokDispatcher('/bin/bun', __filename);
    expect(path).toBe(join(home, 'grok', 'hooks', 'archon-dispatcher.json'));
    const doc = JSON.parse(readFileSync(path, 'utf8')) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    expect(doc.hooks.PreToolUse[0].hooks[0].command).toContain('*,PreToolUse,*');
    expect(doc.hooks.PostToolUseFailure).toBeDefined();
    expect(doc.hooks.PermissionRequest).toBeUndefined();
  });
});

describe('hook run preparation', () => {
  test('unsupportedHookEvents lists events the CLI never fires', () => {
    const r = { response: {} };
    expect(unsupportedHookEvents('codex', { PreToolUse: [r], Setup: [r], Stop: [] })).toEqual([
      'Setup',
    ]);
    expect(unsupportedHookEvents('grok', { PermissionRequest: [r] })).toEqual([
      'PermissionRequest',
    ]);
  });

  test('prepareHookRun writes a private spec and names the events to dispatch', () => {
    const run = prepareHookRun({
      version: 1,
      provider: 'grok',
      cwd: '/w',
      pathGuard: true,
      hooks: { Stop: [{ response: {} }], PostToolUse: [] },
    });
    expect(run.env.ARCHON_HOOK_EVENTS).toBe('PreToolUse,Stop');
    expect(JSON.parse(readFileSync(run.env.ARCHON_HOOK_SPEC, 'utf8'))).toMatchObject({ cwd: '/w' });
    run.cleanup();
    run.cleanup();
    expect(existsSync(run.env.ARCHON_HOOK_SPEC)).toBe(false);
  });
});

describe('subscription-options', () => {
  test('prices tokens at API-equivalent rates, overridable by ARCHON_MODEL_RATES', () => {
    const r = modelRates('grok-4.7-build');
    expect(r).toBeDefined();
    // the sandbox probe's turn: Grok billed 110119200 ticks = $0.01101192
    expect(priceTokens(r!, { uncached: 6834, cached: 30336, output: 592 })).toBeCloseTo(
      0.01101192,
      8
    );
    process.env.ARCHON_MODEL_RATES = '{"m":{"input":1,"cachedInput":0,"output":2}}';
    try {
      expect(modelRates('m')).toEqual({ input: 1, cachedInput: 0, output: 2 });
    } finally {
      delete process.env.ARCHON_MODEL_RATES;
    }
    expect(modelRates('m')).toBeUndefined();
  });

  test('grok sandbox profile: workspace base, deny/read-only/read-write, network', () => {
    const p = mapSandboxForGrok(
      {
        enabled: true,
        filesystem: { allowWrite: ['out'], denyWrite: ['/etc'], denyRead: ['~/.ssh'] },
      },
      '/w'
    );
    expect(p?.name).toMatch(/^archon-[0-9a-f]{12}$/);
    expect(p?.toml).toContain('extends = "workspace"');
    expect(p?.toml).toContain('restrict_network = true');
    expect(p?.toml).toContain('read_write = ["/w/out"]');
    expect(p?.toml).toContain('read_only = ["/etc"]');
    expect(p?.toml).toMatch(/deny = \[".*\/\.ssh"\]/);
    expect(mapSandboxForGrok({ enabled: false }, '/w')).toBeUndefined();
    expect(() =>
      mapSandboxForGrok({ enabled: true, network: { allowedDomains: ['x.com'] } }, '/w')
    ).toThrow('specific domains');
  });

  test('withGrokProfile appends a profile once', () => {
    const p = mapSandboxForGrok({ enabled: true }, '/w')!;
    const once = withGrokProfile('[profiles.mine]\nextends = "strict"\n', p);
    expect(withGrokProfile(once, p)).toBe(once);
    expect(once).toContain('[profiles.mine]');
    expect(Bun.TOML.parse(once)).toMatchObject({
      profiles: { [p.name]: { extends: 'workspace' } },
    });
  });
});
