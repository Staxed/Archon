import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import {
  Checker,
  DEFAULT_RULES,
  HARD_STOP,
  ROOT_OWNED_RULES_PATH,
  RULES_ENV,
  Rules,
  checkCommand,
  resetDestructiveGuardCache,
  resolveRulesPath,
  type DestructiveRulesFile,
} from './destructive-guard';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import {
  createPreToolUseDestructiveGuardHook,
  guardRewrittenInput,
} from '../claude/destructive-guard-hook';

/**
 * The shared test list lives with the Python guard (stixed). Both implementations
 * must pass every case; set ARCHON_DESTRUCTIVE_CASES / ARCHON_DESTRUCTIVE_RULES to
 * point elsewhere. Missing files skip the shared suite (upstream Archon has neither).
 */
const STIXED = '/mnt/volumes/projects/stixed/.claude/scripts';
const CASES_PATH = process.env.ARCHON_DESTRUCTIVE_CASES ?? `${STIXED}/destructive_cases.json`;
const SHARED_RULES_PATH =
  process.env.ARCHON_DESTRUCTIVE_RULES_TEST ?? `${STIXED}/destructive_rules.json`;
const haveShared = existsSync(CASES_PATH) && existsSync(SHARED_RULES_PATH);
const trackTempRoot = trackTempRoots();

/**
 * Shared cases this guard deliberately decides differently from the Python guard,
 * pending an update of the shared list: a recursive delete of a path the guard
 * cannot resolve is refused (security review 2026-10).
 */
const DIVERGES_FROM_SHARED = new Set(['while read f; do rm -rf "$f"; done < list.txt']);

interface Case {
  cmd: string;
  cwd?: string;
  rule?: string;
}
interface Cases {
  default_cwd: string;
  block: Case[];
  allow: Case[];
}

describe.skipIf(!haveShared)('shared cases (same list as the Python guard)', () => {
  const cases = haveShared ? (JSON.parse(readFileSync(CASES_PATH, 'utf8')) as Cases) : undefined;
  const rules = haveShared
    ? (JSON.parse(readFileSync(SHARED_RULES_PATH, 'utf8')) as DestructiveRulesFile)
    : undefined;
  // Pin home so the cases mean the same thing on any machine and inside the VM.
  const checker = haveShared && rules ? new Checker(new Rules(rules, '/home/staxed')) : undefined;

  it('blocks every block case with the expected rule', () => {
    const wrong: string[] = [];
    for (const c of cases?.block ?? []) {
      const v = checker?.check(c.cmd, c.cwd ?? cases?.default_cwd ?? '/');
      if (!v || v.rule !== c.rule)
        wrong.push(`${c.cmd} -> ${v ? v.rule : 'allowed'} (want ${c.rule})`);
    }
    expect(wrong).toEqual([]);
  });

  it('allows every allow case', () => {
    const wrong: string[] = [];
    for (const c of cases?.allow ?? []) {
      if (DIVERGES_FROM_SHARED.has(c.cmd)) continue;
      const v = checker?.check(c.cmd, c.cwd ?? cases?.default_cwd ?? '/');
      if (v) wrong.push(`${c.cmd} -> ${v.message()}`);
    }
    expect(wrong).toEqual([]);
  });
});

describe('Archon regressions (destructive-guard.regressions.json)', () => {
  const regressions = JSON.parse(
    readFileSync(new URL('./destructive-guard.regressions.json', import.meta.url), 'utf8')
  ) as Cases;
  // Stixed's rules when present; otherwise the built-in copy of them, so the cases
  // run on a machine without Stixed too.
  const rules: DestructiveRulesFile = existsSync(SHARED_RULES_PATH)
    ? (JSON.parse(readFileSync(SHARED_RULES_PATH, 'utf8')) as DestructiveRulesFile)
    : DEFAULT_RULES;
  const checker = new Checker(new Rules(rules, '/home/staxed'));

  it('blocks every block case with the expected rule', () => {
    const wrong: string[] = [];
    for (const c of regressions.block) {
      const v = checker.check(c.cmd, c.cwd ?? regressions.default_cwd);
      if (!v || v.rule !== c.rule)
        wrong.push(`${c.cmd} -> ${v ? v.rule : 'allowed'} (want ${c.rule})`);
    }
    expect(wrong).toEqual([]);
  });

  it('allows every allow case', () => {
    const wrong: string[] = [];
    for (const c of regressions.allow) {
      const v = checker.check(c.cmd, c.cwd ?? regressions.default_cwd);
      if (v) wrong.push(`${c.cmd} -> ${v.message()}`);
    }
    expect(wrong).toEqual([]);
  });

  it('asks for a literal path when it cannot resolve one', () => {
    const v = checker.check('rm -rf "$ROOT/stixed"', '/tmp/work');
    expect(v?.message()).toContain('Write the path out literally');
  });

  it('asks for a simpler command when it cannot parse a destructive one', () => {
    const v = checker.check('echo "oops && rm -rf ~', '/tmp/work');
    expect(v?.message()).toContain('Rewrite it more simply');
  });
});

describe('default rules (no rules file, or the root-owned copy missing)', () => {
  const checker = new Checker(new Rules(DEFAULT_RULES, '/home/u'));

  it('blocks system roots and home', () => {
    for (const cmd of ['rm -rf /', 'rm -rf ~', 'sudo rm -rf /etc', 'docker volume prune -f']) {
      expect(checker.check(cmd, '/work')).toBeDefined();
    }
  });

  it('is as strict as the shared rules: projects, the vault and Archon home', () => {
    for (const cmd of [
      'rm -rf /mnt/volumes/projects/Dashed',
      'rm -rf /mnt/volumes/projects/stixed/SecondBrain/Memory/knowledge/concepts',
      'rm -rf /home/staxed/.archon/worktrees',
      'rm -rf ~/.archon',
      'git -C /mnt/volumes/projects/Dashed clean -fdx',
    ]) {
      expect(checker.check(cmd, '/work')?.rule).toBeDefined();
    }
  });

  it('allows ordinary work', () => {
    for (const cmd of [
      'rm -rf node_modules dist',
      'git clean -fdx',
      'docker compose down',
      'grep -r "rm -rf /" .',
      'rm -rf /home/staxed/.archon/workspaces/Staxed/stixed/worktrees/archon/fix-x',
    ]) {
      expect(checker.check(cmd, '/work/repo')).toBeUndefined();
    }
  });

  it.skipIf(!existsSync(SHARED_RULES_PATH))("matches Stixed's rules file", () => {
    const shared = JSON.parse(readFileSync(SHARED_RULES_PATH, 'utf8')) as DestructiveRulesFile;
    expect(DEFAULT_RULES.protected_paths).toEqual(shared.protected_paths);
    expect(DEFAULT_RULES.project_parent).toEqual(shared.project_parent);
    expect(DEFAULT_RULES.protected_children_of).toEqual(shared.protected_children_of);
    expect(DEFAULT_RULES.vaults).toEqual(shared.vaults);
    expect(DEFAULT_RULES.rules).toEqual(shared.rules.map(r => ({ id: r.id, instead: r.instead })));
  });
});

describe('floor messages', () => {
  const checker = new Checker(new Rules(DEFAULT_RULES, '/home/staxed'));

  it('a floor block is a hard stop: ask the user, do not find another way', () => {
    const v = checker.check('docker volume rm pgdata', '/tmp');
    expect(v?.message()).toContain(HARD_STOP);
    expect(v?.message()).toContain('without -v is a different command and is fine');
  });

  it("the guard's own cannot-decide refusals still ask for a clearer command", () => {
    const v = checker.check('rm -rf "$ROOT/x"', '/tmp/work');
    expect(v?.rule).toBe('unresolved-path');
    expect(v?.message()).not.toContain(HARD_STOP);
  });
});

describe('Claude PreToolUse hook', () => {
  type HookOut = {
    hookSpecificOutput: { permissionDecision: string; permissionDecisionReason?: string };
  };
  const hook = createPreToolUseDestructiveGuardHook('/work/tree') as unknown as (
    i: Record<string, unknown>
  ) => Promise<HookOut>;

  it('denies a destructive Bash command', async () => {
    const out = await hook({ tool_name: 'Bash', tool_input: { command: 'rm -rf /etc' } });
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('destructive-command guard');
  });

  it('has no opinion on ordinary commands and other tools', async () => {
    const ok = await hook({ tool_name: 'Bash', tool_input: { command: 'rm -rf node_modules' } });
    expect(ok).toEqual({ continue: true } as unknown as HookOut);
    const read = await hook({ tool_name: 'Read', tool_input: { file_path: '/etc/hosts' } });
    expect(read).toEqual({ continue: true } as unknown as HookOut);
  });

  it('denies the heredoc-in-$(...) commit that once parsed as an open quote', async () => {
    const command = `git commit -m "$(cat <<'EOF'\nDon't break\nEOF\n)" && rm -rf ~`;
    const out = await hook({ tool_name: 'Bash', tool_input: { command } });
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('uses the cwd the SDK reports for the call', async () => {
    const out = await hook({ tool_name: 'Bash', tool_input: { command: 'rm -rf etc' }, cwd: '/' });
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
  });
});

describe('Claude node hooks that rewrite the call', () => {
  type Out = {
    hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
  };
  const guards = [{ matcher: 'Bash', hooks: [createPreToolUseDestructiveGuardHook('/work/tree')] }];
  const rewriteTo = (command: string): HookCallback =>
    (async () => ({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { command },
      },
    })) as HookCallback;
  const run = async (command: string): Promise<Out> => {
    const [wrapped] = guardRewrittenInput(
      [{ matcher: 'Bash', hooks: [rewriteTo(command)] }],
      guards
    );
    const hook = wrapped.hooks[0] as unknown as (
      i: Record<string, unknown>,
      id: string | undefined,
      o: { signal: AbortSignal }
    ) => Promise<Out>;
    return hook({ tool_name: 'Bash', tool_input: { command: 'ls' } }, undefined, {
      signal: new AbortController().signal,
    });
  };

  it('denies a rewrite into a destructive command', async () => {
    const out = await run('rm -rf /etc');
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('rewrote the call');
  });

  it("passes a harmless rewrite through as the node's own response", async () => {
    const out = await run('ls -la');
    expect(out.hookSpecificOutput?.permissionDecision).toBe('allow');
  });
});

describe('checkCommand rules resolution', () => {
  const saved = process.env[RULES_ENV];
  afterEach(() => {
    if (saved === undefined) delete process.env[RULES_ENV];
    else process.env[RULES_ENV] = saved;
    resetDestructiveGuardCache();
  });

  it('refuses every command when the configured rules file is unreadable', () => {
    process.env[RULES_ENV] = '/nonexistent/destructive-rules.json';
    resetDestructiveGuardCache();
    const v = checkCommand('ls', '/tmp');
    expect(v?.rule).toBe('rules-unreadable');
    expect(v?.message()).toContain('/nonexistent/destructive-rules.json');
  });

  it('takes the rules file from the caller, never from the environment, when given', () => {
    process.env[RULES_ENV] = '/nonexistent/destructive-rules.json';
    resetDestructiveGuardCache();
    expect(checkCommand('ls', '/tmp', { rulesPath: null })).toBeUndefined();
    expect(checkCommand('rm -rf /etc', '/tmp', { rulesPath: null })?.rule).toBe('recursive-delete');
  });

  it('reloads an edited rules file and retries one that failed to load', () => {
    const dir = trackTempRoot(mkdtempSync(join(tmpdir(), 'guard-rules-')));
    const path = join(dir, 'rules.json');
    writeFileSync(path, '{ not json');
    expect(checkCommand('ls', '/tmp', { rulesPath: path })?.rule).toBe('rules-unreadable');
    writeFileSync(path, JSON.stringify(DEFAULT_RULES));
    expect(checkCommand('ls', '/tmp', { rulesPath: path })).toBeUndefined();
    expect(checkCommand('rm -rf /srv/data', '/tmp', { rulesPath: path })).toBeUndefined();
    writeFileSync(path, JSON.stringify({ ...DEFAULT_RULES, protected_paths: ['/srv/data'] }));
    utimesSync(path, new Date(), new Date(Date.now() + 5000));
    expect(checkCommand('rm -rf /srv/data', '/tmp', { rulesPath: path })?.rule).toBe(
      'recursive-delete'
    );
  });

  it('prefers the configured file, then the root-owned copy, then the built-in rules', () => {
    const dir = trackTempRoot(mkdtempSync(join(tmpdir(), 'guard-rules-')));
    const rootOwned = join(dir, 'destructive_rules.json');
    writeFileSync(rootOwned, JSON.stringify(DEFAULT_RULES));
    expect(resolveRulesPath({ [RULES_ENV]: '/x/rules.json' }, rootOwned)).toBe('/x/rules.json');
    expect(resolveRulesPath({}, rootOwned)).toBe(rootOwned);
    // Missing (the Archon VM): no path, so the built-in strict rules apply.
    expect(resolveRulesPath({}, join(dir, 'missing.json'))).toBeUndefined();
    expect(
      checkCommand('rm -rf /mnt/volumes/projects/Dashed', '/tmp', { rulesPath: null })?.rule
    ).toBe('recursive-delete');
  });

  it('never reads the agent-writable <ARCHON_HOME>/destructive-rules.json', () => {
    expect(resolveRulesPath({ ARCHON_HOME: '/tmp/anything' }, '/nonexistent/rules.json')).toBe(
      undefined
    );
  });

  it.skipIf(!existsSync(ROOT_OWNED_RULES_PATH))(
    "reads Stixed's root-owned copy on this host",
    () => {
      delete process.env[RULES_ENV];
      resetDestructiveGuardCache();
      expect(resolveRulesPath()).toBe(ROOT_OWNED_RULES_PATH);
      expect(checkCommand('rm -rf /mnt/volumes/projects/Dashed', '/tmp')?.rule).toBe(
        'recursive-delete'
      );
      expect(checkCommand('rm -rf node_modules', '/mnt/volumes/projects/Dashed')).toBeUndefined();
    }
  );

  it.skipIf(!existsSync(SHARED_RULES_PATH))('uses the configured rules file', () => {
    process.env[RULES_ENV] = SHARED_RULES_PATH;
    resetDestructiveGuardCache();
    expect(checkCommand('rm -rf /mnt/volumes/projects/Dashed', '/tmp')?.rule).toBe(
      'recursive-delete'
    );
    expect(checkCommand('rm -rf node_modules', '/mnt/volumes/projects/Dashed')).toBeUndefined();
  });
});
