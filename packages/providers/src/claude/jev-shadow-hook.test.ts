import { describe, expect, mock, test } from 'bun:test';
import { JEV_GUARD_HOOK_TIMEOUT_S, createPreToolUseJevShadowHook } from './jev-shadow-hook';
import type { GuardVerdict, JevGuardMode, JevShadowConfig, ShadowCall } from '../shared/jev-shadow';

const CONFIG: JevShadowConfig = {
  python: 'python3',
  scriptsDir: '/s',
  logDir: '/l',
  caller: 'archon',
};

const ALLOW: GuardVerdict = { decision: 'allow', reason: 'nothing at stake', stage: 'prefilter' };

type Judge = (c: ShadowCall, cfg: JevShadowConfig) => Promise<GuardVerdict>;

function hookWith(judge: Judge, mode?: () => JevGuardMode) {
  return createPreToolUseJevShadowHook('/work/tree', CONFIG, {
    env: { PATH: '/usr/bin', GH_TOKEN: 't' },
    guardContext: {
      runId: 'r1',
      nodeId: 'n1',
      workflow: 'w',
      userRequest: 'tidy up',
      requestSource: 'orchestrator',
      workflowSource: 'repo',
    },
    judge,
    ...(mode ? { mode } : {}),
  });
}

async function run(hook: ReturnType<typeof hookWith>, input: Record<string, unknown>) {
  return hook(input as never, undefined, { signal: new AbortController().signal });
}

function denied(out: unknown): string | undefined {
  const hso = (out as { hookSpecificOutput?: Record<string, unknown> } | undefined)
    ?.hookSpecificOutput;
  return hso?.permissionDecision === 'deny' ? String(hso.permissionDecisionReason) : undefined;
}

describe('Claude Jev guard hook', () => {
  test('a Bash call is judged with the run context; an allow is "no opinion"', async () => {
    const judge = mock(async (_c: ShadowCall, _cfg: JevShadowConfig) => ALLOW);
    const out = await run(hookWith(judge), {
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf src/old' },
      cwd: '/work/tree/sub',
    });
    expect(out).toEqual({ continue: true });
    expect(judge).toHaveBeenCalledTimes(1);
    const [c] = judge.mock.calls[0];
    expect(c).toMatchObject({
      provider: 'claude',
      toolName: 'Bash',
      cwd: '/work/tree/sub',
      projectRoot: '/work/tree',
      runId: 'r1',
      nodeId: 'n1',
      workflow: 'w',
      userRequest: 'tidy up',
      requestSource: 'orchestrator',
      workflowSource: 'repo',
      archonGuard: 'pass',
      env: { PATH: '/usr/bin', GH_TOKEN: 't' },
    });
  });

  test('must stop: an enforced deny is permissionDecision deny with the guard reason', async () => {
    const out = await run(
      hookWith(async () => ({
        decision: 'deny',
        reason: 'jev-guard: denied (no)',
        stage: 'judge',
      })),
      { tool_name: 'Write', tool_input: { file_path: '/work/tree/a', content: 'x' } }
    );
    expect(denied(out)).toBe('jev-guard: denied (no)');
    expect(out).toMatchObject({ hookSpecificOutput: { hookEventName: 'PreToolUse' } });
  });

  test('must pass: a log-only would-deny (verdict allow, enforced false) lets the call run', async () => {
    const out = await run(
      hookWith(async () => ({
        decision: 'allow',
        reason: 'would deny',
        stage: 'jev',
        mode: 'log-only',
        enforced: false,
      })),
      { tool_name: 'Bash', tool_input: { command: 'docker compose down' } }
    );
    expect(out).toEqual({ continue: true });
  });

  test('must stop: a judge that throws denies (fail closed)', async () => {
    const out = await run(
      hookWith(() => {
        throw new Error('boom');
      }),
      { tool_name: 'Bash', tool_input: { command: 'ls' } }
    );
    expect(denied(out)).toContain('boom');
  });

  test('the hook waits for the verdict', async () => {
    let finished = false;
    const slow: Judge = async () => {
      await Bun.sleep(200);
      finished = true;
      return { decision: 'deny', reason: 'late no', stage: 'judge' };
    };
    const out = await run(hookWith(slow), { tool_name: 'Bash', tool_input: { command: 'ls' } });
    expect(finished).toBe(true);
    expect(denied(out)).toBe('late no');
  });

  test("a call Archon's floor refuses is left to the floor hook (no judge call)", async () => {
    const judge = mock(async (_c: ShadowCall, _cfg: JevShadowConfig) => ALLOW);
    const out = await run(hookWith(judge), {
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /' },
    });
    expect(out).toEqual({ continue: true });
    expect(judge).not.toHaveBeenCalled();
  });

  test('a volume delete is sent to the guard only in enforce (the floor leaves it to Jev)', async () => {
    for (const [mode, sent] of [
      ['enforce', true],
      ['log-only', false],
      ['off', false],
    ] as const) {
      const judge = mock(async (_c: ShadowCall, _cfg: JevShadowConfig) => ALLOW);
      const hook = hookWith(judge, () => mode);
      await run(hook, { tool_name: 'Bash', tool_input: { command: 'docker volume rm pgdata' } });
      expect(judge).toHaveBeenCalledTimes(sent ? 1 : 0);
      // Another floor rule still keeps the call from the guard in every mode.
      await run(hook, { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } });
      expect(judge).toHaveBeenCalledTimes(sent ? 1 : 0);
    }
  });

  test('writes and fetches are judged; reads and searches are not', async () => {
    const judge = mock(async (_c: ShadowCall, _cfg: JevShadowConfig) => ALLOW);
    const hook = hookWith(judge);
    await run(hook, { tool_name: 'Write', tool_input: { file_path: 'a', content: 'x' } });
    await run(hook, { tool_name: 'WebFetch', tool_input: { url: 'https://x' } });
    await run(hook, { tool_name: 'Read', tool_input: { file_path: 'a' } });
    await run(hook, { tool_name: 'Grep', tool_input: { pattern: 'x' } });
    expect(judge.mock.calls.map(c => c[0].toolName)).toEqual(['Write', 'WebFetch']);
  });

  test("the session's own enforced denies reach the next call as recent_blocked_calls", async () => {
    const DENY: GuardVerdict = { decision: 'deny', reason: 'no', stage: 'judge', enforced: true };
    const verdicts = [DENY, ALLOW, ALLOW];
    const judge = mock(async (_c: ShadowCall, _cfg: JevShadowConfig) => verdicts.shift() ?? ALLOW);
    const hook = hookWith(judge);
    await run(hook, { tool_name: 'Bash', tool_input: { command: 'git push origin main' } });
    await run(hook, { tool_name: 'Bash', tool_input: { command: 'git push origin HEAD:main' } });
    await run(hook, {
      tool_name: 'Write',
      tool_input: { file_path: '/work/tree/a', content: 'x' },
    });
    expect(judge.mock.calls[0][0].recentBlockedCalls).toEqual([]);
    const blocked = [{ call: 'git push origin main', blocked_by: 'jev:archon-claude:judge' }];
    expect(judge.mock.calls[1][0].recentBlockedCalls).toEqual(blocked);
    // an allow is not a block; the earlier deny stays in the window
    expect(judge.mock.calls[2][0].recentBlockedCalls).toEqual(blocked);
    // another node session (another hook) does not see this one's refusals
    const other = mock(async (_c: ShadowCall, _cfg: JevShadowConfig) => ALLOW);
    await run(hookWith(other), { tool_name: 'Bash', tool_input: { command: 'ls > f' } });
    expect(other.mock.calls[0][0].recentBlockedCalls).toEqual([]);
  });

  test('the SDK hook timeout (45 s) sits above the guard backstop (40 s)', () => {
    expect(JEV_GUARD_HOOK_TIMEOUT_S).toBe(45);
  });
});
