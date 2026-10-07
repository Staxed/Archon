import { afterAll, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  RELAY_MAX_REQUEST,
  ensureJevRelay,
  relayJudge,
  relayRequest,
  stopJevRelays,
} from './jev-relay';
import type { JevShadowConfig, ShadowCall } from './jev-shadow';
import { prepareHookRun } from './cli-hooks/install';
import type { HookRunSpec } from './cli-hooks/hook-dispatcher';

const root = mkdtempSync(join(tmpdir(), 'jev-relay-test-'));
const LOGIN_KEYS = ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_BIN_PATH'] as const;
const savedLogin = LOGIN_KEYS.map(k => process.env[k]);
// This test process plays the Archon server: its env holds the Claude login.
process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-login';
process.env.CLAUDE_BIN_PATH = '/app/claude';

const relayDirs: string[] = [];
afterAll(async () => {
  await stopJevRelays();
  for (const d of relayDirs) expect(existsSync(d)).toBe(false);
  rmSync(root, { recursive: true, force: true });
  LOGIN_KEYS.forEach((k, i) => {
    if (savedLogin[i] === undefined) delete process.env[k];
    else process.env[k] = savedLogin[i];
  });
});

/**
 * A stand-in for stixed's session_guard.py (same CLI and Decision shape as the one in
 * jev-shadow.test.ts): it records what it was given next to itself and answers by the
 * command's first word. No model is called.
 */
const FAKE_SESSION_GUARD = String.raw`
import json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
req = json.loads(sys.stdin.read() or "{}")
with open(os.path.join(HERE, "seen.json"), "w") as f:
    json.dump({"req": req, "claude_login": os.environ.get("CLAUDE_CODE_OAUTH_TOKEN"),
               "claude_cli": os.environ.get("STIXED_CLAUDE_CLI")}, f)
cmd = str((req.get("tool_input") or {}).get("command", ""))
if cmd.startswith("rm"):
    d = {"outcome": "deny", "stage": "judge", "reason": "deletes another project's files"}
else:
    d = {"outcome": "allow", "stage": "prefilter", "reason": "nothing at stake"}
d.update({"mode": "enforce", "enforced": True})
print(json.dumps(d))
`;

function fakeScripts(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session_guard.py'), FAKE_SESSION_GUARD);
  return dir;
}

function config(name: string, extra: Partial<JevShadowConfig> = {}): JevShadowConfig {
  return {
    python: existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3',
    scriptsDir: fakeScripts(name),
    logDir: join(root, `${name}-log`),
    caller: 'archon',
    ...extra,
  };
}

/** A Codex call as its dispatcher builds it: its env has no Claude login (agent-env.ts). */
function call(command: string, extra: Partial<ShadowCall> = {}): ShadowCall {
  return {
    provider: 'codex',
    toolName: 'Bash',
    toolInput: { command },
    cwd: '/work/tree',
    projectRoot: '/work/tree',
    env: { PATH: '/usr/bin', GH_TOKEN: 'tok' },
    userRequest: 'clean up',
    runId: 'run-1',
    archonGuard: 'pass',
    ...extra,
  };
}

function seen(dir: string): { req: Record<string, unknown>; claude_login: string | null } {
  return JSON.parse(readFileSync(join(dir, 'seen.json'), 'utf8')) as ReturnType<typeof seen>;
}

function logLines(logDir: string): Record<string, unknown>[] {
  const p = join(logDir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as Record<string, unknown>);
}

async function listening(path: string): Promise<void> {
  for (let i = 0; i < 100 && !existsSync(path); i++) await Bun.sleep(10);
  expect(existsSync(path)).toBe(true);
}

/** Send raw bytes to the relay and return what comes back (up to its first line). */
function rawAsk(path: string, data: string): Promise<string> {
  return new Promise(resolve => {
    const s = createConnection({ path });
    let out = '';
    s.setEncoding('utf8');
    s.on('connect', () => {
      s.write(data);
    });
    s.on('data', (c: string) => {
      out += c;
      if (out.includes('\n')) {
        s.destroy();
        resolve(out);
      }
    });
    s.on('error', () => resolve(out));
    s.on('close', () => resolve(out));
  });
}

const server = config('server');
// A dispatcher's own config, made hostile: if any of it were used, the guard could not
// start (no such python) and its log would land elsewhere.
const evilDir = join(root, 'evil');
const hostile: JevShadowConfig = {
  python: '/nonexistent/python3',
  scriptsDir: evilDir,
  logDir: join(root, 'evil-log'),
  caller: 'evil',
};

describe('the judge relay (server process side)', () => {
  test('starts once per config, in a fresh 0700 directory, on a unix socket', async () => {
    const path = ensureJevRelay(server);
    expect(path).not.toBeNull();
    relayDirs.push(dirname(path!));
    expect(statSync(dirname(path!)).mode & 0o777).toBe(0o700);
    expect(ensureJevRelay({ ...server, relay: '/elsewhere.sock' })).toBe(path);
    await listening(path!);
    expect(statSync(path!).isSocket()).toBe(true);
  });

  test("a relayed call gets the server's verdict, judged with the server's login, logged once", async () => {
    const path = ensureJevRelay(server)!;
    await listening(path);
    const before = logLines(server.logDir).length;
    const c = call('rm -rf ../other-project');
    const v = await relayJudge(c, { ...hostile, relay: path });
    expect(v).toMatchObject({ decision: 'deny', stage: 'judge', mode: 'enforce' });
    expect(v.reason).toContain("deletes another project's files");
    const s = seen(server.scriptsDir);
    expect(s.claude_login).toBe('oauth-login');
    expect(JSON.stringify(s.req)).not.toContain('oauth-login');
    expect(relayRequest(c)).not.toContain('oauth-login');
    // logged once, by the server's judgeCall, in the server's log
    expect(logLines(server.logDir).length).toBe(before + 1);
    expect(existsSync(hostile.logDir)).toBe(false);
    expect(existsSync(evilDir)).toBe(false);
  });

  test('a config in the request is ignored: the server judges with its own', async () => {
    const path = ensureJevRelay(server)!;
    await listening(path);
    mkdirSync(evilDir, { recursive: true });
    writeFileSync(join(evilDir, 'session_guard.py'), 'print("{}")\n');
    const body = {
      ...JSON.parse(relayRequest(call('ls'))),
      python: '/nonexistent/python3',
      scriptsDir: evilDir,
      config: hostile,
      jevShadow: hostile,
    };
    const out = await rawAsk(path, `${JSON.stringify(body)}\n`);
    expect(JSON.parse(out)).toMatchObject({ decision: 'allow', stage: 'prefilter' });
    expect(seen(server.scriptsDir).req.tool_input).toEqual({ command: 'ls' });
    expect(existsSync(join(evilDir, 'seen.json'))).toBe(false);
    expect(existsSync(hostile.logDir)).toBe(false);
  });

  test('malformed or oversized requests are denied', async () => {
    const path = ensureJevRelay(server)!;
    await listening(path);
    const good = JSON.parse(relayRequest(call('ls'))) as Record<string, unknown>;
    const bad = [
      'not json\n',
      '[1,2]\n',
      `${JSON.stringify({ ...good, provider: 'claude' })}\n`,
      `${JSON.stringify({ ...good, toolInput: ['ls'] })}\n`,
      `${JSON.stringify({ ...good, toolName: 7 })}\n`,
      `${JSON.stringify({ ...good, cwd: undefined })}\n`,
      `${JSON.stringify({ ...good, env: { A: 1 } })}\n`,
      `${JSON.stringify({ ...good, requestSource: 'someone' })}\n`,
    ];
    for (const req of bad) {
      const v = JSON.parse(await rawAsk(path, req)) as Record<string, unknown>;
      expect(v).toMatchObject({ decision: 'deny', stage: 'archon:relay' });
      expect(v.reason).toContain('malformed');
    }
    const huge = JSON.parse(await rawAsk(path, 'x'.repeat(RELAY_MAX_REQUEST + 10)));
    expect(huge).toMatchObject({ decision: 'deny', stage: 'archon:relay' });
    expect(huge.reason).toContain('over 1 MB');
  });

  test('a large write is clipped by the client, so it is judged rather than refused for size', async () => {
    const path = ensureJevRelay(server)!;
    const big = call('', {
      toolName: 'Write',
      toolInput: { file_path: '/work/tree/a.txt', content: 'a'.repeat(2_000_000) },
    });
    expect(relayRequest(big).length).toBeLessThan(RELAY_MAX_REQUEST);
    const v = await relayJudge(big, { ...hostile, relay: path });
    expect(v).toMatchObject({ decision: 'allow', stage: 'prefilter' });
  });
});

describe('the judge relay (dispatcher side): falling back', () => {
  test('a relay that cannot be reached leaves the call to the local guard, the failure logged', async () => {
    const local = config('local');
    const v = await relayJudge(call('ls'), { ...local, relay: join(root, 'no-such.sock') });
    expect(v).toMatchObject({ decision: 'allow', stage: 'prefilter' });
    const last = logLines(local.logDir).pop();
    expect(last?.error).toContain('judge relay: unreachable');
    expect(String(last?.error)).not.toContain('ls');
  });

  test('a relay that answers nothing readable leaves the call to the local guard', async () => {
    const local = config('garbled');
    const path = join(root, 'garbled.sock');
    const fake = createServer(s => {
      s.on('data', () => s.end('this is not a verdict\n'));
    });
    await new Promise<void>(r => fake.listen(path, r));
    try {
      const v = await relayJudge(call('rm -rf x'), { ...local, relay: path });
      expect(v).toMatchObject({ decision: 'deny', stage: 'judge' });
      expect(logLines(local.logDir).pop()?.error).toContain('no readable verdict');
    } finally {
      await new Promise<void>(r => fake.close(() => r()));
    }
  });

  test('no relay pinned: the local guard, as before', async () => {
    const local = config('norelay');
    expect((await relayJudge(call('ls'), local)).decision).toBe('allow');
    expect(logLines(local.logDir).pop()?.error).toBeUndefined();
  });
});

describe('prepareHookRun pins the relay', () => {
  const spec = (extra: Partial<HookRunSpec>): HookRunSpec => ({
    version: 1,
    provider: 'codex',
    cwd: '/w',
    pathGuard: true,
    ...extra,
  });
  const written = (env: Record<string, string>): { text: string; spec: HookRunSpec } => {
    const text = readFileSync(env.ARCHON_HOOK_SPEC, 'utf8');
    return { text, spec: JSON.parse(text) as HookRunSpec };
  };

  test("for Codex and Grok, the server's own socket; a relay given in the spec is not kept", () => {
    const expected = ensureJevRelay(server);
    for (const provider of ['codex', 'grok'] as const) {
      const run = prepareHookRun(
        spec({ provider, jevShadow: { ...server, relay: join(root, 'evil.sock') } })
      );
      const { text, spec: s } = written(run.env);
      expect(s.jevShadow?.relay).toBe(expected!);
      expect(s.jevShadow).toMatchObject({ scriptsDir: server.scriptsDir });
      // the spec file never holds the login
      expect(text).not.toContain('oauth-login');
      run.cleanup();
    }
  });

  test('none when the Jev guard is off', () => {
    const run = prepareHookRun(spec({ jevShadow: null }));
    expect(written(run.env).spec.jevShadow).toBeNull();
    run.cleanup();
  });
});
