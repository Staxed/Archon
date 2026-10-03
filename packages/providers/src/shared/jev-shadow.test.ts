import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_JEV_SCRIPTS_DIR,
  JUDGE_SCRIPT,
  MAX_CONCURRENT_JUDGES,
  judgesInFlight,
  claudeShapedCall,
  judgeEnv,
  resolveJevShadowConfig,
  shadowJudge,
  shadowPayload,
  type JevShadowConfig,
  type ShadowCall,
} from './jev-shadow';

const root = mkdtempSync(join(tmpdir(), 'jev-shadow-test-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * A stand-in for stixed's jev_guard.py with the same public surface the judge
 * uses (decide, redact, CALLER). It records what it was given next to itself.
 */
const FAKE_JEV_GUARD = `
import json, os, re
CALLER = "stixed"
HERE = os.path.dirname(os.path.abspath(__file__))
def redact(text):
    return re.sub(r"SECRET[0-9]+", "[REDACTED]", str(text))
class V:
    def __init__(self, **kw):
        self.__dict__.update(kw)
def decide(tool_name, tool_input, context):
    with open(os.path.join(HERE, "seen.json"), "w") as f:
        json.dump({"tool": tool_name, "input": tool_input, "context": context, "caller": CALLER,
                   "gateway": os.environ.get("JEV_GATEWAY_URL"),
                   "server_secret_in_env": "POSTGRES_PASSWORD" in os.environ}, f)
    cmd = str(tool_input.get("command", ""))
    if cmd.startswith("crash"):
        raise RuntimeError("boom SECRET999")
    if cmd.startswith("rm"):
        return V(decision="deny", reason="deletes the project SECRET111", asked=True,
                 triggers=["destructive: " + cmd], facts={"project": "p", "live_values": ["SECRET222"]},
                 model="typesafe/jev-1.13-20260917", latency_ms=321, cost=0.0001, error="")
    return V(decision="allow", reason="nothing at stake (pre-filter)", asked=False, triggers=[],
             facts={}, model="", latency_ms=0, cost=0.0, error="")
`;

function fakeScripts(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'jev_guard.py'), FAKE_JEV_GUARD);
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
    provider: 'claude',
    toolName: 'Bash',
    toolInput: { command },
    cwd: '/work/tree',
    projectRoot: '/work/tree',
    env: { PATH: '/usr/bin', DATABASE_URL: 'postgresql://x.invalid/none', GH_TOKEN: 'SECRET333' },
    userRequest: 'clean up SECRET444',
    runId: 'run-1',
    nodeId: 'implement',
    workflow: 'probe',
    archonGuard: 'pass',
    ...extra,
  };
}

/** Wait for the detached judge to append its line. */
async function logLines(logDir: string, n = 1): Promise<Record<string, unknown>[]> {
  for (let i = 0; i < 100; i++) {
    const day = new Date();
    for (const d of [day, new Date(day.getTime() - 86_400_000)]) {
      const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const p = join(logDir, `${local}.jsonl`);
      if (existsSync(p)) {
        const lines = readFileSync(p, 'utf8').trim().split('\n').filter(Boolean);
        if (lines.length >= n) return lines.map(l => JSON.parse(l) as Record<string, unknown>);
      }
    }
    await Bun.sleep(50);
  }
  throw new Error(`no ${n} log line(s) in ${logDir}`);
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

  test('a folder without jev_guard.py means off', () => {
    expect(resolveJevShadowConfig({ ARCHON_JEV_SCRIPTS_DIR: root }, '/h')).toBeNull();
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

describe('claudeShapedCall (Codex/Grok calls in Claude vocabulary)', () => {
  test('shell calls become Bash', () => {
    expect(
      claudeShapedCall(['Bash'], [], { command: ['bash', '-lc', 'ls'] }, 'bash -lc ls')
    ).toEqual({ toolName: 'Bash', toolInput: { command: 'bash -lc ls' } });
  });

  test('apply_patch becomes an Edit carrying the patch', () => {
    const patch = '*** Begin Patch\n*** Update File: a.ts\n+x\n*** End Patch';
    expect(
      claudeShapedCall(['Edit', 'MultiEdit'], ['a.ts'], { command: patch }, undefined)
    ).toEqual({ toolName: 'Edit', toolInput: { file_path: 'a.ts', new_string: patch } });
  });

  test('a Grok write becomes a Write with its content', () => {
    expect(
      claudeShapedCall(
        ['Write'],
        ['/w/x.env'],
        { file_path: '/w/x.env', content: 'K=v' },
        undefined
      )
    ).toEqual({ toolName: 'Write', toolInput: { file_path: '/w/x.env', content: 'K=v' } });
  });

  test('reads, searches and plans are not judged', () => {
    expect(claudeShapedCall(['Read'], [], { file_path: 'a' }, undefined)).toBeUndefined();
    expect(claudeShapedCall(['Glob', 'LS'], [], { path: '.' }, undefined)).toBeUndefined();
    expect(claudeShapedCall(['TodoWrite'], [], {}, undefined)).toBeUndefined();
  });
});

describe('payload', () => {
  test("Archon's hook plumbing is not part of the env the judge sees", () => {
    const env = judgeEnv({
      ARCHON_HOOK_SPEC: '/tmp/s.json',
      ARCHON_HOOK_EVENTS: 'PreToolUse',
      A: '1',
    });
    expect(env).toEqual({ A: '1' });
  });

  test('big inputs are clipped so the payload fits a pipe buffer', () => {
    const p = shadowPayload(
      call('x', { toolName: 'Write', toolInput: { file_path: 'f', content: 'a'.repeat(200_000) } }),
      config('/s', '/l')
    );
    expect(p.length).toBeLessThan(40_000);
  });
});

describe('shadowJudge (real python, fake jev_guard)', () => {
  test('a verdict is logged, redacted, with no env, request or fact values', async () => {
    const dir = fakeScripts('judge-deny');
    const logDir = join(root, 'log-deny');
    await shadowJudge(
      call('rm -rf src SECRET555'),
      config(dir, logDir, { gatewayUrl: 'http://gw:8093/openrouter/v1/systemone' })
    );
    const [entry] = await logLines(logDir);
    expect(entry).toMatchObject({
      provider: 'claude',
      tool: 'Bash',
      decision: 'deny',
      asked: true,
      run_id: 'run-1',
      node_id: 'implement',
      workflow: 'probe',
      archon_guard: 'pass',
      fact_keys: ['live_values', 'project'],
      model: 'typesafe/jev-1.13-20260917',
    });
    const text = JSON.stringify(entry);
    expect(text).not.toMatch(/SECRET\d/); // redacted call, reason, triggers; no fact values
    expect(text).not.toContain('clean up'); // the user request is never logged
    expect(text).not.toContain('postgresql'); // nor the env

    // what jev_guard was handed
    const seen = JSON.parse(readFileSync(join(dir, 'seen.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(seen.caller).toBe('archon');
    expect(seen.gateway).toBe('http://gw:8093/openrouter/v1/systemone');
    expect(seen.server_secret_in_env).toBe(false); // the judge process gets a minimal env
    expect(seen.context).toMatchObject({
      cwd: '/work/tree',
      project_root: '/work/tree',
      user_request: 'clean up SECRET444',
      env: { DATABASE_URL: 'postgresql://x.invalid/none', GH_TOKEN: 'SECRET333', PATH: '/usr/bin' },
    });
  });

  test('a crash inside jev_guard is one error line', async () => {
    const dir = fakeScripts('judge-crash');
    const logDir = join(root, 'log-crash');
    await shadowJudge(call('crash now'), config(dir, logDir));
    const [entry] = await logLines(logDir);
    expect(entry.decision).toBe('error');
    expect(String(entry.error)).toContain('RuntimeError');
    expect(String(entry.error)).not.toContain('SECRET999');
  });

  test('a scripts folder that vanished is one error line', async () => {
    const logDir = join(root, 'log-missing');
    await shadowJudge(call('ls'), config(join(root, 'nowhere'), logDir));
    const [entry] = await logLines(logDir);
    expect(entry.decision).toBe('error');
    expect(String(entry.error)).toContain('ModuleNotFoundError');
  });

  test('no python: logged from this side, the promise still settles', async () => {
    const logDir = join(root, 'log-nopython');
    await shadowJudge(call('ls'), config('/s', logDir, { python: '/nonexistent/python3' }));
    const [entry] = await logLines(logDir);
    expect(entry.decision).toBe('error');
    expect(String(entry.error)).toContain('judge did not start');
  });

  test('the caller never waits for the judgement (returns before the judge answers)', async () => {
    const dir = fakeScripts('judge-slow');
    writeFileSync(
      join(dir, 'jev_guard.py'),
      `${FAKE_JEV_GUARD}\nimport time\n_d = decide\ndef decide(*a):\n    time.sleep(1.5)\n    return _d(*a)\n`
    );
    const logDir = join(root, 'log-slow');
    const t = performance.now();
    await shadowJudge(call('ls'), config(dir, logDir));
    expect(performance.now() - t).toBeLessThan(1000);
    const [entry] = await logLines(logDir);
    expect(entry.decision).toBe('allow');
  });
});

describe('concurrency cap and timeout (shadow stays log-only)', () => {
  const SLEEPY = `${FAKE_JEV_GUARD}\nimport time\ndef decide(*a):\n    time.sleep(2)\n    return V(decision="allow", reason="", asked=False, triggers=[], facts={}, model="", latency_ms=0, cost=0.0, error="")\n`;

  test('cap reached: the extra call is skipped, logged "skipped: busy", and nothing throws', async () => {
    const dir = fakeScripts('judge-cap');
    writeFileSync(join(dir, 'jev_guard.py'), SLEEPY);
    const logDir = join(root, 'log-cap');
    const cfg = config(dir, logDir);
    for (let i = 0; i < MAX_CONCURRENT_JUDGES; i++) await shadowJudge(call('ls'), cfg, 10);
    expect(judgesInFlight()).toBe(MAX_CONCURRENT_JUDGES);
    await shadowJudge(call('ls extra'), cfg, 10); // resolves, does not reject
    const lines = await logLines(logDir);
    const skipped = lines.filter(l => l.decision === 'skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0].error).toBe('skipped: busy');
    // the slots come back once the judges finish
    for (let i = 0; i < 100 && judgesInFlight() > 0; i++) await Bun.sleep(100);
    expect(judgesInFlight()).toBe(0);
    await logLines(logDir, MAX_CONCURRENT_JUDGES + 1);
    await shadowJudge(call('ls again'), cfg, 10);
    expect(judgesInFlight()).toBe(1);
  }, 20_000);

  test('timeout: the judge logs it and exits even when jev_guard swallows exceptions', async () => {
    const dir = fakeScripts('judge-timeout');
    writeFileSync(
      join(dir, 'jev_guard.py'),
      `${FAKE_JEV_GUARD}\nimport time\ndef decide(*a):\n    while True:\n        try:\n            time.sleep(30)\n        except Exception:\n            pass\n`
    );
    const logDir = join(root, 'log-timeout');
    const payload = JSON.parse(shadowPayload(call('ls'), config(dir, logDir))) as {
      config: { timeout_s: number };
    };
    payload.config.timeout_s = 1;
    const t = performance.now();
    const proc = Bun.spawn(['python3', '-I', '-c', JUDGE_SCRIPT], {
      stdin: new TextEncoder().encode(JSON.stringify(payload)),
      stdout: 'ignore',
      stderr: 'ignore',
    });
    await proc.exited;
    expect(performance.now() - t).toBeLessThan(10_000);
    const [entry] = await logLines(logDir);
    expect(entry.decision).toBe('error');
    expect(String(entry.error)).toContain('timeout');
  }, 20_000);
});

describe('the real promoted jev_guard (no network: a call with nothing at stake)', () => {
  const real = DEFAULT_JEV_SCRIPTS_DIR;
  test.skipIf(!existsSync(join(real, 'jev_guard.py')))(
    '`ls -la` is judged allow by the pre-filter and logged',
    async () => {
      const logDir = join(root, 'log-real');
      await shadowJudge(call('ls -la', { cwd: root, projectRoot: root }), config(real, logDir));
      const [entry] = await logLines(logDir);
      expect(entry).toMatchObject({ decision: 'allow', asked: false, call: 'ls -la' });
    }
  );
});
