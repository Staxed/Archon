import { describe, test, expect, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dispatchHook,
  matcherMatches,
  parseApplyPatch,
  runDispatcher,
  toolView,
  type HookRunSpec,
} from './hook-dispatcher';
import { dispatcherCommand } from './cli-hooks';

const cwd = '/work/tree';
const codex = (over: Partial<HookRunSpec> = {}): HookRunSpec => ({
  version: 1,
  provider: 'codex',
  cwd,
  pathGuard: true,
  ...over,
});
const grok = (over: Partial<HookRunSpec> = {}): HookRunSpec => ({
  ...codex(over),
  provider: 'grok',
});

const patch = (lines: string[]): string =>
  ['*** Begin Patch', ...lines, '*** End Patch'].join('\n');

function decision(out: Record<string, unknown> | undefined): string | undefined {
  return (out?.hookSpecificOutput as { permissionDecision?: string } | undefined)
    ?.permissionDecision;
}

describe('parseApplyPatch', () => {
  test('classifies adds as Write and updates/deletes/moves as Edit', () => {
    expect(
      parseApplyPatch(
        patch([
          '*** Add File: /work/tree/new.txt',
          '+hi',
          '*** Update File: src/a.ts',
          '*** Move to: src/b.ts',
          '*** Delete File: old.txt',
        ])
      )
    ).toEqual([
      { op: 'Write', path: '/work/tree/new.txt' },
      { op: 'Edit', path: 'src/a.ts' },
      { op: 'Edit', path: 'src/b.ts' },
      { op: 'Edit', path: 'old.txt' },
    ]);
  });
});

describe('toolView', () => {
  test('codex apply_patch counts as Write/Edit with its paths (live payload shape)', () => {
    const v = toolView('codex', 'apply_patch', {
      command: patch(['*** Add File: /tmp/cprobe/probe.txt', '+hi']),
    });
    expect(v).toEqual({ names: ['Write'], writes: ['/tmp/cprobe/probe.txt'], mcp: false });
  });

  test('grok tool ids map back to Claude names; write tools expose file_path', () => {
    expect(toolView('grok', 'run_terminal_command', { command: 'ls' }).names).toEqual(['Bash']);
    expect(toolView('grok', 'write', { file_path: '/x/y', content: 'hi' })).toEqual({
      names: ['Write'],
      writes: ['/x/y'],
      mcp: false,
    });
    expect(toolView('grok', 'search_replace', { file_path: 'a.ts' }).writes).toEqual(['a.ts']);
    // seen live through use_tool; guarded like write
    expect(toolView('grok', 'write_file', { target_file: '/etc/x' })).toEqual({
      names: ['Write'],
      writes: ['/etc/x'],
      mcp: false,
    });
  });

  test('MCP calls are recognised on both CLIs', () => {
    expect(toolView('codex', 'mcp__github__get_issue', {}).mcp).toBe(true);
    expect(toolView('grok', 'linear__save_issue', {})).toEqual({
      names: ['mcp__linear__save_issue'],
      writes: [],
      mcp: true,
    });
    expect(toolView('grok', 'use_tool', {}).mcp).toBe(true);
  });
});

describe('matcherMatches', () => {
  test('empty, * and omitted match everything; otherwise an anchored regex', () => {
    expect(matcherMatches(undefined, ['Bash'])).toBe(true);
    expect(matcherMatches('*', ['Bash'])).toBe(true);
    expect(matcherMatches('Write|Edit', ['Edit'])).toBe(true);
    expect(matcherMatches('Edit', ['MultiEditX'])).toBe(false);
    expect(matcherMatches('mcp__.*', ['mcp__github__x'])).toBe(true);
    expect(matcherMatches('(', ['('])).toBe(true); // invalid regex: literal compare
  });
});

describe('dispatchHook: PreToolUse', () => {
  test('path guard denies a write outside the worktree, with the reason Claude gives', () => {
    const out = dispatchHook(codex(), 'PreToolUse', {
      tool_name: 'apply_patch',
      tool_input: { command: patch(['*** Update File: /etc/passwd']) },
    });
    expect(decision(out)).toBe('deny');
    expect(JSON.stringify(out)).toContain('outside the working directory');
  });

  test('path guard allows writes inside the worktree and ignores reads', () => {
    expect(
      dispatchHook(grok(), 'PreToolUse', {
        tool_name: 'write',
        tool_input: { file_path: '/work/tree/src/a.ts' },
      })
    ).toBeUndefined();
    expect(
      dispatchHook(grok(), 'PreToolUse', {
        tool_name: 'read_file',
        tool_input: { file_path: '/etc/passwd' },
      })
    ).toBeUndefined();
  });

  test('denied_tools blocks by Claude name, including MCP globs', () => {
    expect(
      decision(
        dispatchHook(codex({ deniedTools: ['Bash'] }), 'PreToolUse', {
          tool_name: 'Bash',
          tool_input: { command: 'ls' },
        })
      )
    ).toBe('deny');
    expect(
      decision(
        dispatchHook(codex({ deniedTools: ['mcp__github__*'] }), 'PreToolUse', {
          tool_name: 'mcp__github__delete_repo',
          tool_input: {},
        })
      )
    ).toBe('deny');
  });

  test('allowed_tools restricts built-ins but not MCP tools', () => {
    const spec = codex({ allowedTools: ['Read'] });
    expect(decision(dispatchHook(spec, 'PreToolUse', { tool_name: 'Bash', tool_input: {} }))).toBe(
      'deny'
    );
    expect(
      dispatchHook(spec, 'PreToolUse', { tool_name: 'mcp__parity__secret_word', tool_input: {} })
    ).toBeUndefined();
    // [] means no built-in tools at all
    expect(
      decision(
        dispatchHook(codex({ allowedTools: [] }), 'PreToolUse', {
          tool_name: 'apply_patch',
          tool_input: { command: patch(['*** Add File: /work/tree/a']) },
        })
      )
    ).toBe('deny');
  });

  test('an Add File patch is a Write: allowed when only Write is allowed', () => {
    const spec = codex({ allowedTools: ['Write'] });
    expect(
      dispatchHook(spec, 'PreToolUse', {
        tool_name: 'apply_patch',
        tool_input: { command: patch(['*** Add File: /work/tree/a']) },
      })
    ).toBeUndefined();
    expect(
      decision(
        dispatchHook(spec, 'PreToolUse', {
          tool_name: 'apply_patch',
          tool_input: { command: patch(['*** Update File: /work/tree/a']) },
        })
      )
    ).toBe('deny');
  });
});

describe('dispatchHook: node hooks', () => {
  test('returns the static response of a matching hook, by Claude tool name', () => {
    const response = {
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'lint it' },
    };
    const spec = grok({ hooks: { PostToolUse: [{ matcher: 'Write|Edit', response }] } });
    expect(
      dispatchHook(spec, 'PostToolUse', {
        tool_name: 'search_replace',
        tool_input: { file_path: 'a' },
      })
    ).toEqual(response);
    expect(
      dispatchHook(spec, 'PostToolUse', { tool_name: 'read_file', tool_input: {} })
    ).toBeUndefined();
  });

  test('a deny among several matching hooks wins', () => {
    const deny = {
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
    };
    const spec = codex({
      hooks: {
        PreToolUse: [{ response: { systemMessage: 'x' } }, { matcher: 'Bash', response: deny }],
      },
    });
    expect(dispatchHook(spec, 'PreToolUse', { tool_name: 'Bash', tool_input: {} })).toEqual(deny);
  });

  test('additionalContext from several hooks is merged', () => {
    const ctx = (t: string): Record<string, unknown> => ({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: t },
    });
    const spec = codex({
      hooks: { PostToolUse: [{ response: ctx('a') }, { response: ctx('b') }] },
    });
    const out = dispatchHook(spec, 'PostToolUse', { tool_name: 'Bash', tool_input: {} });
    expect((out?.hookSpecificOutput as { additionalContext?: string }).additionalContext).toBe(
      'a\n\nb'
    );
  });

  test('non-tool events match on their subject (SessionStart source)', () => {
    const spec = codex({
      hooks: { SessionStart: [{ matcher: 'startup', response: { systemMessage: 'hi' } }] },
    });
    expect(dispatchHook(spec, 'SessionStart', { source: 'startup' })).toEqual({
      systemMessage: 'hi',
    });
    expect(dispatchHook(spec, 'SessionStart', { source: 'resume' })).toBeUndefined();
  });
});

describe('runDispatcher', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hook-dispatcher-'));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('is a no-op without ARCHON_HOOK_SPEC', () => {
    expect(runDispatcher('PreToolUse', '{}', {})).toEqual({ stdout: '', exitCode: 0 });
  });

  test('fails closed for PreToolUse when the spec is unreadable, open otherwise', () => {
    const env = { ARCHON_HOOK_SPEC: join(dir, 'missing.json') };
    expect(runDispatcher('PreToolUse', '{"tool_name":"Bash"}', env).stdout).toContain('deny');
    expect(runDispatcher('Stop', '{}', env).stdout).toBe('');
  });

  test('the installed shell command runs the dispatcher only for listed events', () => {
    const specPath = join(dir, 'spec.json');
    writeFileSync(specPath, JSON.stringify(codex({ deniedTools: ['Bash'] })));
    const run = (events: string): string =>
      spawnSync('/bin/sh', ['-c', dispatcherCommand('PreToolUse')], {
        input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} }),
        env: { ...process.env, ARCHON_HOOK_SPEC: specPath, ARCHON_HOOK_EVENTS: events },
        encoding: 'utf8',
      }).stdout;
    expect(run('PreToolUse,PostToolUse')).toContain('"permissionDecision":"deny"');
    expect(run('PostToolUse')).toBe('');
    expect(run('')).toBe('');
  });
});
