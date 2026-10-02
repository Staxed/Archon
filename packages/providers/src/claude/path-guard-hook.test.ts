import { describe, expect, test } from 'bun:test';
import { createPreToolUsePathGuardHook, type PreToolUseHookResult } from './path-guard-hook';

const CWD = '/home/user/.archon/workspaces/acme/repo/worktrees/task-1';
const ARTIFACTS = '/home/user/.archon/workspaces/acme/repo/artifacts/runs/r1';
const hookOptions = { signal: new AbortController().signal };

async function decide(
  toolName: string,
  toolInput: Record<string, unknown>,
  extraRoots: readonly string[] = [ARTIFACTS]
): Promise<'allow' | 'deny' | 'pass'> {
  const hook = createPreToolUsePathGuardHook(CWD, extraRoots);
  const result = (await hook(
    { tool_name: toolName, tool_input: toolInput } as never,
    undefined,
    hookOptions
  )) as Partial<PreToolUseHookResult>;
  return result.hookSpecificOutput?.permissionDecision ?? 'pass';
}

describe('createPreToolUsePathGuardHook', () => {
  test('passes writes inside cwd (relative and absolute)', async () => {
    expect(await decide('Write', { file_path: 'notes/out.md' })).toBe('pass');
    expect(await decide('Edit', { file_path: `${CWD}/src/a.ts` })).toBe('pass');
  });

  test('passes writes inside an extra writable root ($ARTIFACTS_DIR)', async () => {
    expect(await decide('Write', { file_path: `${ARTIFACTS}/plan.md` })).toBe('pass');
  });

  test('denies writes into the source repo the worktree came from', async () => {
    expect(await decide('Write', { file_path: '/home/user/src/repo/report.md' })).toBe('deny');
    expect(await decide('MultiEdit', { file_path: '/etc/hosts' })).toBe('deny');
  });

  test('denies relative traversal out of cwd', async () => {
    expect(await decide('Write', { file_path: '../../escape.md' })).toBe('deny');
  });

  test('denies a sibling directory sharing the cwd prefix', async () => {
    expect(await decide('Write', { file_path: `${CWD}-evil/x.md` })).toBe('deny');
  });

  test('guards NotebookEdit via notebook_path', async () => {
    expect(await decide('NotebookEdit', { notebook_path: '/tmp/x.ipynb' })).toBe('deny');
    expect(await decide('NotebookEdit', { notebook_path: 'nb/x.ipynb' })).toBe('pass');
  });

  test('ignores read-only and unguarded tools', async () => {
    expect(await decide('Read', { file_path: '/etc/passwd' })).toBe('pass');
    expect(await decide('Bash', { command: 'touch /tmp/x' })).toBe('pass');
  });

  test('passes a guarded call with no path field (SDK validates it)', async () => {
    expect(await decide('Write', { content: 'x' })).toBe('pass');
  });

  test('deny reason names the working directory', async () => {
    const hook = createPreToolUsePathGuardHook(CWD);
    const result = (await hook(
      { tool_name: 'Write', tool_input: { file_path: '/elsewhere/a.md' } } as never,
      undefined,
      hookOptions
    )) as PreToolUseHookResult;
    expect(result.hookSpecificOutput.permissionDecisionReason).toContain(CWD);
  });
});
