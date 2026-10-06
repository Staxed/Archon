import { afterEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
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
import { jevDecidesFor, type JevGuardMode, type JevShadowConfig } from './jev-shadow';
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

interface Case {
  cmd: string;
  cwd?: string;
  rule?: string;
  /**
   * What Archon answers when its rule differs from Stixed's (force-push: Archon reads the
   * looser force-push-default-branch): a rule id, or "allow".
   */
  archon?: string;
}
interface Cases {
  default_cwd: string;
  block: Case[];
  allow: Case[];
  /** Refused by the floor even when Jev decides (another rule fires). */
  jev_decides_block?: Case[];
  /** Allowed whether or not Jev decides. */
  jev_decides_allow?: Case[];
}

describe.skipIf(!haveShared)('shared cases (same list as the Python guard)', () => {
  const cases = haveShared ? (JSON.parse(readFileSync(CASES_PATH, 'utf8')) as Cases) : undefined;
  const rules = haveShared
    ? (JSON.parse(readFileSync(SHARED_RULES_PATH, 'utf8')) as DestructiveRulesFile)
    : undefined;
  // Pin home so the cases mean the same thing on any machine and inside the VM.
  const checker = haveShared && rules ? new Checker(new Rules(rules, '/home/staxed')) : undefined;
  const blockCases = (cases?.block ?? []).filter(c => (c.archon ?? c.rule) !== 'allow');
  const archonAllows = (cases?.block ?? []).filter(c => c.archon === 'allow');

  it('blocks every block case with the expected rule', () => {
    const wrong: string[] = [];
    for (const c of blockCases) {
      const want = c.archon ?? c.rule;
      const v = checker?.check(c.cmd, c.cwd ?? cases?.default_cwd ?? '/');
      if (!v || v.rule !== want) wrong.push(`${c.cmd} -> ${v ? v.rule : 'allowed'} (want ${want})`);
    }
    expect(wrong).toEqual([]);
  });

  it('allows every allow case, and the block cases Archon marks "allow"', () => {
    const wrong: string[] = [];
    for (const c of [...(cases?.allow ?? []), ...archonAllows]) {
      const v = checker?.check(c.cmd, c.cwd ?? cases?.default_cwd ?? '/');
      if (v) wrong.push(`${c.cmd} -> ${v.message()}`);
    }
    expect(wrong).toEqual([]);
  });

  // moves_to_jev: a node whose Jev decides (mode enforce, guard wired) leaves the flagged
  // rules to Jev; every other node (log-only, off, unknown mode, no guard) keeps them.
  const jevChecker =
    haveShared && rules
      ? new Checker(new Rules(rules, '/home/staxed'), undefined, true)
      : undefined;
  const moved = new Set(rules?.rules.filter(r => r.moves_to_jev === true).map(r => r.id) ?? []);
  const cwdOf = (c: Case): string => c.cwd ?? cases?.default_cwd ?? '/';

  it("reads moves_to_jev from Stixed's rules file", () => {
    expect([...moved]).toEqual(['docker-volume-delete']);
    expect(blockCases.some(c => moved.has(c.archon ?? c.rule ?? ''))).toBe(true);
    expect(cases?.jev_decides_block?.length).toBeGreaterThan(0);
    expect(cases?.jev_decides_allow?.length).toBeGreaterThan(0);
  });

  it('with Jev deciding: block cases of a moved rule pass the floor, the rest still block', () => {
    const wrong: string[] = [];
    for (const c of blockCases) {
      const want = c.archon ?? c.rule ?? '';
      const v = jevChecker?.check(c.cmd, cwdOf(c));
      if (moved.has(want)) {
        if (v) wrong.push(`${c.cmd} -> ${v.rule} (want pass: ${want} moves to Jev)`);
      } else if (!v || v.rule !== want) {
        wrong.push(`${c.cmd} -> ${v ? v.rule : 'allowed'} (want ${want})`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('with Jev deciding: every allow case still passes', () => {
    const wrong: string[] = [];
    for (const c of [...(cases?.allow ?? []), ...archonAllows]) {
      const v = jevChecker?.check(c.cmd, cwdOf(c));
      if (v) wrong.push(`${c.cmd} -> ${v.message()}`);
    }
    expect(wrong).toEqual([]);
  });

  it('jev_decides_block is refused whether or not Jev decides (by its rule when Jev does)', () => {
    const wrong: string[] = [];
    for (const c of cases?.jev_decides_block ?? []) {
      const v = jevChecker?.check(c.cmd, cwdOf(c));
      if (!v || v.rule !== c.rule)
        wrong.push(`jev: ${c.cmd} -> ${v ? v.rule : 'allowed'} (want ${c.rule})`);
      // Without Jev the first member's rule (the volume delete) fires first.
      if (!checker?.check(c.cmd, cwdOf(c))) wrong.push(`floor: ${c.cmd} -> allowed`);
    }
    expect(wrong).toEqual([]);
  });

  it('jev_decides_allow passes whether or not Jev decides', () => {
    const wrong: string[] = [];
    for (const c of cases?.jev_decides_allow ?? []) {
      for (const [label, ch] of [
        ['jev', jevChecker],
        ['floor', checker],
      ] as const) {
        const v = ch?.check(c.cmd, cwdOf(c));
        if (v) wrong.push(`${label}: ${c.cmd} -> ${v.rule}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('through checkCommand: only mode enforce with the guard wired skips a moved rule', () => {
    const config = { caller: 'archon' } as JevShadowConfig;
    const volumeCases = blockCases.filter(c => moved.has(c.archon ?? c.rule ?? ''));
    const outcomes: Record<string, string[]> = {};
    for (const [label, cfg, mode] of [
      ['enforce', config, 'enforce'],
      ['log-only', config, 'log-only'],
      ['off', config, 'off'],
      ['unknown', config, 'bogus'],
      ['no guard', null, 'enforce'],
    ] as const) {
      const jevDecides = jevDecidesFor(cfg, () => mode as JevGuardMode);
      outcomes[label] = volumeCases.map(
        c =>
          checkCommand(c.cmd, cwdOf(c), { rulesPath: SHARED_RULES_PATH, jevDecides })?.rule ??
          'pass'
      );
    }
    expect(new Set(outcomes.enforce)).toEqual(new Set(['pass']));
    for (const label of ['log-only', 'off', 'unknown', 'no guard']) {
      expect(new Set(outcomes[label])).toEqual(new Set(['docker-volume-delete']));
    }
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

  it('judges an unresolved path as the Python guard does: a protected name is a hard stop', () => {
    const v = checker.check('rm -rf "$ROOT/stixed"', '/tmp/work');
    expect(v?.rule).toBe('recursive-delete');
    expect(v?.message()).toContain(HARD_STOP);
    expect(checker.check('rm -rf "$ROOT/build"', '/tmp/work')).toBeUndefined();
  });

  it('allows a command it cannot parse and writes a log-only entry', () => {
    const entries: { command: string; reason: string }[] = [];
    const logging = new Checker(new Rules(rules, '/home/staxed'), e => entries.push(e));
    expect(logging.check('echo "oops && rm -rf ~', '/tmp/work')).toBeUndefined();
    expect(entries).toHaveLength(1);
    expect(entries[0].command).toBe('echo "oops && rm -rf ~');
    expect(entries[0].reason).toContain('unbalanced');
    expect(logging.check('rm -rf node_modules', '/tmp/work')).toBeUndefined();
    expect(entries).toHaveLength(1);
  });
});

describe('symlinks: a followed path is judged where it really leads', () => {
  // An Archon workspace's `source` is a link to the project: `rm -rf source/` (which
  // follows it) deletes the project's contents; `rm -rf source` removes only the link.
  const fixture = (): { tmp: string; source: string; checker: Checker } => {
    const tmp = trackTempRoot(mkdtempSync(join(tmpdir(), 'guard-links-')));
    const projects = join(tmp, 'projects');
    mkdirSync(join(projects, 'app', 'src'), { recursive: true });
    const ws = join(tmp, 'ws', 'o', 'app');
    mkdirSync(ws, { recursive: true });
    const source = join(ws, 'source');
    symlinkSync(join(projects, 'app'), source);
    const rules = new Rules({ ...DEFAULT_RULES, project_parent: projects }, '/home/staxed');
    return { tmp, source, checker: new Checker(rules) };
  };

  it('refuses a delete that follows the link into the project', () => {
    const { tmp, source, checker } = fixture();
    const wrong: string[] = [];
    for (const [cmd, cwd] of [
      [`rm -rf ${source}/`, tmp],
      [`rm -rf ${source}/*`, tmp],
      [`rm -rf ${source}/.`, tmp],
      [`find ${source}/ -delete`, tmp],
      [`find -L ${source} -delete`, tmp],
      ['rm -rf .git', source],
      ['rm -rf ./*', source],
      ['git clean -fdx', source],
      [`mv ${source}/ /tmp/elsewhere`, tmp],
    ]) {
      if (!checker.check(cmd, cwd)) wrong.push(`${cmd} (cwd ${cwd}) allowed`);
    }
    expect(wrong).toEqual([]);
  });

  it('allows removing the link itself and work inside the project', () => {
    const { tmp, source, checker } = fixture();
    const wrong: string[] = [];
    for (const [cmd, cwd] of [
      [`rm -rf ${source}`, tmp],
      [`rm ${source}`, tmp],
      [`find ${source} -delete`, tmp],
      [`rm -rf ${source}/src`, tmp],
      ['rm -rf node_modules dist', source],
    ]) {
      const v = checker.check(cmd, cwd);
      if (v) wrong.push(`${cmd} -> ${v.message()}`);
    }
    expect(wrong).toEqual([]);
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
    expect(DEFAULT_RULES.rules).toEqual(
      shared.rules.map(r => ({
        id: r.id,
        instead: r.instead,
        ...(r.moves_to_jev === true ? { moves_to_jev: true } : {}),
      }))
    );
    const { _comment: _c, ...forcePush } = (shared.force_push ?? {}) as Record<string, unknown>;
    expect(DEFAULT_RULES.force_push as unknown).toEqual(forcePush);
  });
});

describe('moves_to_jev: read from the rules file, else the built-in flag', () => {
  const ids = (data: DestructiveRulesFile): string[] => [
    ...new Rules(data, '/home/staxed').movesToJev,
  ];
  const withRule = (id: string, extra: Record<string, unknown>): DestructiveRulesFile => ({
    ...DEFAULT_RULES,
    rules: DEFAULT_RULES.rules.map(r => {
      const { moves_to_jev: _m, ...plain } = r;
      return r.id === id ? { ...plain, ...extra } : plain;
    }),
  });

  it('the built-in copy flags docker-volume-delete', () => {
    expect(ids(DEFAULT_RULES)).toEqual(['docker-volume-delete']);
  });

  it('a rules file without the key (an older promoted copy) keeps the built-in flag', () => {
    expect(ids(withRule('docker-volume-delete', {}))).toEqual(['docker-volume-delete']);
  });

  it("the file's own flag wins: false keeps the rule, true moves another rule", () => {
    expect(ids(withRule('docker-volume-delete', { moves_to_jev: false }))).toEqual([]);
    expect(ids(withRule('git-wipe', { moves_to_jev: true })).sort()).toEqual([
      'docker-volume-delete',
      'git-wipe',
    ]);
    const data = {
      ...withRule('git-wipe', { moves_to_jev: true }),
      rules: withRule('git-wipe', { moves_to_jev: true }).rules.map(r =>
        r.id === 'docker-volume-delete' ? { ...r, moves_to_jev: false } : r
      ),
    };
    const jev = new Checker(new Rules(data, '/home/staxed'), undefined, true);
    expect(jev.check('git clean -fdx', '/mnt/volumes/projects/stixed')).toBeUndefined();
    expect(jev.check('docker volume rm pgdata', '/tmp')?.rule).toBe('docker-volume-delete');
    const floor = new Checker(new Rules(data, '/home/staxed'));
    expect(floor.check('git clean -fdx', '/mnt/volumes/projects/stixed')?.rule).toBe('git-wipe');
  });

  it('a skipped rule does not hide a later member another rule refuses', () => {
    const jev = new Checker(new Rules(DEFAULT_RULES, '/home/staxed'), undefined, true);
    expect(jev.check('docker compose down -v; rm -rf /etc', '/tmp')?.rule).toBe('recursive-delete');
    expect(jev.check('docker system prune --volumes', '/tmp')).toBeUndefined();
    expect(jev.check('rm -rf /etc', '/tmp')?.rule).toBe('recursive-delete');
  });
});

describe('force-push: Archon refuses only the default branch or a ref it cannot name', () => {
  const checker = new Checker(new Rules(DEFAULT_RULES, '/home/staxed'));
  /** A repo whose HEAD is `branch`; `worktree` lays it out as a linked worktree (.git file). */
  const repo = (
    branch: string | null,
    opts: { remoteHead?: string; upstream?: string; worktree?: boolean } = {}
  ): string => {
    const tmp = trackTempRoot(mkdtempSync(join(tmpdir(), 'guard-push-')));
    const common = join(tmp, 'main', '.git');
    mkdirSync(join(common, 'refs', 'remotes', 'origin'), { recursive: true });
    let config = '[core]\n\tbare = false\n';
    if (opts.upstream && branch) {
      config += `[branch "${branch}"]\n\tremote = origin\n\tmerge = refs/heads/${opts.upstream}\n`;
    }
    writeFileSync(join(common, 'config'), config);
    if (opts.remoteHead) {
      writeFileSync(
        join(common, 'refs', 'remotes', 'origin', 'HEAD'),
        `ref: refs/remotes/origin/${opts.remoteHead}\n`
      );
    }
    const head = branch ? `ref: refs/heads/${branch}\n` : 'a'.repeat(40) + '\n';
    if (!opts.worktree) {
      writeFileSync(join(common, 'HEAD'), head);
      mkdirSync(join(tmp, 'main', 'src'));
      return join(tmp, 'main', 'src');
    }
    writeFileSync(join(common, 'HEAD'), 'ref: refs/heads/main\n');
    const wtGit = join(common, 'worktrees', 'run');
    mkdirSync(wtGit, { recursive: true });
    writeFileSync(join(wtGit, 'HEAD'), head);
    writeFileSync(join(wtGit, 'commondir'), '../..\n');
    const wt = join(tmp, 'wt', 'run');
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, '.git'), `gitdir: ${wtGit}\n`);
    return wt;
  };
  const rule = (cmd: string, cwd: string): string | undefined => checker.check(cmd, cwd)?.rule;

  it("passes a force-push of the run's own branch, as Archon's workflows do", () => {
    const wt = repo('archon/thread-1a2b3c', { worktree: true });
    for (const cmd of [
      'git push --force-with-lease', // archon-pr-review-scope's advice, run bare
      'git push -u origin HEAD --force-with-lease', // archon-implement-issue
      'git push --force-with-lease origin HEAD', // finalize-pr, sync-pr-with-main, resolve-merge-conflicts
      'git push --force-with-lease origin archon/thread-1a2b3c',
      'PR_HEAD=feat/x; git push --force-with-lease origin $PR_HEAD',
      'git push origin +HEAD:feat/x',
    ]) {
      expect([cmd, rule(cmd, wt)]).toEqual([cmd, undefined]);
    }
  });

  it('refuses the default branch, by name, by HEAD, by upstream and by the remote HEAD', () => {
    expect(rule('git push --force-with-lease', repo('main'))).toBe('force-push-default-branch');
    expect(rule('git push -f origin HEAD', repo('master', { worktree: true }))).toBe(
      'force-push-default-branch'
    );
    expect(rule('git push --force', repo('fix', { upstream: 'main' }))).toBe(
      'force-push-default-branch'
    );
    const dev = repo('feat', { remoteHead: 'develop' });
    expect(rule('git push -f origin develop', dev)).toBe('force-push-default-branch');
    expect(rule('git push -f origin feat', dev)).toBeUndefined();
    expect(rule('git push -f upstream develop', dev)).toBeUndefined(); // another remote's HEAD is unknown
  });

  it('a bare HEAD refspec is the current branch by its own name, never its upstream', () => {
    const tracksMain = repo('feat/x', { upstream: 'main', worktree: true });
    expect(rule('git push -u origin HEAD --force-with-lease', tracksMain)).toBeUndefined();
    expect(rule('git push --force origin @', tracksMain)).toBeUndefined();
    expect(rule('git push origin +HEAD', tracksMain)).toBeUndefined();
    expect(rule('git push --force-with-lease origin HEAD', repo('feat/y'))).toBeUndefined();
    // With no refspec, push.default may still send it to the upstream.
    expect(rule('git push --force', tracksMain)).toBe('force-push-default-branch');
    expect(rule('git push origin HEAD:main --force', tracksMain)).toBe('force-push-default-branch');
    expect(rule('git push --force origin HEAD', repo('main'))).toBe('force-push-default-branch');
    expect(rule('git push -f origin HEAD', repo(null))).toBe('force-push-default-branch');
  });

  it('refuses what it cannot name: detached HEAD, no repo, a variable, a wildcard, a tag', () => {
    const detached = repo(null);
    for (const [cmd, cwd] of [
      ['git push --force', detached],
      ['git push --force-with-lease origin HEAD', detached],
      ['git push --force', '/nonexistent/repo'],
      ['git push -f origin "$BRANCH"', repo('feat')],
      ['git push -f origin "refs/heads/*:refs/heads/*"', repo('feat')],
      ['git push -f origin v1:refs/tags/v1', repo('feat')],
      ['git --git-dir=/elsewhere/.git push --force', repo('feat')],
    ] as const) {
      expect([cmd, rule(cmd, cwd)]).toEqual([cmd, 'force-push-default-branch']);
    }
  });

  it('says why, and keeps the hard stop', () => {
    const v = checker.check('git push --force origin main', '/tmp');
    expect(v?.message()).toContain("force-updates main, the repo's default branch");
    expect(v?.message()).toContain(HARD_STOP);
    expect(checker.check('git push --dry-run --force origin main', '/tmp')).toBeUndefined();
  });

  it('an older rules file without force_push keeps the built-in definition', () => {
    const { force_push: _fp, ...older } = DEFAULT_RULES;
    const old = new Checker(
      new Rules(
        { ...older, rules: older.rules.filter(r => !r.id.startsWith('force-push')) },
        '/home/staxed'
      )
    );
    const v = old.check('git push -f origin main', '/tmp');
    expect(v?.rule).toBe('force-push-default-branch');
    expect(v?.instead).toContain('Force-pushing the default branch');
  });
});

describe('floor messages', () => {
  const checker = new Checker(new Rules(DEFAULT_RULES, '/home/staxed'));

  it('a floor block is a hard stop: ask the user, do not find another way', () => {
    const v = checker.check('docker volume rm pgdata', '/tmp');
    expect(v?.message()).toContain(HARD_STOP);
    expect(v?.message()).toContain('without -v is a different command and is fine');
  });

  it("the guard's own failures ask for a fix, not a hard stop", () => {
    const v = checkCommand('ls', '/tmp', { rulesPath: '/nonexistent/destructive-rules.json' });
    expect(v?.rule).toBe('rules-unreadable');
    expect(v?.message()).not.toContain(HARD_STOP);
  });

  it('a vault-delete is a hard stop that names Obsidian Sync', () => {
    const v = checker.check('rm SecondBrain/Memory/*.md', '/mnt/volumes/projects/stixed');
    expect(v?.rule).toBe('vault-delete');
    expect(v?.message()).toContain(HARD_STOP);
    expect(v?.message()).toContain('Obsidian Sync');
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

  it("leaves a volume delete to Jev only while the node's Jev decides", async () => {
    let decides = false;
    const jevHook = createPreToolUseDestructiveGuardHook(
      '/work/tree',
      () => decides
    ) as unknown as (i: Record<string, unknown>) => Promise<HookOut>;
    const volume = { tool_name: 'Bash', tool_input: { command: 'docker volume rm pgdata' } };
    expect((await jevHook(volume)).hookSpecificOutput.permissionDecision).toBe('deny');
    expect((await hook(volume)).hookSpecificOutput.permissionDecision).toBe('deny');
    decides = true;
    expect(await jevHook(volume)).toEqual({ continue: true } as unknown as HookOut);
    const etc = { tool_name: 'Bash', tool_input: { command: 'rm -rf /etc' } };
    expect((await jevHook(etc)).hookSpecificOutput.permissionDecision).toBe('deny');
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
