import { describe, it, expect } from 'bun:test';
import {
  PATH_GUARDED_TOOLS,
  createPreToolUsePathGuardHook,
  type PreToolUseHookResult,
} from './path-guard-hook';

const cwd = '/workspace/project';
const hook = createPreToolUsePathGuardHook(cwd);

/**
 * Helper: invoke the hook with a synthetic SDK input and assert the result
 * shape. The hook signature accepts (input, toolUseID, options) but only
 * reads `input` — the other two are ignored, so we pass `undefined as never`.
 */
async function invoke(input: Record<string, unknown>): Promise<PreToolUseHookResult> {
  return (await (hook as unknown as (i: Record<string, unknown>) => Promise<PreToolUseHookResult>)(
    input
  )) as PreToolUseHookResult;
}

function expectAllow(result: PreToolUseHookResult): void {
  expect(result.hookSpecificOutput.hookEventName).toBe('PreToolUse');
  expect(result.hookSpecificOutput.permissionDecision).toBe('allow');
}

function expectDeny(result: PreToolUseHookResult, reasonContains: string[]): void {
  expect(result.hookSpecificOutput.hookEventName).toBe('PreToolUse');
  expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
  expect(result.hookSpecificOutput.permissionDecisionReason).toBeDefined();
  for (const fragment of reasonContains) {
    expect(result.hookSpecificOutput.permissionDecisionReason).toContain(fragment);
  }
}

describe('PATH_GUARDED_TOOLS', () => {
  it('contains exactly the four file-mutating tools', () => {
    expect([...PATH_GUARDED_TOOLS].sort()).toEqual(['Edit', 'MultiEdit', 'NotebookEdit', 'Write']);
  });
});

describe('createPreToolUsePathGuardHook — non-guarded tools', () => {
  it('allows Read regardless of file_path', async () => {
    const result = await invoke({
      tool_name: 'Read',
      tool_input: { file_path: '/etc/passwd' },
    });
    expectAllow(result);
  });

  it('allows Bash regardless of command', async () => {
    const result = await invoke({
      tool_name: 'Bash',
      tool_input: { command: 'echo foo > /tmp/anywhere' },
    });
    expectAllow(result);
  });

  it('allows tools with empty/missing tool_name', async () => {
    const result = await invoke({ tool_input: {} });
    expectAllow(result);
  });
});

describe('createPreToolUsePathGuardHook — Write inside cwd', () => {
  it('allows a relative path inside cwd', async () => {
    const result = await invoke({
      tool_name: 'Write',
      tool_input: { file_path: 'src/file.ts', content: 'x' },
    });
    expectAllow(result);
  });

  it('allows an absolute path that resolves inside cwd', async () => {
    const result = await invoke({
      tool_name: 'Write',
      tool_input: { file_path: '/workspace/project/src/file.ts', content: 'x' },
    });
    expectAllow(result);
  });

  it('allows the cwd itself', async () => {
    const result = await invoke({
      tool_name: 'Write',
      tool_input: { file_path: '.', content: '' },
    });
    expectAllow(result);
  });

  it('allows a deeply nested path inside cwd', async () => {
    const result = await invoke({
      tool_name: 'Write',
      tool_input: { file_path: 'a/b/c/d/e.txt', content: 'x' },
    });
    expectAllow(result);
  });
});

describe('createPreToolUsePathGuardHook — Write outside cwd (the regression)', () => {
  it('denies an absolute path to a sibling source repo', async () => {
    // Reproduces the krakenresearcher bug: model writes to source repo path
    // instead of the worktree path that is its actual cwd.
    const result = await invoke({
      tool_name: 'Write',
      tool_input: {
        file_path: '/mnt/volumes/projects/krakenresearcher/.archon/ralph/feature/prd.md',
        content: 'leaked',
      },
    });
    expectDeny(result, [
      'Write blocked',
      '/mnt/volumes/projects/krakenresearcher/.archon/ralph/feature/prd.md',
      cwd,
      'read-only',
    ]);
  });

  it('denies an absolute path to /etc/passwd', async () => {
    const result = await invoke({
      tool_name: 'Write',
      tool_input: { file_path: '/etc/passwd', content: 'pwned' },
    });
    expectDeny(result, ['/etc/passwd']);
  });

  it('denies a relative path that escapes via ..', async () => {
    const result = await invoke({
      tool_name: 'Write',
      tool_input: { file_path: '../other-project/file.ts', content: 'x' },
    });
    expectDeny(result, ['../other-project/file.ts']);
  });

  it('denies a sibling directory that shares a string prefix with cwd', async () => {
    // /workspace/project-evil starts with /workspace/project — this is the
    // exact bug the validatePath() relative()-based check exists to prevent.
    const result = await invoke({
      tool_name: 'Write',
      tool_input: { file_path: '/workspace/project-evil/file.ts', content: 'x' },
    });
    expectDeny(result, ['/workspace/project-evil/file.ts']);
  });
});

describe('createPreToolUsePathGuardHook — Edit / MultiEdit / NotebookEdit', () => {
  it('denies Edit outside cwd', async () => {
    const result = await invoke({
      tool_name: 'Edit',
      tool_input: { file_path: '/outside/file.ts', old_string: 'a', new_string: 'b' },
    });
    expectDeny(result, ['Edit blocked', '/outside/file.ts']);
  });

  it('denies MultiEdit outside cwd', async () => {
    const result = await invoke({
      tool_name: 'MultiEdit',
      tool_input: { file_path: '/outside/file.ts', edits: [] },
    });
    expectDeny(result, ['MultiEdit blocked']);
  });

  it('denies NotebookEdit outside cwd via notebook_path', async () => {
    const result = await invoke({
      tool_name: 'NotebookEdit',
      tool_input: { notebook_path: '/outside/notebook.ipynb', new_source: 'x' },
    });
    expectDeny(result, ['NotebookEdit blocked', '/outside/notebook.ipynb']);
  });

  it('allows NotebookEdit when notebook_path is inside cwd', async () => {
    const result = await invoke({
      tool_name: 'NotebookEdit',
      tool_input: { notebook_path: 'analysis/foo.ipynb', new_source: 'x' },
    });
    expectAllow(result);
  });
});

describe('createPreToolUsePathGuardHook — malformed input', () => {
  it('allows guarded tool when no path field is present (SDK will reject it)', async () => {
    // We do not want to mask malformed SDK input as a permission denial —
    // the SDK's own validation should surface the missing field.
    const result = await invoke({
      tool_name: 'Write',
      tool_input: { content: 'x' },
    });
    expectAllow(result);
  });

  it('allows guarded tool when tool_input is missing entirely', async () => {
    const result = await invoke({ tool_name: 'Write' });
    expectAllow(result);
  });

  it('treats non-string file_path as missing (no path to check)', async () => {
    const result = await invoke({
      tool_name: 'Write',
      tool_input: { file_path: 42, content: 'x' },
    });
    expectAllow(result);
  });
});

describe('createPreToolUsePathGuardHook — cwd binding', () => {
  it('uses the cwd captured at factory time, not at call time', async () => {
    const hookA = createPreToolUsePathGuardHook('/cwd/a');
    const hookB = createPreToolUsePathGuardHook('/cwd/b');

    // Same input — different decisions because each hook has its own cwd.
    const inputA = {
      tool_name: 'Write',
      tool_input: { file_path: '/cwd/a/file.ts', content: 'x' },
    };
    const inputB = {
      tool_name: 'Write',
      tool_input: { file_path: '/cwd/b/file.ts', content: 'x' },
    };

    const callA = hookA as unknown as (i: Record<string, unknown>) => Promise<PreToolUseHookResult>;
    const callB = hookB as unknown as (i: Record<string, unknown>) => Promise<PreToolUseHookResult>;

    expectAllow(await callA(inputA));
    expectDeny(await callA(inputB), ['/cwd/b/file.ts']);
    expectDeny(await callB(inputA), ['/cwd/a/file.ts']);
    expectAllow(await callB(inputB));
  });
});
