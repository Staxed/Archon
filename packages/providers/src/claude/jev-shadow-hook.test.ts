import { describe, expect, mock, test } from 'bun:test';
import { createPreToolUseJevShadowHook } from './jev-shadow-hook';
import type { JevShadowConfig, ShadowCall } from '../shared/jev-shadow';

const CONFIG: JevShadowConfig = {
  python: 'python3',
  scriptsDir: '/s',
  logDir: '/l',
  caller: 'archon',
};

function hookWith(judge: (c: ShadowCall, cfg: JevShadowConfig) => Promise<void>) {
  return createPreToolUseJevShadowHook('/work/tree', CONFIG, {
    env: { PATH: '/usr/bin', GH_TOKEN: 't' },
    guardContext: { runId: 'r1', nodeId: 'n1', workflow: 'w', userRequest: 'tidy up' },
    judge,
  });
}

async function run(hook: ReturnType<typeof hookWith>, input: Record<string, unknown>) {
  return hook(input as never, undefined, { signal: new AbortController().signal });
}

describe('Claude Jev shadow hook', () => {
  test('a Bash call is sent to the judge with the floor verdict, and the hook has no opinion', async () => {
    const judge = mock(async (_c: ShadowCall, _cfg: JevShadowConfig) => {});
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
      archonGuard: 'pass',
      env: { PATH: '/usr/bin', GH_TOKEN: 't' },
    });
  });

  test('a call the floor refuses is still judged, and the hook still has no opinion', async () => {
    const judge = mock(async (_c: ShadowCall, _cfg: JevShadowConfig) => {});
    const out = await run(hookWith(judge), {
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /' },
    });
    expect(out).toEqual({ continue: true });
    const [c] = judge.mock.calls[0];
    expect(c.archonGuard).toMatch(/^deny: /);
  });

  test('writes and fetches are judged; reads and searches are not', async () => {
    const judge = mock(async (_c: ShadowCall, _cfg: JevShadowConfig) => {});
    const hook = hookWith(judge);
    await run(hook, { tool_name: 'Write', tool_input: { file_path: 'a', content: 'x' } });
    await run(hook, { tool_name: 'WebFetch', tool_input: { url: 'https://x' } });
    await run(hook, { tool_name: 'Read', tool_input: { file_path: 'a' } });
    await run(hook, { tool_name: 'Grep', tool_input: { pattern: 'x' } });
    expect(judge.mock.calls.map(c => c[0].toolName)).toEqual(['Write', 'WebFetch']);
  });

  test('a judge that throws changes nothing', async () => {
    const out = await run(
      hookWith(() => {
        throw new Error('boom');
      }),
      { tool_name: 'Bash', tool_input: { command: 'ls' } }
    );
    expect(out).toEqual({ continue: true });
  });

  test('the hook does not wait for the judgement', async () => {
    let finished = false;
    const slow = async (): Promise<void> => {
      await Bun.sleep(500);
      finished = true;
    };
    const t = performance.now();
    await run(hookWith(slow), { tool_name: 'Bash', tool_input: { command: 'ls' } });
    expect(performance.now() - t).toBeLessThan(200);
    expect(finished).toBe(false);
  });
});
