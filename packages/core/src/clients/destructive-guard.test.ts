import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import {
  Checker,
  DEFAULT_RULES,
  RULES_ENV,
  Rules,
  checkCommand,
  resetDestructiveGuardCache,
  type DestructiveRulesFile,
} from './destructive-guard';
import { createPreToolUseDestructiveGuardHook } from './destructive-guard-hook';

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
      const v = checker?.check(c.cmd, c.cwd ?? cases?.default_cwd ?? '/');
      if (v) wrong.push(`${c.cmd} -> ${v.message()}`);
    }
    expect(wrong).toEqual([]);
  });
});

describe('default rules (no rules file configured)', () => {
  const checker = new Checker(new Rules(DEFAULT_RULES, '/home/u'));

  it('blocks system roots and home', () => {
    for (const cmd of ['rm -rf /', 'rm -rf ~', 'sudo rm -rf /etc', 'docker volume prune -f']) {
      expect(checker.check(cmd, '/work')).toBeDefined();
    }
  });

  it('allows ordinary work', () => {
    for (const cmd of [
      'rm -rf node_modules dist',
      'git clean -fdx',
      'docker compose down',
      'grep -r "rm -rf /" .',
    ]) {
      expect(checker.check(cmd, '/work/repo')).toBeUndefined();
    }
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

  it('allows ordinary commands and other tools', async () => {
    const ok = await hook({ tool_name: 'Bash', tool_input: { command: 'rm -rf node_modules' } });
    expect(ok.hookSpecificOutput.permissionDecision).toBe('allow');
    const read = await hook({ tool_name: 'Read', tool_input: { file_path: '/etc/hosts' } });
    expect(read.hookSpecificOutput.permissionDecision).toBe('allow');
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

  it.skipIf(!existsSync(SHARED_RULES_PATH))('uses the configured rules file', () => {
    process.env[RULES_ENV] = SHARED_RULES_PATH;
    resetDestructiveGuardCache();
    expect(checkCommand('rm -rf /mnt/volumes/projects/Dashed', '/tmp')?.rule).toBe(
      'recursive-delete'
    );
    expect(checkCommand('rm -rf node_modules', '/mnt/volumes/projects/Dashed')).toBeUndefined();
  });
});
