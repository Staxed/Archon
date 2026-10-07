import { afterAll, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_JEV_SCRIPTS_DIR,
  GUARD_DEADLINE_S,
  JEV_GUARD_MODE_FILE,
  JUDGE_KILL_MS,
  RecentBlocks,
  blockedCallText,
  callContext,
  claudeShapedCall,
  fitPatch,
  guardRequest,
  judgeCall,
  judgeEnv,
  readArchonGuardMode,
  resolveJevShadowConfig,
  verdictOf,
  type GuardVerdict,
  type JevShadowConfig,
  type ShadowCall,
} from './jev-shadow';

const root = mkdtempSync(join(tmpdir(), 'jev-shadow-test-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * A stand-in for stixed's session_guard.py with the same CLI (`--stdin-json
 * [--caller NAME]`, one Decision as JSON on stdout, exit 0). It records what it was
 * given next to itself and answers by the command's first word. No model is called.
 */
const FAKE_SESSION_GUARD = String.raw`
import json, os, sys, time
HERE = os.path.dirname(os.path.abspath(__file__))
req = json.loads(sys.stdin.read() or "{}")
with open(os.path.join(HERE, "seen.json"), "w") as f:
    json.dump({"req": req, "argv": sys.argv[1:], "gateway": os.environ.get("JEV_GATEWAY_URL"),
               "caller_env": os.environ.get("JEV_CALLER"),
               "server_secret_in_env": "POSTGRES_PASSWORD" in os.environ}, f)
ti = req.get("tool_input") or {}
cmd = str(ti.get("command", ""))
word = cmd.split(" ")[0] if cmd else ""
def out(**d):
    base = {"outcome": "allow", "stage": "prefilter", "reason": "nothing at stake (pre-filter)",
            "verdict": None, "judge": None, "mode": "enforce", "enforced": True, "would": "",
            "cli": req.get("cli"), "profile": req.get("profile"), "elapsed_ms": 1, "user_runs_it": False}
    base.update(d)
    print(json.dumps(base))
if word == "rm":
    out(outcome="deny", stage="judge", reason="deletes another project's files")
elif word == "logonly":
    out(outcome="allow", stage="jev", reason="would deny: deletes data", mode="log-only",
        enforced=False, would="deny")
elif word == "denyraw":
    out(outcome="deny", stage="jev", reason="a would-deny printed as deny", mode="log-only", enforced=False)
elif word == "floor":
    out(outcome="deny", stage="open_check", reason="HARD STOP: opens a secret file")
elif word == "control":
    out(outcome="deny", stage="code", reason="code: control API write", user_runs_it=True)
elif word == "ask":
    out(outcome="ask", stage="not_judged", reason="agy can't read it")
elif word == "sleep":
    time.sleep(30)
elif word == "crash":
    raise RuntimeError("boom")
elif word == "garbage":
    print("this is not a decision")
elif word == "trailing":
    print("a warning line first")
    out(outcome="deny", stage="judge", reason="denied after noise")
else:
    out()
`;

function fakeScripts(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session_guard.py'), FAKE_SESSION_GUARD);
  return dir;
}

function config(scriptsDir: string, logDir: string, extra: Partial<JevShadowConfig> = {}) {
  return {
    python: existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3',
    scriptsDir,
    logDir,
    caller: 'archon',
    ...extra,
  } satisfies JevShadowConfig;
}

function call(command: string, extra: Partial<ShadowCall> = {}): ShadowCall {
  return {
    provider: 'codex',
    toolName: 'Bash',
    toolInput: { command },
    cwd: '/work/tree/pkg',
    projectRoot: '/work/tree',
    env: { PATH: '/usr/bin', DATABASE_URL: 'postgresql://x.invalid/none', GH_TOKEN: 'tok' },
    userRequest: 'clean up the build',
    runId: 'run-1',
    nodeId: 'implement',
    workflow: 'archon-sdlc-deliver',
    workflowSource: 'bundled',
    requestSource: 'user',
    archonGuard: 'pass',
    ...extra,
  };
}

function seen(dir: string): {
  req: Record<string, unknown>;
  argv: string[];
  gateway: string | null;
  caller_env: string | null;
  server_secret_in_env: boolean;
} {
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

describe('resolveJevShadowConfig', () => {
  test('off under bun test unless a scripts folder is named (no test ever calls Jev)', () => {
    expect(resolveJevShadowConfig({ NODE_ENV: 'test' }, '/h')).toBeNull();
  });

  test('ARCHON_JEV_SHADOW=off switches it off', () => {
    const dir = fakeScripts('cfg-off');
    expect(
      resolveJevShadowConfig({ ARCHON_JEV_SHADOW: 'off', ARCHON_JEV_SCRIPTS_DIR: dir }, '/h')
    ).toBeNull();
  });

  test('a folder without session_guard.py means off', () => {
    const dir = join(root, 'only-jev-guard');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'jev_guard.py'), '');
    expect(resolveJevShadowConfig({ ARCHON_JEV_SCRIPTS_DIR: dir }, '/h')).toBeNull();
  });

  test('resolved: log under the Archon home, gateway from ARCHON_LLM_GATEWAY_URL, caller archon', () => {
    const dir = fakeScripts('cfg-on');
    const c = resolveJevShadowConfig(
      {
        ARCHON_JEV_SCRIPTS_DIR: dir,
        ARCHON_LLM_GATEWAY_URL: 'http://host.docker.internal:8093/',
      },
      '/home/staxed/.archon'
    );
    expect(c).toMatchObject({
      scriptsDir: dir,
      logDir: '/home/staxed/.archon/logs/jev-shadow',
      gatewayUrl: 'http://host.docker.internal:8093/openrouter/v1/systemone',
      caller: 'archon',
    });
  });

  test('the default is the root-owned promoted copy', () => {
    expect(DEFAULT_JEV_SCRIPTS_DIR).toBe('/usr/local/lib/stixed/.claude/scripts');
  });
});

describe('readArchonGuardMode (the root-owned mode file)', () => {
  const file = (name: string, body: string): string => {
    const p = join(root, name);
    writeFileSync(p, body);
    chmodSync(p, 0o644);
    return p;
  };

  test('the archon key, else default, else log-only', () => {
    expect(readArchonGuardMode(file('m1.json', '{"archon":"enforce","claude":"off"}'), false)).toBe(
      'enforce'
    );
    expect(readArchonGuardMode(file('m2.json', '{"default":"off"}'), false)).toBe('off');
    expect(readArchonGuardMode(file('m3.json', '{"codex":"enforce"}'), false)).toBe('log-only');
  });

  test('missing, malformed or an unknown value is log-only', () => {
    expect(readArchonGuardMode(join(root, 'nope.json'), false)).toBe('log-only');
    expect(readArchonGuardMode(file('m4.json', 'not json'), false)).toBe('log-only');
    expect(readArchonGuardMode(file('m5.json', '{"archon":"ENFORCE"}'), false)).toBe('log-only');
    expect(readArchonGuardMode(file('m6.json', '["enforce"]'), false)).toBe('log-only');
    expect(readArchonGuardMode(root, false)).toBe('log-only'); // a folder, not a file
  });

  test('a present archon key wins even when null or unknown, as session_guard.read_mode reads it', () => {
    // Python: data.get("archon", data.get("default")) -> None -> log-only, never the default.
    expect(readArchonGuardMode(file('m9.json', '{"archon":null,"default":"enforce"}'), false)).toBe(
      'log-only'
    );
    expect(
      readArchonGuardMode(file('m10.json', '{"archon":"bogus","default":"enforce"}'), false)
    ).toBe('log-only');
  });

  test('an unreadable file is log-only', () => {
    const p = file('m11.json', '{"archon":"enforce"}');
    chmodSync(p, 0o000);
    if (process.getuid?.() !== 0) expect(readArchonGuardMode(p, false)).toBe('log-only');
    chmodSync(p, 0o644);
  });

  test("a file that is not root's is ignored: log-only (an agent cannot switch it on or off)", () => {
    const p = file('m7.json', '{"archon":"enforce"}');
    if (process.getuid?.() !== 0) expect(readArchonGuardMode(p)).toBe('log-only');
  });

  test('a group- or world-writable file is ignored even when not checking the owner', () => {
    const p = file('m8.json', '{"archon":"enforce"}');
    chmodSync(p, 0o666);
    // requireRoot=false skips the owner check only; the writable bits still count when it is on
    expect(readArchonGuardMode(p, false)).toBe('enforce');
    if (process.getuid?.() !== 0) expect(readArchonGuardMode(p, true)).toBe('log-only');
  });

  test('the real path is the one session_guard reads', () => {
    expect(JEV_GUARD_MODE_FILE).toBe('/etc/stixed/jev-guard-mode.json');
  });
});

describe('claudeShapedCall (Codex/Grok calls in Claude vocabulary)', () => {
  test('shell calls become Bash', () => {
    expect(
      claudeShapedCall(['Bash'], [], { command: ['bash', '-lc', 'ls'] }, 'bash -lc ls')
    ).toEqual({ toolName: 'Bash', toolInput: { command: 'bash -lc ls' } });
  });

  test('apply_patch goes whole, for session_guard to split into every file and delete', () => {
    const patch =
      '*** Begin Patch\n*** Update File: a.ts\n+x\n*** Delete File: b.ts\n*** End Patch';
    expect(
      claudeShapedCall(
        ['Edit', 'MultiEdit'],
        ['a.ts', 'b.ts'],
        { command: patch },
        undefined,
        'apply_patch'
      )
    ).toEqual({ toolName: 'apply_patch', toolInput: { patch } });
    expect(
      claudeShapedCall(['Edit'], [], { command: '' }, undefined, 'apply_patch')
    ).toBeUndefined();
  });

  test('a long patch keeps every header: a late delete is never clipped away', () => {
    const pad = Array.from({ length: 600 }, (_, i) => `+line ${String(i)} ${'x'.repeat(50)}`);
    const patch = [
      '*** Begin Patch',
      '*** Update File: docs/notes.md',
      ...pad,
      '  *** Delete File: secrets/key.pem',
      '*** End Patch',
    ].join('\n');
    expect(patch.length).toBeGreaterThan(24_000);
    const req = JSON.parse(
      guardRequest({
        provider: 'codex',
        toolName: 'apply_patch',
        toolInput: { patch },
        cwd: '/w',
        projectRoot: '/w',
        env: {},
      })
    ) as { tool_input: { patch: string } };
    const sent = req.tool_input.patch;
    expect(sent.length).toBeLessThanOrEqual(24_000);
    expect(sent).toContain('*** Update File: docs/notes.md');
    expect(sent).toContain('  *** Delete File: secrets/key.pem');
    expect(sent.endsWith('*** End Patch')).toBe(true);
    expect(fitPatch('short')).toBe('short');
  });

  test('a refused patch is remembered by its files', () => {
    const patch =
      '*** Begin Patch\n*** Update File: a.ts\n+x\n*** Delete File: b.ts\n*** End Patch';
    expect(blockedCallText('apply_patch', { patch })).toBe(
      'apply_patch *** Update File: a.ts; *** Delete File: b.ts'
    );
  });

  test('a Grok write becomes a Write with its content', () => {
    expect(
      claudeShapedCall(
        ['Write'],
        ['/w/x.txt'],
        { file_path: '/w/x.txt', content: 'K=v' },
        undefined
      )
    ).toEqual({ toolName: 'Write', toolInput: { file_path: '/w/x.txt', content: 'K=v' } });
  });

  test('reads, searches and plans are not judged', () => {
    expect(claudeShapedCall(['Read'], [], { file_path: 'a' }, undefined)).toBeUndefined();
    expect(claudeShapedCall(['Glob', 'LS'], [], { path: '.' }, undefined)).toBeUndefined();
    expect(claudeShapedCall(['TodoWrite'], [], {}, undefined)).toBeUndefined();
  });
});

describe('guardRequest (what session_guard reads on stdin)', () => {
  test('profile archon, the call, the env, and exactly the archon channel context', () => {
    const req = JSON.parse(
      guardRequest(
        call('git push -u origin HEAD', { parentRunId: 'parent-9', requestSource: 'parent_run' })
      )
    ) as Record<string, unknown>;
    expect(req).toMatchObject({
      cli: 'codex',
      tool: 'Bash',
      tool_input: { command: 'git push -u origin HEAD' },
      cwd: '/work/tree/pkg',
      profile: 'archon',
      deadline_s: GUARD_DEADLINE_S,
    });
    expect(req.context).toEqual({
      user_request: 'clean up the build',
      workflow: 'archon-sdlc-deliver',
      workflow_source: 'bundled',
      request_source: 'parent_run',
      parent_run_id: 'parent-9',
      run_id: 'run-1',
      node_id: 'implement',
    });
    expect((req as { env: Record<string, string> }).env.GH_TOKEN).toBe('tok');
  });

  test('unknown run fields are left out, not sent empty', () => {
    const req = JSON.parse(
      guardRequest(
        call('ls', {
          workflowSource: undefined,
          requestSource: undefined,
          workflow: undefined,
          userRequest: undefined,
        })
      )
    ) as { context: Record<string, unknown> };
    expect(req.context).not.toHaveProperty('workflow_source');
    expect(req.context).not.toHaveProperty('request_source');
    expect(req.context).not.toHaveProperty('parent_run_id');
    expect(req.context.user_request).toBe('');
  });

  test("Archon's hook plumbing is not part of the env the guard sees", () => {
    expect(
      judgeEnv({ ARCHON_HOOK_SPEC: '/tmp/s.json', ARCHON_HOOK_EVENTS: 'PreToolUse', A: '1' })
    ).toEqual({ A: '1' });
  });

  test('big inputs are clipped so the payload fits a pipe buffer; cycles do not throw', () => {
    const p = guardRequest(
      call('x', { toolName: 'Write', toolInput: { file_path: 'f', content: 'a'.repeat(200_000) } })
    );
    expect(p.length).toBeLessThan(40_000);
    const cyclic: Record<string, unknown> = { command: 'ls' };
    cyclic.self = cyclic;
    expect(() => guardRequest(call('ls', { toolInput: cyclic }))).not.toThrow();
  });

  test('callContext copies the GuardContext fields that are set', () => {
    expect(
      callContext({
        runId: 'r',
        requestSource: 'trigger',
        workflowSource: 'repo',
        parentRunId: 'p',
      })
    ).toEqual({ runId: 'r', requestSource: 'trigger', workflowSource: 'repo', parentRunId: 'p' });
    expect(callContext(undefined)).toEqual({});
  });
});

describe("recent_blocked_calls (the session's own refusals)", () => {
  test('sent in the context when the caller keeps them (last 5), left out otherwise', () => {
    const blocked = Array.from({ length: 7 }, (_, i) => ({ call: `c${i}`, blocked_by: 'b' }));
    const req = JSON.parse(guardRequest(call('ls', { recentBlockedCalls: blocked })));
    expect(req.context.recent_blocked_calls).toEqual(blocked.slice(-5));
    const none = JSON.parse(guardRequest(call('ls')));
    expect('recent_blocked_calls' in none.context).toBe(false);
  });

  test('RecentBlocks keeps enforced denies only, the last 5 of the last 10 minutes', () => {
    let now = 0;
    const blocks = new RecentBlocks(10 * 60_000, 5, () => now);
    const c = (command: string) =>
      ({ provider: 'codex', toolName: 'Bash', toolInput: { command } }) as const;
    const deny: GuardVerdict = { decision: 'deny', reason: 'r', stage: 'jev' };
    blocks.add(c('allowed'), { decision: 'allow', reason: 'r', stage: 'jev' });
    expect(blocks.list()).toEqual([]);
    for (let i = 0; i < 6; i++) blocks.add(c(`x${i}`), deny);
    expect(blocks.list().map(b => b.call)).toEqual(['x1', 'x2', 'x3', 'x4', 'x5']);
    expect(blocks.list()[0].blocked_by).toBe('jev:archon-codex:jev');
    now = 10 * 60_000 + 1;
    expect(blocks.list()).toEqual([]);
  });

  test('a write or fetch is named by its path or URL', () => {
    expect(blockedCallText('Write', { file_path: '/a/b', content: 'secret text' })).toBe(
      'Write /a/b'
    );
    expect(blockedCallText('WebFetch', { url: 'https://x.test/' })).toBe(
      'WebFetch https://x.test/'
    );
  });
});

describe('verdictOf (reading the Decision)', () => {
  const d = (o: Record<string, unknown>): string => JSON.stringify(o);

  test('must stop: an enforced deny denies with the guard reason and the next step', () => {
    const v = verdictOf(
      d({ outcome: 'deny', stage: 'judge', reason: 'no', enforced: true, mode: 'enforce' })
    );
    expect(v.decision).toBe('deny');
    expect(v.reason).toContain('jev-guard: denied (no)');
    expect(v.reason).toContain('Nothing ran.');
  });

  test('must stop: a floor deny keeps its own words (HARD STOP)', () => {
    const v = verdictOf(
      d({ outcome: 'deny', stage: 'open_check', reason: 'HARD STOP: x', enforced: true })
    );
    expect(v).toMatchObject({ decision: 'deny', reason: 'HARD STOP: x', stage: 'open_check' });
  });

  test('must pass: allow, and a log-only would-deny (enforced false), even printed as deny', () => {
    expect(verdictOf(d({ outcome: 'allow', stage: 'prefilter', reason: 'ok' })).decision).toBe(
      'allow'
    );
    expect(
      verdictOf(d({ outcome: 'allow', stage: 'jev', reason: 'r', enforced: false, would: 'deny' }))
        .decision
    ).toBe('allow');
    expect(
      verdictOf(d({ outcome: 'deny', stage: 'jev', reason: 'r', enforced: false })).decision
    ).toBe('allow');
  });

  test('must stop: ask (no human in a run), nothing, or garbage', () => {
    expect(verdictOf(d({ outcome: 'ask', stage: 'not_judged', reason: 'r' })).decision).toBe(
      'deny'
    );
    expect(verdictOf('').decision).toBe('deny');
    expect(verdictOf('not json').decision).toBe('deny');
    expect(verdictOf('[1,2]').decision).toBe('deny');
  });

  test('the Decision is the last JSON line (a warning printed before it is skipped)', () => {
    expect(verdictOf(`warn\n${d({ outcome: 'allow', stage: 'read', reason: 'r' })}`).decision).toBe(
      'allow'
    );
  });
});

describe('judgeCall (real python, fake session_guard; no model calls)', () => {
  const dir = fakeScripts('judge');
  const logDir = join(root, 'judge-log');
  const cfg = config(dir, logDir, { gatewayUrl: 'http://gw:8093/openrouter/v1/systemone' });

  test('must pass: an allow lets the call run; the guard got the call, the caller and the gateway', async () => {
    const v = await judgeCall(call('ls -la'), cfg);
    expect(v).toMatchObject({ decision: 'allow', stage: 'prefilter', mode: 'enforce' });
    const s = seen(dir);
    expect(s.argv).toEqual(['--stdin-json', '--caller', 'archon']);
    expect(s.req.profile).toBe('archon');
    expect(s.gateway).toBe('http://gw:8093/openrouter/v1/systemone');
    expect(s.caller_env).toBe('archon');
  });

  test('the guard process does not inherit the server env (secrets reach it only as the call env)', async () => {
    const saved = process.env.POSTGRES_PASSWORD;
    process.env.POSTGRES_PASSWORD = 'server-secret';
    try {
      await judgeCall(call('ls'), cfg);
    } finally {
      if (saved === undefined) delete process.env.POSTGRES_PASSWORD;
      else process.env.POSTGRES_PASSWORD = saved;
    }
    expect(seen(dir).server_secret_in_env).toBe(false);
  });

  test('must stop: an enforced deny', async () => {
    const v = await judgeCall(call('rm -rf ../other-project'), cfg);
    expect(v.decision).toBe('deny');
    expect(v.reason).toContain("deletes another project's files");
  });

  test('must stop: a floor deny keeps its HARD STOP words', async () => {
    const v = await judgeCall(call('floor cat secrets'), cfg);
    expect(v).toMatchObject({ decision: 'deny', stage: 'open_check' });
    expect(v.reason).toBe('HARD STOP: opens a secret file');
  });

  test("must stop: a control-API write is the user's to run", async () => {
    const v = await judgeCall(call('control post'), cfg);
    expect(v.decision).toBe('deny');
    expect(v.reason).toContain("This is the user's to run");
  });

  test('must pass: a log-only would-deny lets the call run', async () => {
    expect((await judgeCall(call('logonly rm -rf data'), cfg)).decision).toBe('allow');
    expect((await judgeCall(call('denyraw rm -rf data'), cfg)).decision).toBe('allow');
  });

  test('must stop: ask, garbage output, a crash', async () => {
    expect((await judgeCall(call('ask x'), cfg)).decision).toBe('deny');
    const g = await judgeCall(call('garbage'), cfg);
    expect(g).toMatchObject({ decision: 'deny', stage: 'archon:unreadable' });
    const c = await judgeCall(call('crash now'), cfg);
    expect(c).toMatchObject({ decision: 'deny', stage: 'archon:crash' });
    expect(c.reason).toContain('exited with code 1');
  });

  test('a Decision after noise on stdout is still read', async () => {
    expect((await judgeCall(call('trailing'), cfg)).decision).toBe('deny');
  });

  test('must stop: no verdict before the backstop kills the guard', async () => {
    const t = performance.now();
    const v = await judgeCall(call('sleep forever'), cfg, 400);
    expect(performance.now() - t).toBeLessThan(5_000);
    expect(v).toMatchObject({ decision: 'deny', stage: 'archon:deadline' });
    expect(v.reason).toContain('no verdict in 0.4 s');
  });

  test('the backstop is 40 s, above session_guard`s own 30 s deadline', () => {
    expect(JUDGE_KILL_MS).toBe(40_000);
    expect(GUARD_DEADLINE_S).toBe(30);
  });

  test('must stop: the guard cannot start (no python, no scripts)', async () => {
    const v1 = await judgeCall(call('ls'), config(dir, logDir, { python: '/nonexistent/python3' }));
    expect(v1.decision).toBe('deny');
    const v2 = await judgeCall(call('ls'), config(join(root, 'nowhere'), logDir));
    expect(v2).toMatchObject({ decision: 'deny', stage: 'archon:crash' });
  });

  test('each judged call is logged with outcome and stage only: no command, env, request or reason', async () => {
    const lines = logLines(logDir);
    expect(lines.length).toBeGreaterThan(5);
    const text = JSON.stringify(lines);
    expect(text).not.toContain('rm -rf');
    expect(text).not.toContain('tok');
    expect(text).not.toContain('clean up the build');
    expect(text).not.toContain("deletes another project's files");
    expect(lines.some(l => l.decision === 'deny' && l.stage === 'judge')).toBe(true);
    expect(lines.some(l => l.stage === 'archon:deadline')).toBe(true);
  });
});
