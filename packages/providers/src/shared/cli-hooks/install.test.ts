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
  PRE_TOOL_USE_TIMEOUT_S,
  prepareHookRun,
  unsupportedHookEvents,
} from './install';
import type { HookRunSpec } from './hook-dispatcher';
import {
  mapSandboxForCodex,
  mapSandboxForGrok,
  modelRates,
  priceTokens,
  withGrokProfile,
} from '../subscription-options';

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

  test('reproduces a trusted_hash Codex wrote for a handler with an explicit timeout (codex 0.161)', () => {
    // ~/.codex/hooks.json, PreToolUse group 2: Dashed's live-state hook, `"timeout": 3`.
    expect(
      codexHookHash(
        'pre_tool_use',
        '/usr/bin/python3 /mnt/volumes/projects/Dashed/integrations/live_state/live_state.py codex',
        3
      )
    ).toBe('sha256:6ccd384f2456312fc46be35b6e559d0a88d88cdeea97489897a1cda120296f0d');
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
    ensureCodexDispatcher(undefined, '/bin/bun', __filename);
    // the user adds their own Stop hook AFTER Archon's
    const installed = JSON.parse(readFileSync(hooksPath(), 'utf8')) as {
      hooks: Record<string, unknown[]>;
    };
    installed.hooks.Stop.push({ hooks: [{ type: 'command', command: 'user-stop' }] });
    writeFileSync(hooksPath(), JSON.stringify({ description: 'mine', hooks: installed.hooks }));
    const trust1 = ensureCodexDispatcher(undefined, '/bin/bun', __filename);
    const before = readFileSync(hooksPath(), 'utf8');
    const trust2 = ensureCodexDispatcher(undefined, '/bin/bun', __filename);
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

  test('PreToolUse carries a 45 s timeout and its trust hash covers it; other events keep the default', () => {
    const trust = ensureCodexDispatcher(undefined, '/bin/bun', __filename);
    const doc = JSON.parse(readFileSync(hooksPath(), 'utf8')) as {
      hooks: Record<string, { hooks: { command: string; timeout?: number }[] }[]>;
    };
    const pre = doc.hooks.PreToolUse[0].hooks[0];
    expect(pre.timeout).toBe(PRE_TOOL_USE_TIMEOUT_S);
    expect(PRE_TOOL_USE_TIMEOUT_S).toBe(45);
    expect(trust[`${hooksPath()}:pre_tool_use:0:0`]).toBe(
      codexHookHash('pre_tool_use', pre.command, 45)
    );
    expect(trust[`${hooksPath()}:pre_tool_use:0:0`]).not.toBe(
      codexHookHash('pre_tool_use', pre.command)
    );
    const stop = doc.hooks.Stop[0].hooks[0];
    expect(stop.timeout).toBeUndefined();
    expect(trust[`${hooksPath()}:stop:0:0`]).toBe(codexHookHash('stop', stop.command));
  });

  test('refuses to clobber a hooks.json it cannot parse', () => {
    ensureCodexDispatcher(undefined, '/bin/bun', __filename);
    writeFileSync(hooksPath(), '{ nope');
    expect(() => ensureCodexDispatcher(undefined, '/bin/bun', __filename)).toThrow(
      'not valid JSON'
    );
  });

  test('refuses when the dispatcher script is missing', () => {
    expect(() => ensureCodexDispatcher(undefined, '/bin/bun', join(home, 'nope.ts'))).toThrow(
      'running from source'
    );
  });

  test('trust override keeps config.toml entries and adds Archon', () => {
    const trust = ensureCodexDispatcher(undefined, '/bin/bun', __filename);
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
    const path = ensureGrokDispatcher(undefined, '/bin/bun', __filename);
    expect(path).toBe(join(home, 'grok', 'hooks', 'archon-dispatcher.json'));
    const doc = JSON.parse(readFileSync(path, 'utf8')) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    expect(doc.hooks.PreToolUse[0].hooks[0].command).toContain('*,PreToolUse,*');
    expect(doc.hooks.PostToolUseFailure).toBeDefined();
    expect(doc.hooks.PermissionRequest).toBeUndefined();
  });

  test("PreToolUse waits 45 s (Grok's default is 5 s, then it fails open); other events keep Grok's defaults", () => {
    const path = ensureGrokDispatcher(undefined, '/bin/bun', __filename);
    const doc = JSON.parse(readFileSync(path, 'utf8')) as {
      hooks: Record<string, { hooks: { timeout?: number }[] }[]>;
    };
    expect(doc.hooks.PreToolUse[0].hooks[0].timeout).toBe(45);
    expect(doc.hooks.Stop[0].hooks[0].timeout).toBeUndefined();
    expect(doc.hooks.PostToolUse[0].hooks[0].timeout).toBeUndefined();
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
    const written = JSON.parse(readFileSync(run.env.ARCHON_HOOK_SPEC, 'utf8')) as HookRunSpec;
    expect(written).toMatchObject({ cwd: '/w' });
    // the guard's rules file is pinned by the server, never left to the CLI's env
    expect(Object.hasOwn(written, 'rulesPath')).toBe(true);
    // so is the Jev guard (off under bun test: no folder named)
    expect(Object.hasOwn(written, 'jevShadow')).toBe(true);
    expect(written.jevShadow).toBeNull();
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

  test('codex sandbox: workspace-write, writable roots, network, refusals', () => {
    expect(mapSandboxForCodex(undefined, '/w')).toEqual({
      sandboxMode: 'danger-full-access',
      networkAccessEnabled: true,
      config: {},
    });
    expect(
      mapSandboxForCodex({ enabled: true, filesystem: { allowWrite: ['out'] } }, '/w')
    ).toEqual({
      sandboxMode: 'workspace-write',
      networkAccessEnabled: false,
      config: { sandbox_workspace_write: { writable_roots: ['/w/out'] } },
    });
    expect(
      mapSandboxForCodex({ enabled: true, network: { allowedDomains: ['*'] } }, '/w')
        .networkAccessEnabled
    ).toBe(true);
    expect(() =>
      mapSandboxForCodex({ enabled: true, filesystem: { denyRead: ['/etc'] } }, '/w')
    ).toThrow('filesystem.denyRead');
    expect(() =>
      mapSandboxForCodex({ enabled: true, network: { allowedDomains: ['x.com'] } }, '/w')
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
