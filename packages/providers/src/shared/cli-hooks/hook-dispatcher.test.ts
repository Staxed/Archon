import { describe, test, expect, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dispatchHook,
  matcherMatches,
  parseApplyPatch,
  runDispatcher,
  decideHook,
  guardCallFor,
  toolView,
  type HookRunSpec,
} from './hook-dispatcher';
import type { GuardVerdict, JevShadowConfig, ShadowCall } from '../jev-shadow';
import { dispatcherCommand } from './install';
import { trackTempRoots } from '@archon/paths/test-utils';

const trackTempRoot = trackTempRoots();

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

describe('dispatchHook: destructive-command guard', () => {
  const pre = (tool_name: string, tool_input: unknown) => ({
    hook_event_name: 'PreToolUse',
    tool_name,
    tool_input,
  });

  test('denies a destructive Codex shell call, string or argv', () => {
    const out = dispatchHook(
      codex(),
      'PreToolUse',
      pre('Bash', { command: 'docker volume rm pgdata' })
    );
    expect(decision(out)).toBe('deny');
    expect(JSON.stringify(out)).toContain('destructive-command guard');
    const argv = dispatchHook(
      codex(),
      'PreToolUse',
      pre('exec_command', { command: ['bash', '-lc', 'rm -rf /etc'] })
    );
    expect(decision(argv)).toBe('deny');
  });

  test('denies a destructive Grok terminal call', () => {
    const out = dispatchHook(
      grok(),
      'PreToolUse',
      pre('run_terminal_command', { command: 'sudo rm -rf /' })
    );
    expect(decision(out)).toBe('deny');
  });

  test('allows ordinary shell calls', () => {
    for (const command of ['rm -rf node_modules', 'docker compose down', 'git status']) {
      expect(dispatchHook(codex(), 'PreToolUse', pre('Bash', { command }))).toBeUndefined();
    }
  });

  test('covers Grok run_terminal_cmd and Codex write_stdin keystrokes', () => {
    const g = dispatchHook(grok(), 'PreToolUse', pre('run_terminal_cmd', { command: 'rm -rf ~' }));
    expect(decision(g)).toBe('deny');
    const c = dispatchHook(
      codex(),
      'PreToolUse',
      pre('write_stdin', { session_id: 1, chars: 'rm -rf /etc\n' })
    );
    expect(decision(c)).toBe('deny');
  });

  test('uses the rules file pinned in the spec, not the CLI environment', () => {
    const dir = trackTempRoot(mkdtempSync(join(tmpdir(), 'dispatch-rules-')));
    const rulesPath = join(dir, 'rules.json');
    writeFileSync(
      rulesPath,
      JSON.stringify({
        protected_paths: ['/srv/data'],
        rules: [{ id: 'recursive-delete', instead: 'no' }],
      })
    );
    const out = dispatchHook(
      codex({ rulesPath }),
      'PreToolUse',
      pre('Bash', { command: 'rm -rf /srv/data' })
    );
    expect(decision(out)).toBe('deny');
    // null pins the built-in defaults: /srv/data is not protected there
    const dflt = dispatchHook(
      codex({ rulesPath: null }),
      'PreToolUse',
      pre('Bash', { command: 'rm -rf /srv/data' })
    );
    expect(dflt).toBeUndefined();
  });

  test('judges the command a node hook rewrote it to (updatedInput)', () => {
    const rewrite = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { command: 'rm -rf /etc' },
      },
    };
    const spec = codex({ hooks: { PreToolUse: [{ matcher: 'Bash', response: rewrite }] } });
    const out = dispatchHook(spec, 'PreToolUse', pre('Bash', { command: 'ls' }));
    expect(decision(out)).toBe('deny');
    expect(JSON.stringify(out)).toContain('rewrote the call');
    const harmless = codex({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            response: {
              hookSpecificOutput: {
                ...rewrite.hookSpecificOutput,
                updatedInput: { command: 'ls -la' },
              },
            },
          },
        ],
      },
    });
    expect(decision(dispatchHook(harmless, 'PreToolUse', pre('Bash', { command: 'ls' })))).toBe(
      'allow'
    );
  });

  test("resolves relative paths against the call's workdir", () => {
    const out = dispatchHook(
      codex(),
      'PreToolUse',
      pre('Bash', { command: 'rm -rf etc', workdir: '/' })
    );
    expect(decision(out)).toBe('deny');
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

  test('is a no-op without ARCHON_HOOK_SPEC', async () => {
    expect(await runDispatcher('PreToolUse', '{}', {})).toEqual({ stdout: '', exitCode: 0 });
  });

  test('fails closed for PreToolUse when the spec is unreadable, open otherwise', async () => {
    const env = { ARCHON_HOOK_SPEC: join(dir, 'missing.json') };
    expect((await runDispatcher('PreToolUse', '{"tool_name":"Bash"}', env)).stdout).toContain(
      'deny'
    );
    expect((await runDispatcher('Stop', '{}', env)).stdout).toBe('');
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

describe("Jev guard (awaited after Archon's own guards)", () => {
  const dir = mkdtempSync(join(tmpdir(), 'hook-dispatcher-jev-'));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const guard: JevShadowConfig = {
    python: existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3',
    scriptsDir: join(dir, 'scripts'),
    logDir: join(dir, 'log'),
    caller: 'archon',
  };
  const ctx = {
    runId: 'r1',
    nodeId: 'n1',
    workflow: 'w',
    userRequest: 'go',
    requestSource: 'user' as const,
    workflowSource: 'bundled' as const,
  };
  const ENV = { PATH: '/usr/bin', X: '1' };
  const ALLOW: GuardVerdict = { decision: 'allow', reason: 'ok', stage: 'prefilter' };

  function recording(verdict: GuardVerdict | ((c: ShadowCall) => GuardVerdict) = ALLOW) {
    const calls: ShadowCall[] = [];
    const judge = async (c: ShadowCall): Promise<GuardVerdict> => {
      calls.push(c);
      return typeof verdict === 'function' ? verdict(c) : verdict;
    };
    return { calls, judge };
  }

  function reasonOf(out: Record<string, unknown> | undefined): string | undefined {
    return (out?.hookSpecificOutput as { permissionDecisionReason?: string } | undefined)
      ?.permissionDecisionReason;
  }

  test('a Codex shell call is judged with the run context; an allow prints nothing', async () => {
    const spec = codex({ jevShadow: guard, guardContext: ctx });
    const { calls, judge } = recording();
    const out = await decideHook(
      spec,
      'PreToolUse',
      { tool_name: 'exec_command', tool_input: { cmd: 'rm -rf build', workdir: 'pkg' } },
      ENV,
      judge
    );
    expect(out).toBeUndefined();
    expect(calls[0]).toMatchObject({
      provider: 'codex',
      toolName: 'Bash',
      toolInput: { command: 'rm -rf build' },
      cwd: '/work/tree/pkg',
      projectRoot: '/work/tree',
      env: ENV,
      runId: 'r1',
      userRequest: 'go',
      requestSource: 'user',
      workflowSource: 'bundled',
      archonGuard: 'pass',
    });
  });

  test('must stop: an enforced deny is printed as the CLI deny (Codex and Grok)', async () => {
    const deny: GuardVerdict = {
      decision: 'deny',
      reason: 'jev-guard: denied (x)',
      stage: 'judge',
    };
    const cases: [HookRunSpec, string, Record<string, unknown>][] = [
      [codex({ jevShadow: guard }), 'exec_command', { cmd: 'npm publish' }],
      [grok({ jevShadow: guard }), 'run_terminal_command', { command: 'npm publish' }],
    ];
    for (const [spec, tool, input] of cases) {
      const { judge } = recording(deny);
      const out = await decideHook(
        spec,
        'PreToolUse',
        { tool_name: tool, tool_input: input },
        ENV,
        judge
      );
      expect(decision(out)).toBe('deny');
      expect(reasonOf(out)).toBe('jev-guard: denied (x)');
    }
  });

  test('must pass: a log-only would-deny lets the call run', async () => {
    const { judge } = recording({
      decision: 'allow',
      reason: 'would deny',
      stage: 'jev',
      mode: 'log-only',
      enforced: false,
    });
    const out = await decideHook(
      codex({ jevShadow: guard }),
      'PreToolUse',
      { tool_name: 'exec_command', tool_input: { cmd: 'docker compose down' } },
      ENV,
      judge
    );
    expect(out).toBeUndefined();
  });

  test('must stop: a judge that throws denies (fail closed)', async () => {
    const out = await decideHook(
      codex({ jevShadow: guard }),
      'PreToolUse',
      { tool_name: 'exec_command', tool_input: { cmd: 'ls' } },
      ENV,
      () => Promise.reject(new Error('boom'))
    );
    expect(decision(out)).toBe('deny');
    expect(reasonOf(out)).toContain('boom');
  });

  test("a call Archon's own guards refuse is not sent to the guard", async () => {
    const { calls, judge } = recording();
    const out = await decideHook(
      codex({ jevShadow: guard, pathGuard: false }),
      'PreToolUse',
      { tool_name: 'exec_command', tool_input: { cmd: 'rm -rf /' } },
      ENV,
      judge
    );
    expect(decision(out)).toBe('deny');
    expect(calls).toHaveLength(0);
  });

  test("a node hook's rewritten call is the one judged", async () => {
    const spec = codex({
      jevShadow: guard,
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            response: {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                updatedInput: { cmd: 'make clean' },
              },
            },
          },
        ],
      },
    });
    const { calls, judge } = recording(c =>
      c.toolInput.command === 'make clean'
        ? { decision: 'deny', reason: 'no', stage: 'judge' }
        : ALLOW
    );
    const out = await decideHook(
      spec,
      'PreToolUse',
      { tool_name: 'exec_command', tool_input: { cmd: 'ls' } },
      ENV,
      judge
    );
    expect(calls[0].toolInput).toEqual({ command: 'make clean' });
    expect(reasonOf(out)).toBe("no (after this node's hook rewrote the call)");
  });

  test('Grok writes are judged; reads, MCP, other events and a spec without a guard are not', async () => {
    const { calls, judge } = recording();
    const g = grok({ jevShadow: guard });
    const write = { tool_name: 'write', tool_input: { file_path: '/work/tree/a', content: 'x' } };
    await decideHook(g, 'PreToolUse', write, ENV, judge);
    await decideHook(
      g,
      'PreToolUse',
      { tool_name: 'read_file', tool_input: { target_file: 'a' } },
      ENV,
      judge
    );
    await decideHook(g, 'PreToolUse', { tool_name: 'use_tool', tool_input: {} }, ENV, judge);
    await decideHook(g, 'PostToolUse', write, ENV, judge);
    await decideHook(
      codex({ jevShadow: null }),
      'PreToolUse',
      { tool_name: 'exec_command', tool_input: { cmd: 'ls' } },
      ENV,
      judge
    );
    expect(calls.map(c => c.toolName)).toEqual(['Write']);
    expect(calls[0].toolInput).toEqual({ file_path: '/work/tree/a', content: 'x' });
    expect(guardCallFor(g, { tool_name: 'read_file', tool_input: {} }, ENV)).toBeUndefined();
  });

  /**
   * A stand-in for stixed's session_guard.py: appends each call's command to
   * calls.log and answers deny for `git push --force`, allow for everything else.
   */
  const FAKE = [
    'import json, os, sys',
    'HERE = os.path.dirname(os.path.abspath(__file__))',
    'req = json.loads(sys.stdin.read() or "{}")',
    'cmd = str((req.get("tool_input") or {}).get("command", ""))',
    'with open(os.path.join(HERE, "calls.log"), "a") as f:',
    '    f.write(json.dumps({"cmd": cmd, "profile": req.get("profile"), "cli": req.get("cli")}) + "\\n")',
    'deny = cmd.startswith("git push --force")',
    'print(json.dumps({"outcome": "deny" if deny else "allow", "stage": "judge" if deny else "prefilter",',
    '                  "reason": "force-push of the default branch" if deny else "nothing at stake",',
    '                  "mode": "enforce", "enforced": True}))',
    '',
  ].join('\n');

  function installed(command: string, specPath: string): string {
    return spawnSync('/bin/sh', ['-c', dispatcherCommand('PreToolUse')], {
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'exec_command',
        tool_input: { cmd: command },
      }),
      env: { ...process.env, ARCHON_HOOK_SPEC: specPath, ARCHON_HOOK_EVENTS: 'PreToolUse' },
      encoding: 'utf8',
    }).stdout;
  }

  test('must pass: Codex fires the hook once per command, and every safe command runs', () => {
    mkdirSync(guard.scriptsDir, { recursive: true });
    writeFileSync(join(guard.scriptsDir, 'session_guard.py'), FAKE);
    const specPath = join(dir, 'spec-per-command.json');
    writeFileSync(specPath, JSON.stringify(codex({ jevShadow: guard })));
    const commands = ['ls -la', 'git status', 'bun test src/a.test.ts', 'git push -u origin HEAD'];
    for (const c of commands) expect(installed(c, specPath)).toBe('');
    const logged = readFileSync(join(guard.scriptsDir, 'calls.log'), 'utf8')
      .trim()
      .split('\n')
      .map(l => JSON.parse(l) as { cmd: string; profile: string; cli: string });
    expect(logged.map(l => l.cmd)).toEqual(commands);
    expect(logged.every(l => l.profile === 'archon' && l.cli === 'codex')).toBe(true);
  });

  test('must stop: end to end, the installed hook prints the deny for a refused command', () => {
    mkdirSync(guard.scriptsDir, { recursive: true });
    writeFileSync(join(guard.scriptsDir, 'session_guard.py'), FAKE);
    const specPath = join(dir, 'spec-deny.json');
    writeFileSync(specPath, JSON.stringify(codex({ jevShadow: guard })));
    const out = JSON.parse(installed('git push --force origin feature', specPath)) as Record<
      string,
      unknown
    >;
    expect(decision(out)).toBe('deny');
    expect(JSON.stringify(out)).toContain('force-push of the default branch');
    expect(readdirSync(guard.logDir).some(f => f.endsWith('.jsonl'))).toBe(true);
  });

  test('must stop: end to end, a guard that crashes denies', () => {
    const crashDir = join(dir, 'crash-scripts');
    mkdirSync(crashDir, { recursive: true });
    writeFileSync(join(crashDir, 'session_guard.py'), 'raise SystemExit(3)\n');
    const specPath = join(dir, 'spec-crash.json');
    writeFileSync(
      specPath,
      JSON.stringify(codex({ jevShadow: { ...guard, scriptsDir: crashDir } }))
    );
    expect(decision(JSON.parse(installed('ls', specPath)) as Record<string, unknown>)).toBe('deny');
  });
});
