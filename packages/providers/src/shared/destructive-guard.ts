/**
 * Destructive-command guard for every provider's shell tool.
 *
 * Why this exists: an agent can, by mistake, run a shell command that destroys
 * something no git remote brings back -- a recursive delete or move of a project,
 * the folder that holds the projects, a system root; a disk wipe; `docker volume rm`;
 * `git clean -x` inside a project; a force-push of the repo's default branch. This
 * refuses those commands before they run, for
 * Claude (a PreToolUse hook, claude/destructive-guard-hook.ts), Codex and Grok
 * (shared/cli-hooks/hook-dispatcher.ts) and Copilot (its shell permission request).
 * Pi and OpenCode run their shell tools with no Archon hook point, so they are NOT
 * covered: their workflow nodes say so in a system message (GUARD_GAP_NOTICE).
 *
 * The rules are data. Resolution order:
 *   1. ARCHON_DESTRUCTIVE_RULES, a path to a rules JSON file (the deployment's own
 *      environment; a repo's `env:` cannot set ARCHON_* names);
 *   2. ROOT_OWNED_RULES_PATH, Stixed's root-owned promoted copy, if present (the host
 *      reads it directly; the container mounts it read-only at the same path);
 *   3. DEFAULT_RULES below: a built-in copy of the same strict rules, so a missing
 *      file never loosens the guard (the Archon VM has no root-owned copy).
 * A configured file that cannot be read or parsed makes every check refuse: a guard
 * that cannot decide must not wave a command through. The agent-writable
 * `<ARCHON_HOME>/destructive-rules.json` is no longer read.
 *
 * This is a TypeScript port of a Python guard that shares the same rules file and the
 * same test list (destructive_cases.json); both must pass every case. It is the
 * deterministic floor: catastrophic cases only, and a block is a HARD STOP whose
 * message tells the agent to ask the user, not to find another way. It reads command
 * TEXT, parsed the way a shell would, so quoted text (`grep "rm -rf /"`, commit
 * messages, quoted heredoc bodies) is never mistaken for a command, while `sudo`,
 * `bash -c`, `$(...)`, process substitution, `cd a && rm -rf b`, a script fed to a
 * shell on stdin (`bash -euo pipefail <<EOF`, `printf ... | sh`) and a script written
 * and run in the same command (`cat > x.sh <<EOF ... EOF; bash x.sh`) are seen
 * through, as are a script's and a shell function's arguments, `trap` strings, and a
 * command run in a container or sandbox (`docker exec`, `docker compose exec`,
 * `stixctl compose <project> exec`, `sbx exec`, `stixctl sbx exec`). Threat model:
 * mistakes, not a hostile agent. A script already on disk is not read.
 *
 * Force-push is the one place Archon's rule differs from Stixed's: Stixed refuses every
 * force-push (rule `force-push`, for the interactive CLIs); Archon, the unattended
 * orchestrator whose workflows rebase and force-push their own branches, reads
 * `force-push-default-branch` and refuses only a force-push of the default branch
 * (main, master, the remote's HEAD) or of a ref it cannot name. Both read the same
 * `force_push` definition of what a forced push is.
 *
 * A path the guard cannot resolve (a variable, `$(...)`, a `cd -` or `popd` with no
 * earlier folder in the command) is judged as the Python guard judges it: refused
 * only when its literal part names something protected wherever it sits, is a glob
 * directly in that folder, or climbs out with `..`; an all-variable target counts
 * where a protected name could be, unless a narrowed `find` feeds it. A command it
 * cannot parse is allowed (bash rejects it too) and written to the log as a log-only
 * entry; the guard throwing still refuses (`guard-error`).
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { createLogger } from '@archon/paths';

export const RULES_ENV = 'ARCHON_DESTRUCTIVE_RULES';
/** Stixed's promoted, root-owned copy of the shared rules (changes only through its promote step). */
export const ROOT_OWNED_RULES_PATH = '/usr/local/lib/stixed/.claude/scripts/destructive_rules.json';

/** The rules file's shape (only the fields the guard reads). */
export interface DestructiveRulesFile {
  protected_paths: string[];
  project_parent?: string | null;
  protected_children_of?: string[];
  /** Notes folders not in git: a find deleting their .md notes is refused. */
  vaults?: string[];
  rules: { id: string; instead: string }[];
  /** What a forced `git push` is (the shared definition); missing: DEFAULT_RULES'. */
  force_push?: ForcePushSpec;
}

/** The rules file's `force_push`: what makes `git push` a force-push, and the default branches. */
export interface ForcePushSpec {
  force_options: string[];
  force_short: string;
  dry_run_options: string[];
  dry_run_short: string;
  value_options: string[];
  value_short: string;
  refspec_force_prefix: string;
  every_branch_options: string[];
  default_branches: string[];
}

/**
 * Used when no rules file is configured or the root-owned one is missing: the same
 * strict rules as Stixed's destructive_rules.json (a test keeps them in step), so a
 * missing file never loosens the guard.
 */
export const DEFAULT_RULES: DestructiveRulesFile & { force_push: ForcePushSpec } = {
  protected_paths: [
    '/etc',
    '/usr',
    '/boot',
    '/var/lib/docker',
    '~',
    '/mnt/volumes/projects',
    '/mnt/volumes/projects/stixed/SecondBrain',
    '/mnt/volumes/projects/stixed/SecondBrain/Memory',
    '/app/SecondBrain',
    '/app/SecondBrain/Memory',
    '/mnt/volumes/projects/stixed/SecondBrain/Memory/knowledge/concepts',
    '/mnt/volumes/projects/stixed/SecondBrain/Memory/knowledge/connections',
    '/mnt/volumes/projects/stixed/SecondBrain/Memory/knowledge/qa',
    '/app/SecondBrain/Memory/knowledge/concepts',
    '/app/SecondBrain/Memory/knowledge/connections',
    '/app/SecondBrain/Memory/knowledge/qa',
    '~/.archon',
    '~/.archon/workspaces',
    '~/.archon/worktrees',
    '~/.archon/sessions',
    '/home/staxed/.archon',
    '/home/staxed/.archon/workspaces',
    '/home/staxed/.archon/worktrees',
    '/home/staxed/.archon/sessions',
    '/.archon',
    '/.archon/workspaces',
    '/.archon/worktrees',
    '/.archon/sessions',
  ],
  project_parent: '/mnt/volumes/projects',
  protected_children_of: [
    '/mnt/volumes/projects/stixed/SecondBrain/Memory',
    '/app/SecondBrain/Memory',
  ],
  vaults: ['/mnt/volumes/projects/stixed/SecondBrain', '/app/SecondBrain'],
  rules: [
    {
      id: 'recursive-delete',
      instead:
        "Removing a project, the vault, Archon's home or a system folder is the user's to do. If you meant only a narrower path inside a project (node_modules, dist, .venv), that is a different command and is fine.",
    },
    {
      id: 'vault-delete',
      instead:
        "The vault is not in git and Obsidian Sync spreads a delete to every machine, so emptying a vault folder is the user's to do. Deleting one named note is a different command and is fine.",
    },
    {
      id: 'move-protected',
      instead: "Moving or renaming a project, the vault or a system folder is the user's to do.",
    },
    { id: 'disk-wipe', instead: "Disk and partition work is the user's to do by hand." },
    {
      id: 'docker-volume-delete',
      instead:
        "Volumes hold databases, so deleting one is the user's to do. `docker compose down` without -v is a different command and is fine.",
    },
    {
      id: 'git-wipe',
      instead:
        "Wiping a project's ignored data is the user's to do. git clean -fd (without -x), or removing the one ignored folder you meant (rm -rf dist .venv), is a different command and is fine.",
    },
    {
      id: 'force-push',
      instead:
        "Force-pushing is the user's to do: they run it themselves in a terminal. A plain git push (or stixctl git-push <project>) that only adds commits is a different command and is fine.",
    },
    {
      id: 'force-push-default-branch',
      instead:
        "Force-pushing the default branch, or a ref the guard cannot name, is the user's to do. Force-pushing this run's own branch or a rebased feature branch, named explicitly (git push --force-with-lease origin <branch>), is a different command and is fine.",
    },
  ],
  force_push: {
    force_options: ['--force', '--force-with-lease', '--mirror'],
    force_short: 'f',
    dry_run_options: ['--dry-run'],
    dry_run_short: 'n',
    value_options: ['--repo', '--push-option', '--receive-pack', '--exec'],
    value_short: 'o',
    refspec_force_prefix: '+',
    every_branch_options: ['--all', '--branches', '--mirror', '--tags'],
    default_branches: ['main', 'master'],
  },
};

/** What a floor block tells the agent: stop and ask, never route around it. */
export const HARD_STOP =
  'HARD STOP: do not look for another way to do this (a different command, a script, another tool or another agent). Stop and ask the user.';

export class Violation {
  /**
   * `hard`: a rule from the rules file (the catastrophic floor), whose message is a
   * hard stop. The guard's own failures (rules-unreadable, guard-error) ask for a
   * fix or a clearer command.
   */
  constructor(
    readonly rule: string,
    readonly reason: string,
    readonly instead: string,
    readonly hard = false
  ) {}

  message(): string {
    if (this.hard) {
      return `Blocked by the destructive-command guard (${this.rule}): ${this.reason}. ${HARD_STOP} ${this.instead}`;
    }
    return `Blocked by the destructive-command guard (${this.rule}): ${this.reason}. Instead: ${this.instead}`;
  }
}

// ---------------------------------------------------------------- path helpers

/** posixpath.normpath for absolute paths ('/a/./b/../c/' -> '/a/c'). */
export function normPath(path: string): string {
  const parts: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return '/' + parts.join('/');
}

function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  if (i < 0) return '';
  if (i === 0) return '/';
  return path.slice(0, i);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function joinPath(a: string, b: string): string {
  if (b.startsWith('/')) return b;
  return a.endsWith('/') ? a + b : `${a}/${b}`;
}

/** fnmatch.fnmatchcase: * ? [seq] [!seq]. */
function fnmatch(name: string, pattern: string): boolean {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[') {
      const end = pattern.indexOf(']', i + 2);
      if (end < 0) {
        re += '\\[';
        continue;
      }
      let body = pattern.slice(i + 1, end);
      if (body.startsWith('!')) body = '^' + body.slice(1);
      re += `[${body.replace(/\\/g, '\\\\')}]`;
      i = end;
    } else re += c.replace(/[.+^${}()|\\/]/g, m => `\\${m}`);
  }
  return new RegExp(`^${re}$`, 's').test(name);
}

function globMatch(name: string, pattern: string): boolean {
  if (name.startsWith('.') && !pattern.startsWith('.')) return false;
  return fnmatch(name, pattern);
}

/** shlex.quote: a word the shell (and this guard) reads back as exactly `s`. */
export function shellQuote(s: string): string {
  if (/^[\w@%+=:,./-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\"'\"'") + "'";
}

// ---------------------------------------------------------------- rules

/** `~` and `~/...` in a rules path are the running user's home. */
function expandHome(path: string, home: string): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return home.replace(/\/+$/, '') + path.slice(1);
  return path;
}

function unique(paths: string[]): string[] {
  return [...new Set(paths)];
}

export class Rules {
  readonly home: string;
  readonly protectedPaths: string[];
  readonly projectParent: string | null;
  readonly childrenOf: string[];
  readonly vaults: string[];
  /**
   * Protected paths outside the projects folder and the home folder, plus those two
   * themselves: a find starting above one is refused whatever its filter.
   */
  readonly system: string[];
  /**
   * Names distinctive enough to be protected wherever the folder above them cannot
   * be resolved: every project, `.git`, the projects folder, the home folder, the
   * vault (SecondBrain, Memory) and dot-folders such as .archon. Generic names
   * (concepts, sessions, worktrees) are not: `rm -rf "$OUT/sessions"` is ordinary work.
   */
  readonly names: Set<string>;
  /**
   * Folder name -> the protected names directly inside a folder of that name ('*':
   * any). Judges a glob under a literal parent whose own folder is unresolved:
   * `"$X"/projects/*` may be projects, `"$X"/dist/*` may not.
   */
  readonly childNames: Map<string, Set<string>>;
  /** What a forced `git push` is (the rules file's force_push, else the built-in copy). */
  readonly forcePush: ForcePushSpec;
  private readonly instead: Map<string, string>;

  constructor(data: DestructiveRulesFile, home: string = homedir()) {
    this.home = home;
    const resolve = (p: string): string => normPath(expandHome(p, home));
    this.protectedPaths = unique(data.protected_paths.map(resolve));
    this.projectParent = data.project_parent ? normPath(data.project_parent) : null;
    this.childrenOf = unique((data.protected_children_of ?? []).map(resolve));
    this.vaults = unique((data.vaults ?? []).map(resolve));
    const pp = this.projectParent;
    const homePrefix = normPath(home).replace(/\/+$/, '') + '/';
    this.system = this.protectedPaths.filter(
      p => (!pp || !p.startsWith(pp + '/')) && !p.startsWith(homePrefix)
    );
    // A rules file older than a rule (Stixed's promoted copy before its next promote)
    // keeps the built-in message and definition for it, never a looser one.
    this.instead = new Map([...DEFAULT_RULES.rules, ...data.rules].map(r => [r.id, r.instead]));
    this.forcePush = data.force_push ?? DEFAULT_RULES.force_push;
    this.names = this.protectedNames();
    this.childNames = this.buildChildNames();
  }

  private list(directory: string | null): string[] {
    if (!directory) return [];
    try {
      return readdirSync(directory);
    } catch {
      return [];
    }
  }

  private protectedNames(): Set<string> {
    const names = new Set<string>(['.git']);
    const dotted = this.protectedPaths.filter(p => basename(p).startsWith('.'));
    const from = [
      ...(this.projectParent ? [this.projectParent] : []),
      normPath(this.home),
      ...this.vaults,
      ...this.childrenOf,
      ...dotted,
    ];
    for (const p of from) if (p.replace(/\//g, '')) names.add(basename(p));
    for (const n of this.list(this.projectParent)) names.add(n);
    names.delete('');
    return names;
  }

  private buildChildNames(): Map<string, Set<string>> {
    const m = new Map<string, Set<string>>();
    const add = (k: string, v: string): void => {
      if (!m.has(k)) m.set(k, new Set());
      m.get(k)?.add(v);
    };
    for (const p of this.protectedPaths) {
      const parent = dirname(p);
      if (parent !== p && basename(parent)) add(basename(parent), basename(p));
    }
    for (const d of [...(this.projectParent ? [this.projectParent] : []), ...this.childrenOf]) {
      if (basename(d)) add(basename(d), '*');
    }
    for (const n of this.list(this.projectParent)) add(n, '.git');
    return m;
  }

  /**
   * Every protected path at or under `p`: listed paths, the projects (and their
   * .git) under it, and the children of a protected_children_of folder under it.
   */
  protectedUnder(p: string): string[] {
    const pre = p.replace(/\/+$/, '') + '/';
    const out = new Set(this.protectedPaths.filter(q => q === p || q.startsWith(pre)));
    for (const d of [...(this.projectParent ? [this.projectParent] : []), ...this.childrenOf]) {
      if (d === p || d.startsWith(pre)) for (const n of this.list(d)) out.add(joinPath(d, n));
      else if (dirname(p) === d) out.add(p);
    }
    const pp = this.projectParent;
    if (pp && (pp === p || pp.startsWith(pre))) {
      for (const n of this.list(pp)) out.add(`${pp}/${n}/.git`);
    } else if (pp && dirname(p) === pp) out.add(joinPath(p, '.git'));
    return [...out].sort();
  }

  inVault(path: string): boolean {
    return this.vaults.some(v => path === v || path.startsWith(v + '/'));
  }

  /** A protected path itself, a project root, a child of a protected_children_of folder, or a project's .git. */
  isProtected(path: string): boolean {
    if (this.protectedPaths.includes(path)) return true;
    const parent = dirname(path);
    if ((this.projectParent && parent === this.projectParent) || this.childrenOf.includes(parent))
      return true;
    return (
      this.projectParent !== null &&
      basename(path) === '.git' &&
      dirname(parent) === this.projectParent
    );
  }

  isStrictAncestor(path: string): boolean {
    const prefix = path.replace(/\/+$/, '') + '/';
    return this.protectedPaths.some(p => p.startsWith(prefix));
  }

  aboveSystem(path: string): boolean {
    const prefix = path.replace(/\/+$/, '') + '/';
    return this.system.some(p => p.startsWith(prefix));
  }

  hits(path: string): boolean {
    return this.isProtected(path) || this.isStrictAncestor(path);
  }

  inProject(path: string): boolean {
    return this.projectParent !== null && path.startsWith(this.projectParent + '/');
  }

  protectedChildren(directory: string): string[] {
    const names = new Set<string>();
    const prefix = directory.replace(/\/+$/, '') + '/';
    for (const p of this.protectedPaths) {
      if (p.startsWith(prefix)) names.add(p.slice(prefix.length).split('/')[0]);
    }
    if (directory === this.projectParent || this.childrenOf.includes(directory)) {
      try {
        for (const n of readdirSync(directory)) names.add(n);
      } catch {
        names.add('*'); // cannot list: any name may be protected
      }
    }
    if (this.projectParent && dirname(directory) === this.projectParent) names.add('.git');
    return [...names].sort();
  }

  violation(rule: string, reason: string): Violation {
    return new Violation(rule, reason, this.instead.get(rule) ?? 'ask the user', true);
  }
}

// ---------------------------------------------------------------- lexer

/**
 * Where an unresolved variable's value comes from, so a delete of it can be judged
 * like `find ... | xargs rm -r`: the pipeline in front of `while read` (`cmds`), or
 * the text of the `<(...)` after `done <`, of `for x in $(...)`, of `mapfile <
 * <(...)` or of a `$(...)` word itself (`text`). Neither: unknown.
 */
interface Feed {
  cmds?: Command[];
  text?: string;
}

interface Word {
  text: string;
  /** Contains an unquoted * ? [ */
  glob: boolean;
  /** An expansion in it could not be resolved. */
  unknown?: boolean;
  /** [text, glob] per loop value, when a loop variable is in it. */
  alts?: [string, boolean][];
  /** The literal text after the last unresolved expansion. */
  tail?: string;
  /** What produced the word's one unresolved expansion. */
  feed?: Feed;
}

/** A snapshot of the lexer's variables, for what runs in the same shell (a function, trap, eval, source, $(...)). */
interface Vars {
  values: Record<string, string>;
  unknown: Set<string>;
  loops: Map<string, [string, boolean][]>;
  feeds: Map<string, Feed>;
}

interface Command {
  words: Word[];
  /** [op, target, fd]: fd is '' (default), a number, or '&' (stdout and stderr). */
  redirects: [string, string, string][];
  heredocs: string[];
  /** The operator that preceded this command. */
  sep: string;
  /** $(...), backtick and <(...) bodies, and those run inside an unquoted heredoc. */
  subs: string[];
  /** The <(...) body this command reads on stdin (`done < <(find ...)`). */
  stdinSub?: string;
  /** A command of a function body: it runs only when the function is called. */
  func?: string;
  /** The shell variables after this command. */
  vars?: Vars;
}

class ParseError extends Error {}

const OPS = ['&&', '||', '|&', ';;', ';', '|', '&', '(', ')', '\n'];
const VAR = /[A-Za-z_][A-Za-z0-9_]*/y;
const REDIRECT = /(\d*|&)(>>|>\||>&|<<<|<<-|<<|<&|<>|>|<)/y;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;
/** Loop variables are marked with a private-use character while a word is read. */
const LOOP_REF = /\uE000([A-Za-z_][A-Za-z0-9_]*)\uE000/;
/** Reserved words that introduce a command without being one: `do rm -rf x` runs rm. */
const KEYWORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{']);
const DECLARE = new Set(['export', 'local', 'declare', 'readonly', 'typeset']);
const FUNC_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;
/** A word that is exactly "$@". */
const ARGV_ALL = /"\$@"|"\$\{@\}"|\$@|\$\{@\}/y;
const MAPFILE_ARG = new Set(['-d', '-n', '-O', '-s', '-u', '-C', '-c']);
const MAX_ALTS = 64;

/** Index just past the closing quote of the '...' starting at `i`. */
function skipSingle(s: string, i: number): number {
  const end = s.indexOf("'", i + 1);
  if (end < 0) throw new ParseError("unbalanced '");
  return end + 1;
}

/** Index just past the closing backtick of the `...` starting at `i`. */
function skipBacktick(s: string, i: number): number {
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') j++;
    else if (s[j] === '`') return j + 1;
  }
  throw new ParseError('unbalanced `');
}

/** Index just past the closing quote of the "..." starting at `i`; `$(...)` inside is followed. */
function skipDouble(s: string, i: number): number {
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') j++;
    else if (c === '"') return j + 1;
    else if (c === '`') j = skipBacktick(s, j) - 1;
    else if (c === '$' && s[j + 1] === '(') j = scanSubstitution(s, j + 2);
  }
  throw new ParseError('unbalanced "');
}

/**
 * Index of the `)` closing a `$(` whose body starts at `start`. Read the way a
 * shell reads it: quotes, escapes, comments, nested `$(...)` and heredoc bodies
 * (which are text, so an apostrophe in one is not an open quote).
 */
function scanSubstitution(s: string, start: number): number {
  let depth = 0;
  const heredocs: [string, boolean][] = [];
  let j = start;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\') j += 2;
    else if (c === "'") j = skipSingle(s, j);
    else if (c === '"') j = skipDouble(s, j);
    else if (c === '`') j = skipBacktick(s, j);
    else if (c === '$' && s[j + 1] === "'") j = skipAnsiC(s, j + 1)[1];
    else if (c === '#' && (j === start || /[\s;&|(]/.test(s[j - 1]))) {
      while (j < s.length && s[j] !== '\n') j++;
    } else if (c === '<' && s.startsWith('<<', j) && s[j + 2] !== '<') {
      j += 2;
      const strip = s[j] === '-';
      if (strip) j++;
      while (s[j] === ' ' || s[j] === '\t') j++;
      let delim = '';
      while (j < s.length && !' \t\n;&|()<>'.includes(s[j])) {
        if (s[j] === "'" || s[j] === '"') {
          const end = s.indexOf(s[j], j + 1);
          if (end < 0) throw new ParseError('unbalanced heredoc delimiter');
          delim += s.slice(j + 1, end);
          j = end + 1;
        } else if (s[j] === '\\') {
          delim += s[j + 1] ?? '';
          j += 2;
        } else delim += s[j++];
      }
      heredocs.push([delim, strip]);
    } else if (c === '\n' && heredocs.length > 0) {
      j++;
      for (const [delim, strip] of heredocs.splice(0)) {
        for (;;) {
          if (j >= s.length) throw new ParseError('unterminated heredoc');
          let end = s.indexOf('\n', j);
          if (end < 0) end = s.length;
          const line = s.slice(j, end);
          j = end + 1;
          if ((strip ? line.replace(/^\t+/, '') : line) === delim) break;
        }
      }
    } else if (c === '(') {
      depth++;
      j++;
    } else if (c === ')') {
      if (depth === 0) return j;
      depth--;
      j++;
    } else j++;
  }
  throw new ParseError('unbalanced $(');
}

/** Index of the `}` closing a `${` whose body starts at `start` (nesting and quotes followed). */
function scanBrace(s: string, start: number): number {
  let depth = 0;
  let j = start;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\') j += 2;
    else if (c === "'") j = skipSingle(s, j);
    else if (c === '"') j = skipDouble(s, j);
    else if (c === '`') j = skipBacktick(s, j);
    else if (c === '$' && s[j + 1] === '(') j = scanSubstitution(s, j + 2) + 1;
    else if (c === '$' && s[j + 1] === '{') {
      depth++;
      j += 2;
    } else if (c === '}') {
      if (depth === 0) return j;
      depth--;
      j++;
    } else j++;
  }
  throw new ParseError('unbalanced ${');
}

/** Read a $'...' word starting at the quote `i`: [decoded text, index past the closing quote]. */
function skipAnsiC(s: string, i: number): [string, number] {
  const out: string[] = [];
  const simple: Record<string, string> = {
    n: '\n',
    t: '\t',
    r: '\r',
    a: '\x07',
    b: '\b',
    e: '\x1b',
    E: '\x1b',
    f: '\f',
    v: '\v',
  };
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (c === "'") return [out.join(''), j + 1];
    if (c !== '\\') {
      out.push(c);
      continue;
    }
    const n = s[j + 1] ?? '';
    let m: RegExpExecArray | null;
    if (n in simple) {
      out.push(simple[n]);
      j++;
    } else if ((m = /^x([0-9a-fA-F]{1,2})/.exec(s.slice(j + 1)))) {
      out.push(String.fromCharCode(parseInt(m[1], 16)));
      j += m[0].length;
    } else if ((m = /^[0-7]{1,3}/.exec(s.slice(j + 1)))) {
      out.push(String.fromCharCode(parseInt(m[0], 8)));
      j += m[0].length;
    } else {
      out.push(n);
      j++;
    }
  }
  throw new ParseError("unbalanced $'");
}

function newCommand(sep = ''): Command {
  return { words: [], redirects: [], heredocs: [], sep, subs: [] };
}

/** The $(...) and `...` bodies an UNQUOTED heredoc runs while it is expanded. */
function bodySubstitutions(body: string): string[] {
  const subs: string[] = [];
  let j = 0;
  try {
    while (j < body.length) {
      const c = body[j];
      if (c === '\\') j += 2;
      else if (body.startsWith('$(', j) && !body.startsWith('$((', j)) {
        const end = scanSubstitution(body, j + 2);
        subs.push(body.slice(j + 2, end));
        j = end + 1;
      } else if (c === '`') {
        const end = skipBacktick(body, j);
        subs.push(body.slice(j + 1, end - 1));
        j = end;
      } else j++;
    }
  } catch (err) {
    // The shell rejects this expansion too; what was found is still checked.
    if (!(err instanceof ParseError)) throw err;
  }
  return subs;
}

/** Decode the backslash escape at s[j] (\n, \x2f, \057 ...): [text, next index]. */
function decodeEscape(s: string, j: number): [string, number] {
  const simple: Record<string, string> = {
    n: '\n',
    t: '\t',
    r: '\r',
    a: '\x07',
    b: '\b',
    e: '\x1b',
    E: '\x1b',
    f: '\f',
    v: '\v',
    '\\': '\\',
    "'": "'",
    '"': '"',
  };
  const n = s[j + 1] ?? '';
  if (n in simple) return [simple[n], j + 2];
  let m: RegExpExecArray | null;
  if ((m = /^x([0-9a-fA-F]{1,2})/.exec(s.slice(j + 1)))) {
    return [String.fromCharCode(parseInt(m[1], 16)), j + 1 + m[0].length];
  }
  if ((m = /^0?([0-7]{1,3})/.exec(s.slice(j + 1)))) {
    return [String.fromCharCode(parseInt(m[1], 8) & 0xff), j + 1 + m[0].length];
  }
  return [n, j + 2];
}

function unescapeText(text: string): string {
  const out: string[] = [];
  let j = 0;
  while (j < text.length) {
    if (text[j] === '\\' && j + 1 < text.length) {
      const [piece, next] = decodeEscape(text, j);
      out.push(piece);
      j = next;
    } else out.push(text[j++]);
  }
  return out.join('');
}

/** What `echo` prints (escapes read, as sh's echo does: the safe side for a check). */
function echoText(args: string[]): string {
  let newline = true;
  let escapes = true;
  while (args.length > 0 && /^-[neE]+$/.test(args[0])) {
    if (args[0].includes('n')) newline = false;
    escapes = !args[0].includes('E');
    args = args.slice(1);
  }
  const text = args.join(' ');
  return (escapes ? unescapeText(text) : text) + (newline ? '\n' : '');
}

/** What `printf` prints: the format filled from the arguments, repeated while they last. */
function printfText(args: string[]): string {
  if (args[0] === '--') args = args.slice(1);
  if (args.length === 0 || args[0] === '-v') return '';
  const fmt = args[0];
  let rest = args.slice(1);
  const out: string[] = [];
  for (;;) {
    let used = 0;
    let j = 0;
    while (j < fmt.length) {
      const c = fmt[j];
      if (c === '\\' && j + 1 < fmt.length) {
        const [piece, next] = decodeEscape(fmt, j);
        out.push(piece);
        j = next;
      } else if (c === '%' && j + 1 < fmt.length) {
        const m = /^%[-+ #0]*\d*(?:\.\d*)?([a-zA-Z%])/.exec(fmt.slice(j));
        if (!m) {
          out.push(c);
          j++;
          continue;
        }
        j += m[0].length;
        if (m[1] === '%') {
          out.push('%');
          continue;
        }
        const arg = used < rest.length ? rest[used] : '';
        used++;
        out.push(m[1] === 'b' ? unescapeText(arg) : arg);
      } else out.push(fmt[j++]);
    }
    rest = rest.slice(used);
    if (rest.length === 0 || used === 0) break;
  }
  return out.join('');
}

/**
 * A small POSIX-shell reader. It never executes anything.
 *
 * Variables are followed in order: `NAME=value` (alone or after export/local/...)
 * sets NAME for the commands after it, `for NAME in a b` gives NAME each listed
 * value, and `read NAME` makes it unknown. A word holding an expansion that cannot
 * be resolved is marked `unknown` (the expansion reads as empty, the worst case for
 * an absolute path), and its `tail` keeps the literal text after that expansion.
 *
 * `argv` is the positional parameters ($1, "$@") of a script this command line wrote
 * and ran with arguments, or of `bash -c '...' _ a b`; undefined (the hook's own
 * command) leaves them unknown. A function body (`f() { ... }`) is recorded in
 * `functions`; its commands are marked with `func`, since they run only when the
 * function is called, and positional parameters inside it are unknown here.
 */
class Lexer {
  private i = 0;
  private readonly cmds: Command[] = [];
  private cur: Command = newCommand();
  /** [delimiter, strip tabs, command, delimiter quoted] */
  private pendingHeredocs: [string, boolean, Command, boolean][] = [];
  private loops = new Map<string, [string, boolean][]>();
  private unknownNames = new Set<string>();
  private feeds = new Map<string, Feed>();
  readonly functions = new Map<string, string>();
  /** Open function bodies: [name, body start, brace depth]. */
  private fstack: [string, number, number][] = [];
  private braces = 0;
  /** Per open loop: the `read` feeds bound in its condition. */
  private loopframes: Feed[][] = [];
  private argv: Word[] | undefined;
  private unk = false;
  private feed: Feed | undefined;
  private nexp = 0;

  constructor(
    private s: string,
    private readonly env: Record<string, string>,
    argv?: Word[],
    inherit?: Vars
  ) {
    this.argv = argv ? [...argv] : undefined;
    if (inherit) {
      const pwd = env.PWD;
      Object.assign(env, inherit.values);
      if (pwd !== undefined) env.PWD = pwd;
      this.unknownNames = new Set(inherit.unknown);
      this.loops = new Map(inherit.loops);
      this.feeds = new Map(inherit.feeds);
    }
  }

  /** Expand the text of a ${A:-text} operand (quotes removed, expansions followed). */
  private expandText(text: string): string {
    const saved: [string, number] = [this.s, this.i];
    this.s = text;
    this.i = 0;
    const out: string[] = [];
    try {
      while (this.i < this.s.length) {
        const c = this.s[this.i];
        if (c === '\\') {
          out.push(this.s[this.i + 1] ?? '');
          this.i += 2;
        } else if (c === "'") {
          const end = skipSingle(this.s, this.i);
          out.push(this.s.slice(this.i + 1, end - 1));
          this.i = end;
        } else if (c === '"') {
          this.i++;
        } else if (c === '$' || c === '`') {
          out.push(this.expansion());
        } else {
          out.push(c);
          this.i++;
        }
      }
    } finally {
      [this.s, this.i] = saved;
    }
    return out.join('');
  }

  run(): Command[] {
    const s = this.s;
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === ' ' || c === '\t') this.i++;
      else if (c === '\\' && s.startsWith('\\\n', this.i)) this.i += 2;
      else if (c === '#') {
        while (this.i < s.length && s[this.i] !== '\n') this.i++;
      } else if (s.startsWith('<(', this.i) || s.startsWith('>(', this.i)) {
        this.cur.words.push({ text: this.processSubstitution(), glob: false });
      } else if (this.redirect()) {
        // consumed
      } else if (this.operator()) {
        // consumed
      } else if (this.argv && this.fstack.length === 0 && this.allArgs()) {
        // consumed
      } else {
        const start = this.i;
        const w = this.word();
        if (w) {
          this.cur.words.push(w);
          this.afterWord(w, start);
        }
      }
    }
    this.end('');
    // An unclosed function body: bash rejects it, but judge its commands anyway.
    if (this.fstack.length > 0) for (const cmd of this.cmds) cmd.func = undefined;
    return this.cmds;
  }

  /** A word that is exactly "$@" becomes one word per positional parameter. */
  private allArgs(): boolean {
    ARGV_ALL.lastIndex = this.i;
    const m = ARGV_ALL.exec(this.s);
    if (!m) return false;
    const end = this.i + m[0].length;
    if (end < this.s.length && !' \t\n;&|()<>'.includes(this.s[end])) return false;
    this.i = end;
    for (const w of this.argv ?? []) this.cur.words.push({ ...w, feed: undefined });
    return true;
  }

  /** Track `{ ... }` at command start, so a function body's end is found. */
  private afterWord(w: Word, start: number): void {
    const words = this.cur.words;
    const raw = this.s.slice(start, this.i);
    if (words.length === 1 && raw === '{') this.braces++;
    else if (words.length === 1 && raw === '}') {
      words.pop();
      this.braces--;
      const top = this.fstack[this.fstack.length - 1];
      if (top?.[2] === this.braces) {
        this.fstack.pop();
        this.functions.set(top[0], this.s.slice(top[1], start));
      }
    } else if (words.length === 2 && words[0].text === 'function' && FUNC_NAME.test(raw)) {
      let j = this.i;
      while (j < this.s.length && ' \t\n'.includes(this.s[j])) j++;
      if (this.s[j] === '{' && (j + 1 === this.s.length || ' \t\n'.includes(this.s[j + 1]))) {
        this.openFunction(w.text, j + 1);
      }
    }
  }

  /** `name() {` or `function name() {`, with this.i at the `(`. */
  private functionParens(): boolean {
    const words = this.cur.words;
    if (!(words.length === 1 || (words.length === 2 && words[0].text === 'function'))) return false;
    const name = words[words.length - 1];
    if (name.unknown || name.alts || !FUNC_NAME.test(name.text)) return false;
    let j = this.i + 1;
    while (j < this.s.length && ' \t'.includes(this.s[j])) j++;
    if (this.s[j] !== ')') return false;
    j++;
    while (j < this.s.length && ' \t\n'.includes(this.s[j])) j++;
    if (!(this.s[j] === '{' && (j + 1 === this.s.length || ' \t\n'.includes(this.s[j + 1])))) {
      return false;
    }
    this.openFunction(name.text, j + 1);
    return true;
  }

  private openFunction(name: string, bodyStart: number): void {
    this.fstack.push([name, bodyStart, this.braces]);
    this.braces++;
    this.cur = newCommand(';');
    this.i = bodyStart;
  }

  /** <(cmd) / >(cmd): the body runs; the word is a /dev/fd path. */
  private processSubstitution(): string {
    const end = scanSubstitution(this.s, this.i + 2);
    this.cur.subs.push(this.s.slice(this.i + 2, end));
    this.i = end + 1;
    return '/dev/fd/63';
  }

  private end(op: string): void {
    if (this.cur.words.length > 0 || this.cur.redirects.length > 0) {
      if (this.fstack.length > 0) this.cur.func = this.fstack[0][0];
      this.bind(this.cur);
      this.cur.vars = {
        values: { ...this.env },
        unknown: new Set(this.unknownNames),
        loops: new Map(this.loops),
        feeds: new Map(this.feeds),
      };
      this.cmds.push(this.cur);
    }
    this.cur = newCommand(op);
  }

  private setVar(name: string, value: string, unknown: boolean): void {
    this.loops.delete(name);
    this.feeds.delete(name);
    this.env[name] = value;
    if (unknown) this.unknownNames.add(name);
    else this.unknownNames.delete(name);
  }

  /** The commands piped into `cmd` (`find ... | sort | while read d`). */
  private pipeline(cmd: Command): Command[] | undefined {
    if ((cmd.sep !== '|' && cmd.sep !== '|&') || this.cmds.length === 0) return undefined;
    let k = this.cmds.length - 1;
    while (k > 0 && (this.cmds[k].sep === '|' || this.cmds[k].sep === '|&')) k--;
    return this.cmds.slice(k);
  }

  /** Record what a finished command does to variables used after it. */
  private bind(cmd: Command): void {
    const all = cmd.words;
    const opener = all.length > 0 ? all[0].text : '';
    let k = 0;
    while (k < all.length && KEYWORDS.has(all[k].text)) k++;
    let words = all.slice(k);
    if (opener === 'while' || opener === 'until') this.loopframes.push([]);
    if (words.length === 0) return;
    let head = words[0].text;
    if ((head === 'for' || head === 'select') && words.length >= 2 && NAME.test(words[1].text)) {
      this.loopframes.push([]);
      const name = words[1].text;
      const values = words.length >= 3 && words[2].text === 'in' ? words.slice(3) : [];
      let flat: [string, boolean][] = [];
      for (const w of values) {
        if (w.unknown) {
          flat = [];
          break;
        }
        flat.push(...(w.alts ?? [[w.text, w.glob] as [string, boolean]]));
      }
      if (values.length > 0 && flat.length > 0) {
        this.setVar(name, '', false);
        this.loops.set(name, flat.slice(0, MAX_ALTS));
      } else {
        this.setVar(name, '', true);
        if (values.length === 1 && values[0].feed) this.feeds.set(name, values[0].feed); // for d in $(find ...)
      }
      return;
    }
    if (head === 'done') {
      const frame = this.loopframes.pop() ?? [];
      for (const feed of frame) {
        if (!feed.cmds && cmd.stdinSub !== undefined) feed.text = cmd.stdinSub; // done < <(find ...)
      }
      return;
    }
    let j = 0;
    while (j < words.length - 1 && ASSIGN.test(words[j].text)) j++; // IFS= read -r d
    if (j > 0 && ['read', 'mapfile', 'readarray'].includes(words[j].text)) {
      words = words.slice(j);
      head = words[0].text;
    }
    if (head === 'read') {
      const feed: Feed = { cmds: this.pipeline(cmd), text: cmd.stdinSub };
      for (const w of words.slice(1)) {
        if (NAME.test(w.text)) {
          this.setVar(w.text, '', true);
          this.feeds.set(w.text, feed);
        }
      }
      this.loopframes[this.loopframes.length - 1]?.push(feed);
      return;
    }
    if (head === 'mapfile' || head === 'readarray') {
      let name = 'MAPFILE';
      for (let i = 1; i < words.length; ) {
        const t = words[i].text;
        if (MAPFILE_ARG.has(t)) i += 2;
        else if (t.startsWith('-')) i++;
        else {
          name = t;
          break;
        }
      }
      if (NAME.test(name)) {
        this.setVar(name, '', true);
        this.feeds.set(name, { cmds: this.pipeline(cmd), text: cmd.stdinSub });
      }
      return;
    }
    if (head === 'shift') {
      if (this.argv && this.fstack.length === 0) {
        const n = words.length > 1 && /^\d+$/.test(words[1].text) ? Number(words[1].text) : 1;
        this.argv = this.argv.slice(n);
      }
      return;
    }
    if (head === 'set') {
      if (this.fstack.length > 0) return;
      const texts = words.slice(1).map(w => w.text);
      const dd = texts.indexOf('--');
      if (dd >= 0) {
        this.argv = words.slice(1 + dd + 1);
        return;
      }
      for (let i = 0; i < texts.length; ) {
        if (texts[i] === '-o' || texts[i] === '+o') i += 2;
        else if (texts[i].startsWith('-') || texts[i].startsWith('+')) i++;
        else {
          this.argv = undefined; // `set a b` sets the parameters to what the guard may not know
          break;
        }
      }
      return;
    }
    if (DECLARE.has(head)) words = words.slice(1).filter(w => !w.text.startsWith('-'));
    if (words.length > 0 && words.every(w => ASSIGN.test(w.text))) {
      for (const w of words) {
        const m = ASSIGN.exec(w.text);
        // Inside a function body the assignment happens only if it is called.
        if (m) this.setVar(m[1], m[2], Boolean(w.unknown || w.alts || this.fstack.length > 0));
      }
    }
  }

  private operator(): boolean {
    for (let op of OPS) {
      if (this.s.startsWith(op, this.i)) {
        if (op === '(' && this.functionParens()) return true;
        this.i += op.length;
        if (op === '\n' && this.pendingHeredocs.length > 0) this.readHeredocs();
        if (op === '(' || op === ')') op = ';';
        this.end(op);
        return true;
      }
    }
    return false;
  }

  private redirect(): boolean {
    REDIRECT.lastIndex = this.i;
    const m = REDIRECT.exec(this.s);
    if (!m) return false;
    const fd = m[1];
    const op = m[2];
    this.i = REDIRECT.lastIndex;
    while (this.i < this.s.length && (this.s[this.i] === ' ' || this.s[this.i] === '\t')) this.i++;
    if (op === '<<' || op === '<<-') {
      const start = this.i;
      const w = this.word();
      const quoted = /['"\\]/.test(this.s.slice(start, this.i));
      this.pendingHeredocs.push([w ? w.text : '', op === '<<-', this.cur, quoted]);
      return true;
    }
    if (this.s.startsWith('<(', this.i) || this.s.startsWith('>(', this.i)) {
      const reads = op === '<' && (fd === '' || fd === '0') && this.s.startsWith('<(', this.i);
      this.cur.redirects.push([op, this.processSubstitution(), fd]);
      if (reads) this.cur.stdinSub = this.cur.subs[this.cur.subs.length - 1];
      return true;
    }
    const w = this.word();
    if (!w) throw new ParseError('redirect without target');
    if ((op === '>&' || op === '<&') && /^(\d+|-)$/.test(w.text)) return true;
    this.cur.redirects.push([op, w.text, fd]);
    return true;
  }

  private readHeredocs(): void {
    const lines = this.s.slice(this.i).split('\n');
    let consumed = 0;
    for (const [delim, stripTabs, cmd, quoted] of this.pendingHeredocs) {
      const body: string[] = [];
      while (consumed < lines.length) {
        const line = lines[consumed];
        consumed++;
        if ((stripTabs ? line.replace(/^\t+/, '') : line) === delim) break;
        body.push(line);
      }
      const text = body.join('\n');
      cmd.heredocs.push(text);
      // An unquoted heredoc runs its $(...) and `...` while it is expanded.
      if (!quoted) cmd.subs.push(...bodySubstitutions(text));
    }
    this.pendingHeredocs = [];
    const skip = lines.slice(0, consumed).reduce((n, l) => n + l.length + 1, 0);
    this.i = Math.min(this.s.length, this.i + skip);
  }

  private word(): Word | undefined {
    const s = this.s;
    const out: string[] = [];
    let size = 0;
    let tailFrom: number | undefined;
    let glob = false;
    let started = false;
    this.unk = false;
    this.feed = undefined;
    this.nexp = 0;
    const put = (text: string): void => {
      out.push(text);
      size += text.length;
    };
    const expand = (): void => {
      const before = this.unk;
      this.unk = false;
      this.nexp++;
      put(this.expansion());
      if (this.unk) tailFrom = size;
      this.unk = before || this.unk;
    };
    if (s.startsWith('~', this.i)) {
      const j = this.i + 1;
      if (j === s.length || '/ \t\n;&|)'.includes(s[j])) {
        put(this.env.HOME ?? '');
        this.i = j;
        started = true;
      }
    }
    while (this.i < s.length) {
      let c = s[this.i];
      if (' \t\n;&|()<>'.includes(c)) break;
      started = true;
      if (c === '\\') {
        if (this.i + 1 < s.length) put(s[this.i + 1]);
        this.i += 2;
      } else if (c === "'") {
        const end = s.indexOf("'", this.i + 1);
        if (end < 0) throw new ParseError("unbalanced '");
        put(s.slice(this.i + 1, end));
        this.i = end + 1;
      } else if (c === '"') {
        this.i++;
        for (;;) {
          if (this.i >= s.length) throw new ParseError('unbalanced "');
          c = s[this.i];
          if (c === '"') {
            this.i++;
            break;
          }
          if (c === '\\' && this.i + 1 < s.length && '"\\$`'.includes(s[this.i + 1])) {
            put(s[this.i + 1]);
            this.i += 2;
          } else if (c === '$' || c === '`') {
            expand();
          } else {
            put(c);
            this.i++;
          }
        }
      } else if (c === '$' && s[this.i + 1] === "'") {
        // $'...' (ANSI-C quoting): `rm -rf $'/etc'` is `rm -rf /etc`
        const [text, next] = skipAnsiC(s, this.i + 1);
        put(text);
        this.i = next;
      } else if (c === '$' && s[this.i + 1] === '"') {
        this.i++; // $"..." (locale quoting) reads as "..."
      } else if (c === '$' || c === '`') {
        expand();
      } else {
        if (c === '*' || c === '?' || c === '[') glob = true;
        put(c);
        this.i++;
      }
    }
    if (!started) return undefined;
    const text = out.join('');
    const tail = tailFrom !== undefined ? text.slice(tailFrom) : undefined;
    const feed = this.nexp === 1 && this.unk ? this.feed : undefined;
    if (!text.includes('\uE000')) return { text, glob, unknown: this.unk, tail, feed };
    // A loop variable: one alternative per combination of its listed values.
    const parts = text.split(LOOP_REF);
    let alts: [string, boolean][] = [['', glob]];
    parts.forEach((part, k) => {
      if (k % 2 === 0) {
        alts = alts.map(([t, g]) => [t + part, g] as [string, boolean]);
      } else {
        const vals = this.loops.get(part) ?? [['', false]];
        alts = alts
          .flatMap(([t, g]) => vals.map(([v, vg]) => [t + v, g || vg] as [string, boolean]))
          .slice(0, MAX_ALTS);
      }
    });
    return { text: alts[0][0], glob: alts[0][1], unknown: this.unk, alts, tail };
  }

  private variable(name: string): string {
    if (this.loops.has(name)) return `\uE000${name}\uE000`;
    const own = Object.hasOwn(this.env, name);
    if (!own || this.unknownNames.has(name)) {
      this.unk = true;
      this.feed = this.feeds.get(name);
    }
    return own ? this.env[name] : '';
  }

  /**
   * $1..$9 and $# of a script run with known arguments; undefined when unknown (the
   * hook's own command, or inside a function body).
   */
  private positional(ch: string): string | undefined {
    if (!this.argv || this.fstack.length > 0) return undefined;
    if (ch === '#') return String(this.argv.length);
    if (/^[1-9]$/.test(ch)) {
      const n = Number(ch);
      if (n > this.argv.length) return '';
      const w = this.argv[n - 1];
      if (w.unknown || w.alts) this.unk = true;
      return w.text;
    }
    return undefined;
  }

  private expansion(): string {
    const s = this.s;
    if (s[this.i] === '`') {
      const end = s.indexOf('`', this.i + 1);
      if (end < 0) throw new ParseError('unbalanced `');
      const body = s.slice(this.i + 1, end);
      this.i = end + 1;
      return this.substitute(body);
    }
    if (s.startsWith('$((', this.i)) {
      const end = s.indexOf('))', this.i);
      if (end < 0) throw new ParseError('unbalanced $((');
      this.i = end + 2;
      return '0';
    }
    if (s.startsWith('$(', this.i)) {
      const j = scanSubstitution(s, this.i + 2);
      const body = s.slice(this.i + 2, j);
      this.i = j + 1;
      return this.substitute(body);
    }
    if (s.startsWith('${', this.i)) {
      const end = scanBrace(s, this.i + 2);
      const inner = s.slice(this.i + 2, end);
      this.i = end + 1;
      if (/^[1-9#]$/.test(inner)) {
        const pos = this.positional(inner);
        if (pos !== undefined) return pos;
      }
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(inner);
      const name = m ? m[0] : '';
      const rest = inner.slice(name.length);
      if (this.loops.has(name)) return this.variable(name);
      const own = Object.hasOwn(this.env, name);
      const known = own && !this.unknownNames.has(name);
      const val = own ? this.env[name] : '';
      // ${A:-default}: when A is unset the default is used, and it may hold
      // expansions of its own (${A:-${HOME}}); when A's value is unknown, it is
      // either A or the default, so the word is unknown.
      const op = /^(:?[-=])/.exec(rest);
      if (op && name) {
        const fallback = this.expandText(rest.slice(op[1].length));
        this.feed = undefined;
        // An unset name may still be set in the environment the shell runs in.
        if (!known) this.unk = true;
        if (!own) return fallback;
        return val || (op[1].startsWith(':') ? fallback : val);
      }
      if (!known) {
        this.unk = true;
        // ${d}, "${dirs[@]}": the variable's feed, if it has one
        this.feed = ['', '[@]', '[*]'].includes(rest) ? this.feeds.get(name) : undefined;
      }
      return val;
    }
    VAR.lastIndex = this.i + 1;
    const m = VAR.exec(s);
    if (m) {
      this.i = VAR.lastIndex;
      return this.variable(m[0]);
    }
    this.i++;
    if (this.i < s.length && '@*#?$!-0123456789'.includes(s[this.i])) {
      const ch = s[this.i];
      this.i++;
      const pos = this.positional(ch);
      if (pos !== undefined) return pos;
      this.unk = true;
      return '';
    }
    return '$';
  }

  private substitute(body: string): string {
    this.cur.subs.push(body);
    if (body.trim() === 'pwd') return this.env.PWD ?? '';
    if (body.trim().split(' ')[0] === 'mktemp') return '/tmp/guard-mktemp'; // always a fresh temp path
    this.unk = true;
    this.feed = { text: body }; // rm -rf $(find ...)
    return '';
  }
}

// ---------------------------------------------------------------- checks

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'ash', 'mksh']);
const MAX_DEPTH = 8;
/** Marks a directory the guard could not resolve (`cd "$X"`); never a real path. */
const UNRESOLVED = '';
const UNRESOLVED_CWD = `/${UNRESOLVED}unresolved`;
/**
 * Temp-dir variables resolve to a temp path, so `rm -rf "$TMPDIR/x"` is judged as
 * a temp folder rather than as an unresolved path.
 */
const TEMP_ENV: Record<string, string> = {
  TMPDIR: '/tmp/guard-tmpdir',
  TMP: '/tmp/guard-tmpdir',
  TEMP: '/tmp/guard-tmpdir',
};
const DEVICE =
  /^\/dev\/(sd[a-z]|hd[a-z]|vd[a-z]|xvd[a-z]|nvme\d|mmcblk\d|md\d|dm-\d|loop\d|mapper\/|disk\/)/;
const FIND_FILTERS = new Set([
  '-name',
  '-iname',
  '-path',
  '-ipath',
  '-wholename',
  '-iwholename',
  '-regex',
  '-iregex',
]);
const FIND_PATH_FILTERS = new Set(['-path', '-ipath', '-wholename', '-iwholename']);
const FIND_EXEC = ['-exec', '-execdir', '-ok', '-okdir'];
/** find tests that take one argument (so it is not read as an operator or a path). */
const FIND_ARG1 = new Set([
  '-name',
  '-iname',
  '-path',
  '-ipath',
  '-wholename',
  '-iwholename',
  '-regex',
  '-iregex',
  '-lname',
  '-ilname',
  '-type',
  '-xtype',
  '-mtime',
  '-mmin',
  '-atime',
  '-amin',
  '-ctime',
  '-cmin',
  '-newer',
  '-anewer',
  '-cnewer',
  '-size',
  '-perm',
  '-user',
  '-group',
  '-uid',
  '-gid',
  '-links',
  '-inum',
  '-samefile',
  '-maxdepth',
  '-mindepth',
  '-fstype',
  '-used',
  '-regextype',
  '-context',
  '-files0-from',
]);
const MATCH_ALL_REGEX = new Set(['.*', '^.*', '.*$', '^.*$', '.+', '^.+$']);
const STDOUT_FDS = new Set(['', '1', '&']);
const DOCKER_GLOBAL_ARG = new Set([
  '-H',
  '--host',
  '-c',
  '--context',
  '--config',
  '-l',
  '--log-level',
]);
const DOCKER_EXEC_ARG = new Set([
  '-e',
  '--env',
  '--env-file',
  '-u',
  '--user',
  '-w',
  '--workdir',
  '--detach-keys',
]);
const COMPOSE_GLOBAL_ARG = new Set([
  '-f',
  '--file',
  '-p',
  '--project-name',
  '--project-directory',
  '--env-file',
  '--profile',
  '--ansi',
  '--progress',
  '--parallel',
]);
const COMPOSE_EXEC_ARG = new Set(['-e', '--env', '-u', '--user', '-w', '--workdir', '--index']);
/** Options of sort/uniq/head/tail/grep that take the next word as their value. */
const LINE_FILTER_ARG = new Set([
  '-n',
  '-c',
  '-k',
  '-t',
  '-o',
  '-S',
  '-T',
  '-e',
  '-m',
  '-A',
  '-B',
  '-C',
  '-f',
  '-s',
  '-w',
  '--lines',
  '--bytes',
  '--key',
  '--field-separator',
  '--regexp',
  '--max-count',
]);
/** rsync options that take the next word as their value (when not written --opt=value). */
const RSYNC_ARG = new Set([
  '-e',
  '--rsh',
  '-f',
  '--filter',
  '--exclude',
  '--include',
  '--exclude-from',
  '--include-from',
  '--files-from',
  '--password-file',
  '--log-file',
  '--log-file-format',
  '--partial-dir',
  '-T',
  '--temp-dir',
  '--compare-dest',
  '--copy-dest',
  '--link-dest',
  '--backup-dir',
  '--suffix',
  '--chmod',
  '--chown',
  '--usermap',
  '--groupmap',
  '--rsync-path',
  '--timeout',
  '--contimeout',
  '--port',
  '--sockopts',
  '--out-format',
  '--max-size',
  '--min-size',
  '--max-delete',
  '--max-alloc',
  '--bwlimit',
  '-M',
  '--remote-option',
  '--info',
  '--debug',
  '--iconv',
  '--checksum-choice',
  '--cc',
  '--compress-choice',
  '--zc',
  '--compress-level',
  '--zl',
  '--skip-compress',
  '--modify-window',
  '-@',
  '-B',
  '--block-size',
  '--protocol',
  '--outbuf',
  '--stop-after',
  '--stop-at',
  '--write-batch',
  '--read-batch',
  '--only-write-batch',
  '--address',
  '--copy-as',
]);
const RSYNC_SHORT_ARG = 'efTM@B';

/**
 * Shared by one command line and everything it runs: the scripts it wrote (absolute
 * path -> content, undefined when unknown) and the shell functions it defined (name
 * -> body), with the ones called so far.
 */
interface Scope {
  files: Map<string, string | undefined>;
  funcs: Map<string, string>;
  called: Set<string>;
}

/**
 * `cd -` and `popd` within one command line: the previous folder (undefined: the one
 * before this command, which the guard cannot know) and the pushd stack.
 */
interface Dirs {
  old?: string;
  stack: string[];
}

/** A command the guard could not read, allowed and reported as a log-only entry. */
export type LogOnly = (entry: { command: string; cwd: string; reason: string }) => void;

type Outcome = [Violation | undefined, string | undefined];
type FindFilter = [kind: string, pattern: string];
type FindNode =
  | ['filter', FindFilter]
  | ['test']
  | ['act', string, boolean]
  | ['not', FindNode]
  | ['and', FindNode[]]
  | ['or', FindNode[]];
type Dnf = FindFilter[][];
type FindAction = [kind: string, recursive: boolean, dnf: Dnf];

function writeFile(
  files: Map<string, string | undefined>,
  path: string,
  text: string | undefined,
  append: boolean
): void {
  if (append) {
    // An unknown append leaves the known part, which still runs.
    if (text !== undefined) files.set(path, (files.get(path) ?? '') + text);
  } else files.set(path, text);
}

function matchesAll([kind, pattern]: FindFilter, roots: string[]): boolean {
  if (kind === '-regex' || kind === '-iregex') return MATCH_ALL_REGEX.has(pattern);
  if (pattern.replace(/\*/g, '') === '') return true;
  if (FIND_PATH_FILTERS.has(kind)) {
    for (const root of roots) {
      const base = root.replace(/\/+$/, '') || '/';
      if (
        pattern.startsWith(base) &&
        pattern.slice(base.length).replace(/^\/+/, '').replace(/\*/g, '') === ''
      ) {
        return true;
      }
    }
  }
  return false;
}

/** Whether some string the glob `pattern` matches ends with `suffix`. */
function globCanEndWith(pattern: string, suffix: string): boolean {
  const toks: [string, string][] = [];
  let j = 0;
  while (j < pattern.length) {
    const c = pattern[j];
    if (c === '\\' && j + 1 < pattern.length) {
      toks.push(['lit', pattern[j + 1]]);
      j += 2;
    } else if (c === '*') {
      toks.push(['star', '']);
      j++;
    } else if (c === '?') {
      toks.push(['any', '']);
      j++;
    } else if (c === '[' && pattern.indexOf(']', j + 2) > 0) {
      const end = pattern.indexOf(']', j + 2);
      toks.push(['class', pattern.slice(j, end + 1)]);
      j = end + 1;
    } else {
      toks.push(['lit', c]);
      j++;
    }
  }
  let t = toks.length - 1;
  for (let k = suffix.length - 1; k >= 0; k--, t--) {
    if (t < 0) return false;
    const [kind, val] = toks[t];
    if (kind === 'star') return true;
    const ch = suffix[k];
    const ok =
      kind === 'any' || (kind === 'class' ? fnmatch(ch, val) : kind === 'lit' && val === ch);
    if (!ok) return false;
  }
  return true;
}

/** A glob component that matches every file or every note: *, *.md, *.* */
function matchesEveryNote(component: string): boolean {
  return (
    component.includes('*') && ['', '.', '.md'].includes(component.replace(/\*/g, '').toLowerCase())
  );
}

/**
 * A filter that only drops lines from a list of paths (sort, uniq, head, tail, grep
 * without -o), so a find's narrowing still holds after it.
 */
function narrowsLines(words: Word[]): boolean {
  if (words.length === 0) return false;
  const name = basename(words[0].text);
  const grep = ['grep', 'egrep', 'fgrep'].includes(name);
  if (!grep && !['sort', 'uniq', 'head', 'tail', 'tac'].includes(name)) return false;
  let operands = 0;
  let patternGiven = false;
  for (let k = 1; k < words.length; ) {
    const t = words[k].text;
    if (t.startsWith('-') && t.length > 1) {
      if (
        grep &&
        (['-o', '--only-matching', '-r', '-R', '--recursive'].includes(t) ||
          (!t.startsWith('--') && /[orR]/.test(t)))
      ) {
        return false; // prints parts of lines, or reads files instead of stdin
      }
      if (['-e', '--regexp', '-f'].includes(t)) patternGiven = true;
      k += LINE_FILTER_ARG.has(t) ? 2 : 1;
      continue;
    }
    operands++;
    k++;
  }
  // A file operand makes it read that file instead of the paths on stdin.
  return operands <= (patternGiven || !grep ? 0 : 1);
}

class FindSyntax extends Error {}

/** find's expression: ( ) ! -not -a -and -o -or, tests and actions. */
class FindParser {
  private k = 0;
  constructor(private readonly t: string[]) {}

  private peek(): string | undefined {
    return this.t[this.k];
  }

  parse(): FindNode {
    if (this.t.length === 0) return ['and', []];
    const e = this.or();
    if (this.k !== this.t.length) throw new FindSyntax('trailing tokens');
    return e;
  }

  private or(): FindNode {
    const items = [this.and()];
    while (this.peek() === '-o' || this.peek() === '-or') {
      this.k++;
      items.push(this.and());
    }
    return items.length === 1 ? items[0] : ['or', items];
  }

  private and(): FindNode {
    const items = [this.unary()];
    for (;;) {
      const p = this.peek();
      if (p === undefined || p === '-o' || p === '-or' || p === ')') break;
      if (p === '-a' || p === '-and') this.k++;
      items.push(this.unary());
    }
    return items.length === 1 ? items[0] : ['and', items];
  }

  private unary(): FindNode {
    const t = this.peek();
    if (t === undefined) throw new FindSyntax('missing operand');
    if (t === '!' || t === '-not') {
      this.k++;
      return ['not', this.unary()];
    }
    if (t === '(') {
      this.k++;
      const e = this.or();
      if (this.peek() !== ')') throw new FindSyntax('unbalanced (');
      this.k++;
      return e;
    }
    return this.primary();
  }

  private arg(): string {
    if (this.k >= this.t.length) throw new FindSyntax('missing argument');
    return this.t[this.k++];
  }

  private primary(): FindNode {
    const t = this.t[this.k++];
    if (FIND_FILTERS.has(t)) return ['filter', [t, this.arg()]];
    if (t === '-delete') return ['act', 'delete', false];
    if (FIND_EXEC.includes(t)) {
      const cmd: string[] = [];
      for (;;) {
        if (this.k >= this.t.length) throw new FindSyntax('unterminated -exec');
        const tok = this.t[this.k++];
        if (tok === ';' || (tok === '+' && cmd[cmd.length - 1] === '{}')) break;
        cmd.push(tok);
      }
      if (cmd.length > 0 && basename(cmd[0]) === 'rm') {
        const recursive = cmd
          .slice(1)
          .some(
            x => x === '--recursive' || (x.startsWith('-') && !x.startsWith('--') && /[rR]/.test(x))
          );
        return ['act', 'rm', recursive];
      }
      return ['act', 'other', false];
    }
    if (t === '-print' || t === '-print0' || t === '-ls') return ['act', 'print', false];
    if (t === '-printf') {
      this.arg();
      return ['act', 'print', false];
    }
    if (t === '-fprint' || t === '-fprint0' || t === '-fls') {
      this.arg();
      return ['act', 'other', false];
    }
    if (t === '-fprintf') {
      this.arg();
      this.arg();
      return ['act', 'other', false];
    }
    if (t === '-prune') return ['act', 'prune', false];
    if (FIND_ARG1.has(t) || /^-newer[aBcmt]{2}$/.test(t)) this.arg();
    return ['test'];
  }
}

const DNF_CAP = 64;

function dnfAnd(a: Dnf, b: Dnf): Dnf {
  if (a.length * b.length > DNF_CAP) return [[]]; // too many branches to follow: not narrowed
  return a.flatMap(x => b.map(y => [...x, ...y]));
}

/**
 * The filters that must match for `node` to be true, as alternatives (an empty
 * alternative: it can be true with no filter matching).
 */
function trueDnf(node: FindNode): Dnf {
  switch (node[0]) {
    case 'filter':
      return [[node[1]]];
    case 'and': {
      let out: Dnf = [[]];
      for (const item of node[1]) out = dnfAnd(out, trueDnf(item));
      return out;
    }
    case 'or': {
      const out = node[1].flatMap(trueDnf);
      return out.length <= DNF_CAP ? out : [[]];
    }
    default:
      return [[]]; // a test, an action, or a negation (which never narrows)
  }
}

/**
 * [kind, recursive, filters that must match for it to run] for each delete in a find
 * expression, or with `feed` for each print (the implicit -print included). An
 * expression this cannot parse is read the old way: every filter narrows.
 */
function findActions(expr: string[], feed: boolean): FindAction[] {
  let tree: FindNode;
  try {
    tree = new FindParser(expr).parse();
  } catch (err) {
    if (err instanceof FindSyntax) return findActionsFlat(expr, feed);
    throw err;
  }
  const acts: FindAction[] = [];
  const walk = (node: FindNode, ctx: Dnf): void => {
    if (node[0] === 'and') {
      let cur = ctx;
      for (const item of node[1]) {
        walk(item, cur);
        cur = dnfAnd(cur, trueDnf(item));
      }
    } else if (node[0] === 'or') {
      for (const item of node[1]) walk(item, ctx); // an earlier branch being false narrows nothing
    } else if (node[0] === 'not') walk(node[1], ctx);
    else if (node[0] === 'act') acts.push([node[1], node[2], ctx]);
  };
  walk(tree, [[]]);
  if (!feed) return acts.filter(a => a[0] === 'delete' || a[0] === 'rm');
  let prints = acts.filter(a => a[0] === 'print');
  // No action but -prune: find prints what matches.
  if (!acts.some(a => a[0] !== 'prune')) prints = [['print', true, trueDnf(tree)]];
  return prints.map(a => ['print', true, a[2]] as FindAction);
}

function findActionsFlat(expr: string[], feed: boolean): FindAction[] {
  const execRm = (k: number): boolean =>
    FIND_EXEC.includes(expr[k]) && k + 1 < expr.length && basename(expr[k + 1]) === 'rm';
  const deleting = expr.includes('-delete') || expr.some((_, k) => execRm(k));
  if (!deleting && !feed) return [];
  const recursive =
    feed ||
    expr.some(
      (_, k) =>
        execRm(k) && expr.slice(k + 2).some(x => /^(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)$/.test(x))
    );
  const filters: FindFilter[] = [];
  expr.forEach((t, k) => {
    if (
      FIND_FILTERS.has(t) &&
      k + 1 < expr.length &&
      !(k > 0 && (expr[k - 1] === '!' || expr[k - 1] === '-not'))
    ) {
      filters.push([t, expr[k + 1]]);
    }
  });
  const anyBranch = expr.includes('-o') || expr.includes('-or');
  const dnf: Dnf = anyBranch ? filters.map(f => [f]) : [filters];
  return [[feed ? 'print' : 'delete', recursive, dnf.length > 0 ? dnf : [[]]]];
}

/**
 * Whether a find filter matches an entry with this name and printed path. find's
 * globs let * match a leading dot and, in -path, a slash.
 */
function findMatch([kind, pattern]: FindFilter, name: string, path: string): boolean {
  let subject = kind === '-name' || kind === '-iname' ? name : path;
  let pat = pattern;
  if (kind.startsWith('-i')) {
    subject = subject.toLowerCase();
    pat = pat.toLowerCase();
  }
  if (kind.endsWith('regex')) {
    try {
      return new RegExp(`^(?:${pat})$`, 's').test(subject);
    } catch {
      return false;
    }
  }
  return fnmatch(subject, pat);
}

function emptyScope(): Scope {
  return { files: new Map(), funcs: new Map(), called: new Set() };
}

// Dead code after `true ||` / `: ||` (the Python guard's `_dead_after_true`). The lexer's
// commands are flat (each records the operator before it), so a compound command is
// delimited by its reserved words.
/** The rest of the command is its header. */
const BLOCK_OPEN = new Set(['for', 'select', 'case']);
/** A condition command follows. */
const BLOCK_OPEN_COND = new Set(['while', 'until', 'if']);
const BLOCK_CLOSE = new Set(['done', 'fi', 'esac']);
const BLOCK_INNER = new Set(['do', 'then', 'else', 'elif', '!']);

/**
 * How a command's leading reserved words change the compound-command depth; undefined
 * when it opens a block whose end the lexer does not keep (`{ ... }`, a function).
 */
function depthStep(c: Command): number | undefined {
  let d = 0;
  for (const w of c.words) {
    const t = w.text;
    if (w.unknown || w.alts || w.glob) break;
    if (BLOCK_CLOSE.has(t)) d -= 1;
    else if (BLOCK_OPEN.has(t)) return d + 1;
    else if (BLOCK_OPEN_COND.has(t)) d += 1;
    else if (t === '{' || t === 'function') return undefined;
    else if (!BLOCK_INNER.has(t)) break;
  }
  return d;
}

/**
 * The index after the and-or list member that starts at `j`: a pipeline of simple or
 * compound commands (`for ... done | sort`). Undefined when its end is not certain.
 */
function memberEnd(cmds: Command[], j: number): number | undefined {
  let k = j;
  for (;;) {
    let depth = 0;
    for (;;) {
      if (k >= cmds.length || cmds[k].func) return undefined;
      const step = depthStep(cmds[k]);
      if (step === undefined) return undefined;
      depth += step;
      k += 1;
      if (depth < 0) return undefined;
      if (depth === 0) break;
    }
    if (k < cmds.length && (cmds[k].sep === '|' || cmds[k].sep === '|&')) continue;
    return k;
  }
}

/** A bare `true` or `:`: no arguments, redirects or substitutions that could fail. */
function alwaysTrue(c: Command): boolean {
  const w = c.words[0];
  return (
    c.words.length === 1 &&
    (w.text === 'true' || w.text === ':') &&
    !w.unknown &&
    !w.alts &&
    !w.glob &&
    c.redirects.length === 0 &&
    c.subs.length === 0 &&
    c.heredocs.length === 0 &&
    !c.func
  );
}

/**
 * Commands that can't run: the members after `true ||` (`true || for d in *\/; do rm -rf
 * "$d"; done`). `true` must start its and-or list or follow `||` (`x && true || y` runs y
 * when x fails) and not end a pipeline (pipefail). Anything whose extent is unsure runs.
 * Matches the Python guard's `_dead_after_true`; both run the shared case list.
 */
function deadAfterTrue(cmds: Command[]): Set<number> {
  const dead = new Set<number>();
  cmds.forEach((c, i) => {
    if (!alwaysTrue(c) || c.sep === '&&' || c.sep === '|' || c.sep === '|&') return;
    let j = i + 1;
    while (j < cmds.length && cmds[j].sep === '||') {
      const k = memberEnd(cmds, j);
      if (k === undefined) break;
      for (let n = j; n < k; n++) dead.add(n);
      j = k;
    }
  });
  return dead;
}

// ---------------------------------------------------------------- force-push

/** `name` is one of `options`, or a prefix git would expand to one (--force-w). */
function longOption(name: string, options: string[]): boolean {
  return options.includes(name) || (name.length > 2 && options.some(o => o.startsWith(name)));
}

interface PushArgs {
  /** The force option as written (--force, -uf, --mirror). */
  force?: string;
  dryRun: boolean;
  /** An option that pushes every branch or every tag (--all, --mirror, --tags). */
  every?: string;
  /** The repository, then the refspecs. */
  positionals: Word[];
}

/** What `git push <words>` asks for, by the rules file's force_push definition (as the Python guard's parse_push). */
function parsePush(words: Word[], spec: ForcePushSpec): PushArgs {
  const out: PushArgs = { dryRun: false, positionals: [] };
  let k = 0;
  while (k < words.length) {
    const a = words[k].text;
    k++;
    if (a === '--') {
      out.positionals.push(...words.slice(k));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq >= 0 ? a.slice(0, eq) : a;
      if (spec.value_options.includes(name) && eq < 0) k++;
      else if (longOption(name, spec.dry_run_options)) out.dryRun = true;
      else if (longOption(name, spec.force_options)) out.force ??= a;
      if (longOption(name, spec.every_branch_options)) out.every ??= a;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      for (let i = 1; i < a.length; i++) {
        const ch = a[i];
        if (spec.value_short.includes(ch)) {
          if (i === a.length - 1) k++; // -o value; -ovalue holds its own
          break;
        }
        if (spec.force_short.includes(ch)) out.force ??= a;
        else if (spec.dry_run_short.includes(ch)) out.dryRun = true;
      }
      continue;
    }
    out.positionals.push(words[k - 1]);
  }
  return out;
}

interface GitRepo {
  /** This worktree's git dir (HEAD lives here). */
  gitDir: string;
  /** The repository's common dir (config, refs/remotes). */
  commonDir: string;
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** The git repo `cwd` is in (a .git folder, or a worktree's .git file), or undefined. */
function gitRepoAt(cwd: string): GitRepo | undefined {
  if (cwd.includes(UNRESOLVED) || !cwd.startsWith('/')) return undefined;
  for (let dir = normPath(cwd); ; dir = dirname(dir)) {
    const dotGit = joinPath(dir, '.git');
    let gitDir: string | undefined;
    try {
      if (statSync(dotGit).isDirectory()) gitDir = dotGit;
      else {
        const m = /^gitdir:\s*(.+?)\s*$/m.exec(readText(dotGit) ?? '');
        if (m) gitDir = m[1].startsWith('/') ? normPath(m[1]) : normPath(joinPath(dir, m[1]));
      }
    } catch {
      // no .git here: look higher
    }
    if (gitDir) {
      const common = readText(joinPath(gitDir, 'commondir'))?.trim();
      const commonDir = common
        ? common.startsWith('/')
          ? normPath(common)
          : normPath(joinPath(gitDir, common))
        : gitDir;
      return { gitDir, commonDir };
    }
    if (dir === '/') return undefined;
  }
}

const BRANCH_NAME = /^(?!-)[A-Za-z0-9._/-]+$/;

/** The branch HEAD names in `repo`, or undefined (detached, unreadable). */
function currentBranch(repo: GitRepo): string | undefined {
  const m = /^ref:\s*refs\/heads\/(\S+)\s*$/.exec(readText(joinPath(repo.gitDir, 'HEAD')) ?? '');
  return m?.[1];
}

/** `branch.<name>.merge` from the repo's config: where a bare push of `name` may go. */
function upstreamOf(repo: GitRepo, name: string): string | undefined {
  const config = readText(joinPath(repo.commonDir, 'config'));
  if (!config) return undefined;
  let inSection = false;
  for (const line of config.split('\n')) {
    const section = /^\s*\[\s*branch\s+"([^"]*)"\s*\]/.exec(line);
    if (section) {
      inSection = section[1] === name;
      continue;
    }
    if (/^\s*\[/.test(line)) {
      inSection = false;
      continue;
    }
    const merge = inSection ? /^\s*merge\s*=\s*refs\/heads\/(\S+)\s*$/i.exec(line) : null;
    if (merge) return merge[1];
  }
  return undefined;
}

/** The branch `refs/remotes/<remote>/HEAD` names (the remote's default branch), or undefined. */
function remoteHead(repo: GitRepo, remote: string): string | undefined {
  if (!/^[A-Za-z0-9._-]+$/.test(remote)) return undefined;
  const text = readText(joinPath(repo.commonDir, `refs/remotes/${remote}/HEAD`)) ?? '';
  const m = new RegExp(`^ref:\\s*refs/remotes/${remote.replace(/[.]/g, '\\.')}/(\\S+)\\s*$`).exec(
    text
  );
  return m?.[1];
}

/**
 * The branches a forced refspec overwrites on the remote, or a reason it cannot be
 * named. `src` alone pushes to the same name, so a bare `HEAD`/`@` is the current
 * branch's own name (git: a missing `:<dst>` updates the same ref as `<src>`), never
 * its upstream; only a push with no refspec follows push.default to the upstream.
 */
function refspecTargets(w: Word, plus: string, repo: GitRepo | undefined): string[] | string {
  if (w.unknown) return `${w.text || 'a variable'} holds a value the guard cannot see`;
  const text = w.text.startsWith(plus) ? w.text.slice(plus.length) : w.text;
  if (text.includes('*')) return `${w.text} is a wildcard`;
  const colon = text.indexOf(':');
  if (colon < 0 && (text === 'HEAD' || text === '@')) {
    const branch = repo ? currentBranch(repo) : undefined;
    return branch
      ? [branch]
      : `${text} is detached or the repo at the command's folder is unreadable`;
  }
  const dst = colon >= 0 ? text.slice(colon + 1) : text;
  if (dst === 'HEAD' || dst === '@') return currentTargets(repo);
  const branch = dst.startsWith('refs/heads/') ? dst.slice('refs/heads/'.length) : dst;
  if (branch.startsWith('refs/')) return `${dst} is not a branch`;
  if (!BRANCH_NAME.test(branch)) return `${w.text} does not name a branch`;
  return [branch];
}

/** What a push with no refspec (or to `<src>:HEAD`) overwrites: the current branch and its upstream. */
function currentTargets(repo: GitRepo | undefined): string[] | string {
  const branch = repo ? currentBranch(repo) : undefined;
  if (!repo || !branch) {
    return "the current branch cannot be read from the repo at the command's folder";
  }
  const upstream = upstreamOf(repo, branch);
  return upstream && upstream !== branch ? [branch, upstream] : [branch];
}

export class Checker {
  /** `logOnly` receives the commands the guard could not read (they are allowed). */
  constructor(
    private readonly r: Rules,
    private readonly logOnly?: LogOnly
  ) {}

  /**
   * `argv`: the positional parameters when this is a script or function run with
   * known arguments (undefined: unknown). `inherit`: the caller's variables, for what
   * runs in the same shell (a function, trap, eval, source, $(...)).
   */
  check(
    cmd: string,
    cwd: string,
    depth = 0,
    scope: Scope = emptyScope(),
    argv?: Word[],
    inherit?: Vars
  ): Violation | undefined {
    if (cmd.trim() === '') return undefined;
    if (depth > MAX_DEPTH) {
      this.logOnly?.({ command: cmd, cwd, reason: `nested more than ${MAX_DEPTH} levels deep` });
      return undefined;
    }
    const env: Record<string, string> = { ...TEMP_ENV, HOME: this.r.home, PWD: cwd };
    let lexer: Lexer;
    let cmds: Command[];
    try {
      lexer = new Lexer(cmd, env, argv, inherit);
      cmds = lexer.run();
    } catch (err) {
      if (err instanceof ParseError) {
        // bash rejects what this cannot read, so nothing in it runs
        this.logOnly?.({ command: cmd, cwd, reason: err.message });
        return undefined;
      }
      throw err;
    }
    for (const [name, body] of lexer.functions) scope.funcs.set(name, body);
    const dirs: Dirs = { stack: [] };
    let upstream: Command[] = [];
    let prevOut: string | undefined;
    const dead = deadAfterTrue(cmds);
    for (const [idx, c] of cmds.entries()) {
      // a function body runs when the function is called; dead code never
      if (c.func || dead.has(idx)) continue;
      env.PWD = cwd;
      for (const body of c.subs) {
        const v = this.check(body, cwd, depth + 1, scope, undefined, c.vars);
        if (v) return v;
      }
      for (const [op, target] of c.redirects) {
        if (['>', '>>', '>|', '<>', '>&'].includes(op) && DEVICE.test(target)) {
          return this.r.violation('disk-wipe', `writes to the disk device ${target}`);
        }
      }
      const piped = c.sep === '|' || c.sep === '|&';
      if (!piped) upstream = [];
      const stdin = piped ? prevOut : undefined;
      const [v, newCwd] = this.command(c.words, c, upstream, cwd, depth, scope, stdin, dirs);
      if (v) return v;
      prevOut = this.output(c, stdin, cwd, scope.files);
      if (newCwd !== undefined) cwd = newCwd;
      upstream = [...upstream, c];
    }
    // A function never called by name may still run (a variable holding its name):
    // its body is judged with unknown arguments.
    const last = cmds.length > 0 ? cmds[cmds.length - 1].vars : undefined;
    for (const [name, body] of lexer.functions) {
      if (!scope.called.has(name)) {
        scope.called.add(name);
        const v = this.check(body, cwd, depth + 1, scope, undefined, last);
        if (v) return v;
      }
    }
    return undefined;
  }

  private abs(path: string, cwd: string): string {
    if (path.startsWith('/')) return normPath(path);
    // Relative to a directory the guard could not resolve: keep the marker, never
    // let `..` normalise it away.
    if (cwd.includes(UNRESOLVED)) return `${UNRESOLVED_CWD}/${path}`;
    return normPath(joinPath(cwd, path));
  }

  /** The directory a `cd`-like word leads to; a word the guard cannot resolve gives UNRESOLVED_CWD. */
  private chdir(w: Word, cwd: string): string {
    if (w.unknown || w.alts) return UNRESOLVED_CWD;
    return this.abs(w.text, cwd);
  }

  /** A path the command follows through a symlink at its end: `source/`, `.`. */
  private static follows(text: string): boolean {
    return /(\/|\/\.|\/\.\.)$/.test(text) || text === '.' || text === '..';
  }

  /**
   * `p`, plus where it really is when a symlink on the way leads elsewhere (an Archon
   * workspace's `source` is a link to the project). The last component is followed
   * only when the command follows it (`rm -rf source/` deletes the project's
   * contents; `rm -rf source` removes the link).
   */
  private realPaths(p: string, follow: boolean): string[] {
    if (p.includes(UNRESOLVED)) return [p];
    let real: string | undefined;
    try {
      if (follow) real = existsSync(p) ? realpathSync(p) : undefined;
      else {
        const parent = dirname(p);
        real =
          parent !== p && parent !== '' && existsSync(parent) && statSync(parent).isDirectory()
            ? joinPath(realpathSync(parent), basename(p))
            : undefined;
      }
    } catch {
      real = undefined;
    }
    if (real) {
      const n = normPath(real);
      if (n !== p) return [p, n];
    }
    return [p];
  }

  /**
   * For a path whose folder the guard cannot resolve (a variable, `$(...)`, an
   * unresolved `cd`): the protected thing it may be. Only a literal name that is
   * protected wherever it sits (a project, `.git`, SecondBrain, .archon ...), a glob
   * directly in the unresolved folder or under a literal parent whose children are
   * protected (`"$X"/*`, `"$X"/projects/*`), or a path that climbs out with `..`
   * counts; any other unresolved path is left to the judged layer.
   */
  private unresolvedHit(w: Word, cwd: string): string | undefined {
    let rel: string;
    let where: string;
    if (cwd.includes(UNRESOLVED) && !w.text.startsWith('/')) {
      rel = w.text;
      where = '<a folder the guard cannot resolve>/';
      if (rel.split('/').filter(x => x !== '' && x !== '.').length === 0) {
        // `rm -rf "$Y"`: a name that is all variable, as in a known folder
        if (w.unknown && rel.replace(/\//g, '') === '') return undefined;
        return `${where}${rel || '.'} (the folder itself, which may be a project)`;
      }
    } else if (w.unknown && w.tail?.replace(/\//g, '')) {
      rel = (w.tail ?? '').replace(/^\/+/, '');
      where = '<a variable the guard cannot resolve>/';
    } else return undefined;
    const parts = rel.split('/').filter(x => x !== '' && x !== '.');
    if (parts.length === 0) return undefined; // "$X"/. : rm refuses to remove '.'
    const last = parts[parts.length - 1];
    if (last === '..') return `${where}${rel} (which may be any folder)`;
    if (w.glob && /[*?[]/.test(last)) {
      const names =
        parts.length === 1
          ? this.r.names
          : (this.r.childNames.get(parts[parts.length - 2]) ?? new Set());
      if (names.has('*') || [...names].some(n => globMatch(n, last))) {
        return `${where}${rel} (a glob that may match a protected folder there)`;
      }
      return undefined;
    }
    if (this.r.names.has(last)) return `${where}${rel} (which may be the protected '${last}')`;
    return undefined;
  }

  private targetHits(w: Word, cwd: string): string | undefined {
    if (w.alts) {
      for (const [text, glob] of w.alts) {
        const hit = this.targetHits({ text, glob, unknown: w.unknown, tail: w.tail }, cwd);
        if (hit) return hit;
      }
      return undefined;
    }
    if (cwd.includes(UNRESOLVED) && !w.text.startsWith('/')) return this.unresolvedHit(w, cwd);
    if (w.text === '') {
      // A target that is nothing but an unresolved variable could be any name
      // here, so it is refused where a name here would be protected.
      if (w.unknown && this.r.protectedChildren(cwd).length > 0) {
        return joinPath(cwd, '<a variable the guard cannot resolve>');
      }
      return undefined;
    }
    const hit = this.unresolvedHit(w, cwd);
    if (hit) return hit;
    if (!w.glob) {
      for (const p of this.realPaths(this.abs(w.text, cwd), Checker.follows(w.text))) {
        if (this.r.hits(p)) return p;
      }
      return undefined;
    }
    // Judge the first globbed component: `projects/*` -> dir projects, pattern `*`.
    const [directory, pattern] = this.globParts(w.text, cwd);
    for (const d of this.realPaths(directory, true)) {
      // a glob lists the folder through a link
      if (!this.r.hits(d)) continue;
      if (this.r.isProtected(d) && pattern.replace(/[*.]/g, '') === '') return joinPath(d, pattern);
      for (const name of this.r.protectedChildren(d)) {
        if (name === '*' || globMatch(name, pattern)) return joinPath(d, name);
      }
    }
    return undefined;
  }

  /** `a/b/*.md/c` -> [abs folder a/b, first globbed component `*.md`, the rest [c]]. */
  private globParts(text: string, cwd: string): [string, string, string[]] {
    const head = text.split(/[*?[]/)[0];
    let directory: string;
    let parts: string[];
    if (head.includes('/')) {
      const d = head.slice(0, head.lastIndexOf('/'));
      parts = text.slice(d.length + 1).split('/');
      directory = this.abs(d || '/', cwd);
    } else {
      directory = cwd;
      parts = text.split('/');
    }
    return [directory, parts[0], parts.slice(1).filter(x => x)];
  }

  /**
   * A glob deleting every file directly in a protected vault folder
   * (`SecondBrain/Memory/*.md`, `Memory/daily/*`): the folder, else undefined.
   */
  private vaultGlob(w: Word, cwd: string): string | undefined {
    if (w.alts) {
      for (const [text, glob] of w.alts) {
        const hit = this.vaultGlob({ text, glob, unknown: w.unknown }, cwd);
        if (hit) return hit;
      }
      return undefined;
    }
    if (!w.glob || w.unknown || (cwd.includes(UNRESOLVED) && !w.text.startsWith('/')))
      return undefined;
    const [directory, pattern, rest] = this.globParts(w.text, cwd);
    if (![pattern, ...rest].every(matchesEveryNote)) return undefined;
    for (const d of this.realPaths(directory, true)) {
      if (this.r.isProtected(d) && this.r.inVault(d)) return d;
    }
    return undefined;
  }

  private command(
    words: Word[],
    c: Command,
    upstream: Command[],
    cwd: string,
    depth: number,
    scope: Scope,
    stdin: string | undefined,
    dirs: Dirs
  ): Outcome {
    const peeled = this.peel(words, cwd);
    cwd = peeled.cwd;
    if (peeled.split !== undefined) {
      const i = peeled.split;
      const rest = words
        .slice(i + 2)
        .map(w => shellQuote(w.text))
        .join(' ');
      return [this.check(`${words[i + 1].text} ${rest}`, cwd, depth + 1, scope), undefined];
    }
    const xargs = peeled.xargs;
    const rest = words.slice(peeled.i);
    if (rest.length === 0) return [undefined, undefined];
    const name = basename(rest[0].text);
    const args = rest.slice(1);

    if (name === 'cd' || name === 'pushd' || name === 'popd') {
      return [undefined, this.cd(name, args, cwd, dirs)];
    }
    if (scope.funcs.has(name) && !rest[0].text.includes('/')) {
      scope.called.add(name);
      return [
        this.check(scope.funcs.get(name) ?? '', cwd, depth + 1, scope, args, c.vars),
        undefined,
      ];
    }
    if (rest[0].text.includes('/')) {
      // ./x.sh, /tmp/x.sh: a script this command line wrote
      const v = this.runFile(rest[0], cwd, depth, scope, args);
      if (v) return [v, undefined];
    }
    if (SHELLS.has(name)) return [this.shell(args, c, cwd, depth, scope, stdin), undefined];
    if (name === 'source' || name === '.') {
      return [
        args.length > 0
          ? this.runFile(args[0], cwd, depth, scope, args.slice(1), c.vars)
          : undefined,
        undefined,
      ];
    }
    if (name === 'eval') {
      return [
        this.check(args.map(w => w.text).join(' '), cwd, depth + 1, scope, undefined, c.vars),
        undefined,
      ];
    }
    if (name === 'trap') {
      // trap 'commands' SIGNAL: the string runs later, as a command line
      if (args.length > 0 && !args[0].text.startsWith('-')) {
        return [this.check(args[0].text, cwd, depth + 1, scope, undefined, c.vars), undefined];
      }
      return [undefined, undefined];
    }
    if (name === 'rm') return [this.rm(args, cwd, xargs, upstream), undefined];
    if (name === 'mv') return [this.mv(args, cwd), undefined];
    if (name === 'find') return [this.find(args, cwd), undefined];
    if (name === 'rsync') return [this.rsync(args, cwd), undefined];
    if (
      ['dd', 'shred', 'wipefs', 'blkdiscard', 'sgdisk', 'mke2fs', 'mkswap'].includes(name) ||
      name.startsWith('mkfs')
    ) {
      return [this.disk(name, args), undefined];
    }
    if (['docker', 'docker-compose', 'podman', 'stixctl', 'sbx'].includes(name)) {
      const inner = this.execInner(name, args);
      if (inner) {
        // docker exec, docker compose exec, stixctl compose <p> exec, (stixctl) sbx exec:
        // the command inside the container or sandbox is judged; its folder is the
        // container's own.
        const [iwords, icwd] = inner;
        const cmd: Command = { ...newCommand(), words: [...iwords] };
        return [
          this.command(iwords, cmd, [], icwd, depth + 1, scope, undefined, { stack: [] })[0],
          undefined,
        ];
      }
    }
    if (name === 'docker' || name === 'docker-compose' || name === 'podman') {
      return [this.docker(name, args), undefined];
    }
    if (name === 'stixctl' && args.length > 0 && args[0].text === 'compose') {
      return [this.compose(args.slice(2)), undefined];
    }
    if (name === 'git') return [this.git(args, cwd), undefined];
    return [undefined, undefined];
  }

  /**
   * The folder after cd / pushd / popd; `cd -` and `popd` go back to a folder this
   * command line left, and are unresolved only when it left none.
   */
  private cd(name: string, args: Word[], cwd: string, dirs: Dirs): string {
    const operands = args.filter(w => !/^-[LPe@]+$/.test(w.text));
    if (name === 'popd') {
      // popd +N edits the stack; an empty one is the shell's own
      const target =
        operands.length > 0 || dirs.stack.length === 0
          ? UNRESOLVED_CWD
          : (dirs.stack.pop() ?? UNRESOLVED_CWD);
      dirs.old = cwd;
      return target;
    }
    if (name === 'pushd' && operands.length > 0 && /^[+-]\d+$/.test(operands[0].text)) {
      dirs.stack.push(cwd);
      dirs.old = cwd;
      return UNRESOLVED_CWD; // rotates the shell's stack
    }
    if (name === 'pushd' && operands.length === 0) {
      const target = dirs.stack.pop() ?? UNRESOLVED_CWD;
      dirs.stack.push(cwd);
      dirs.old = cwd;
      return target;
    }
    let target: string;
    if (operands.length === 0) target = this.r.home;
    else if (name === 'cd' && operands[0].text === '-') target = dirs.old ?? UNRESOLVED_CWD;
    else target = this.chdir(operands[0], cwd);
    if (name === 'pushd') dirs.stack.push(cwd);
    dirs.old = cwd;
    return target;
  }

  /**
   * [the command, its folder] that docker/podman exec, docker compose exec,
   * `stixctl compose <project> exec [-T] <svc>`, `sbx exec` or `stixctl sbx exec` runs in
   * a container or sandbox; undefined if not exec.
   */
  private execInner(name: string, args: Word[]): [Word[], string] | undefined {
    const t = args.map(w => w.text);
    let k = 0;
    if (name === 'sbx') {
      return t[0] === 'exec' ? this.execArgs(args, 1, DOCKER_EXEC_ARG) : undefined;
    }
    if (name === 'stixctl') {
      // sbx exec's flags match docker exec's (`sbx exec --help`).
      if (t[0] === 'sbx' && t[1] === 'exec') return this.execArgs(args, 2, DOCKER_EXEC_ARG);
      if (t.length >= 3 && t[0] === 'compose' && t[2] === 'exec') {
        return this.execArgs(args, 3, COMPOSE_EXEC_ARG);
      }
      return undefined;
    }
    if (name === 'docker' || name === 'podman') {
      while (k < t.length && t[k].startsWith('-')) k += DOCKER_GLOBAL_ARG.has(t[k]) ? 2 : 1;
      if (t[k] === 'exec') return this.execArgs(args, k + 1, DOCKER_EXEC_ARG);
      if (t[k] !== 'compose') return undefined;
      k++;
    }
    while (k < t.length && t[k].startsWith('-')) k += COMPOSE_GLOBAL_ARG.has(t[k]) ? 2 : 1;
    if (t[k] === 'exec') return this.execArgs(args, k + 1, COMPOSE_EXEC_ARG);
    return undefined;
  }

  private execArgs(args: Word[], k: number, withValue: Set<string>): [Word[], string] | undefined {
    let cwd = UNRESOLVED_CWD; // the container's working folder, which the guard cannot see
    while (k < args.length && args[k].text.startsWith('-')) {
      const t = args[k].text;
      if (t === '--') {
        k++;
        break;
      }
      const eq = t.indexOf('=');
      const opt = eq >= 0 ? t.slice(0, eq) : t;
      const takes = eq < 0 && withValue.has(opt);
      if (opt === '-w' || opt === '--workdir') {
        const word: Word =
          eq >= 0
            ? { text: t.slice(eq + 1), glob: false }
            : (args[k + 1] ?? { text: '', glob: false });
        cwd = word.text.startsWith('/') && !word.unknown ? normPath(word.text) : UNRESOLVED_CWD;
      }
      k += takes ? 2 : 1;
    }
    k++; // the container or service
    if (args[k]?.text === '--') k++; // sbx exec <name> -- <command>
    if (k >= args.length) return undefined;
    return [args.slice(k), cwd];
  }

  /**
   * Skip what runs a command without being it: assignments, sudo/doas, env, nohup,
   * timeout, xargs, busybox ... `split` is the index of an `env -S` whose string is the
   * command.
   */
  private peel(
    words: Word[],
    cwd: string
  ): { i: number; xargs: boolean; cwd: string; split?: number } {
    let xargs = false;
    let i = 0;
    while (i < words.length) {
      const name = basename(words[i].text);
      if (/^[A-Za-z_][A-Za-z0-9_]*=/s.test(words[i].text) || KEYWORDS.has(words[i].text)) {
        i++;
      } else if (name === 'sudo' || name === 'doas') {
        i++;
        while (i < words.length && words[i].text.startsWith('-')) {
          const opt = words[i].text;
          i += ['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '-T'].includes(opt) ? 2 : 1;
          if (opt === '--') break;
        }
      } else if (name === 'env') {
        i++;
        let peeled = false;
        while (i < words.length && !peeled) {
          const t = words[i].text;
          if (t === '-u' || t === '--unset') i += 2;
          else if ((t === '-C' || t === '--chdir') && i + 1 < words.length) {
            cwd = this.chdir(words[i + 1], cwd);
            i += 2;
          } else if ((t === '-S' || t === '--split-string') && i + 1 < words.length) {
            return { i, xargs, cwd, split: i };
          } else if (t.startsWith('-') || t.includes('=')) i++;
          else peeled = true;
        }
      } else if (
        ['nohup', 'time', 'command', 'exec', 'builtin', 'stdbuf', 'unbuffer'].includes(name)
      ) {
        i++;
        while (i < words.length && words[i].text.startsWith('-')) i++;
      } else if (['nice', 'ionice', 'timeout', 'chrt', 'taskset'].includes(name)) {
        i++;
        while (i < words.length && words[i].text.startsWith('-')) {
          i += ['-n', '-c', '-s', '-k', '--signal', '--kill-after'].includes(words[i].text) ? 2 : 1;
        }
        if (['timeout', 'chrt', 'taskset'].includes(name) && i < words.length) i++;
      } else if (name === 'xargs') {
        xargs = true;
        i++;
        while (i < words.length && words[i].text.startsWith('-')) {
          i += ['-n', '-I', '-P', '-d', '-L', '-a', '-s', '-E', '-e'].includes(words[i].text)
            ? 2
            : 1;
        }
      } else if (name === 'busybox' && i + 1 < words.length) {
        i++;
      } else break;
    }
    return { i, xargs, cwd };
  }

  private runFile(
    w: Word,
    cwd: string,
    depth: number,
    scope: Scope,
    argv: Word[],
    inherit?: Vars
  ): Violation | undefined {
    const content = scope.files.get(this.abs(w.text, cwd));
    return content ? this.check(content, cwd, depth + 1, scope, [...argv], inherit) : undefined;
  }

  private shell(
    args: Word[],
    c: Command,
    cwd: string,
    depth: number,
    scope: Scope,
    stdin: string | undefined
  ): Violation | undefined {
    let k = 0;
    let stdinMode = false;
    while (k < args.length) {
      const t = args[k].text;
      if (
        t === '--command' ||
        t === '-command' ||
        (t.startsWith('-') && !t.startsWith('--') && t.slice(1).includes('c'))
      ) {
        if (k + 1 >= args.length) return undefined;
        // bash -c 'script' $0 $1 ...: the words after $0 are the script's arguments
        return this.check(args[k + 1].text, cwd, depth + 1, scope, args.slice(k + 3));
      }
      if (t === '--') {
        k++;
        break;
      }
      if (t.startsWith('--')) {
        k += t === '--rcfile' || t === '--init-file' ? 2 : 1;
        continue;
      }
      if ((t.startsWith('-') || t.startsWith('+')) && t.length > 1) {
        if (t.startsWith('-') && t.slice(1).includes('s')) stdinMode = true;
        // -o pipefail, -euo pipefail, +O opt: the option name is the next word
        k += /[oO]/.test(t.slice(1)) ? 2 : 1;
        continue;
      }
      break;
    }
    if (k < args.length && !stdinMode) {
      return this.runFile(args[k], cwd, depth, scope, args.slice(k + 1)); // bash x.sh a b
    }
    // The script comes on stdin: a heredoc, a here-string, `< file` or a pipe. Its
    // arguments are known with -s (bash -s -- a b); an unquoted heredoc's $1 is the
    // outer shell's, so without -s they stay unknown.
    const argv = stdinMode ? args.slice(k) : undefined;
    const scripts = [...c.heredocs];
    for (const [op, target] of c.redirects) {
      if (op === '<<<') scripts.push(target);
      else if (op === '<') {
        const content = scope.files.get(this.abs(target, cwd));
        if (content) scripts.push(content);
      }
    }
    if (stdin) scripts.push(stdin);
    for (const body of scripts) {
      const v = this.check(body.replace(/\\n/g, '\n'), cwd, depth + 1, scope, argv);
      if (v) return v;
    }
    return undefined;
  }

  private stdinText(
    c: Command,
    stdin: string | undefined,
    cwd: string,
    files: Map<string, string | undefined>
  ): string | undefined {
    if (c.heredocs.length > 0) return c.heredocs[c.heredocs.length - 1] + '\n';
    for (const [op, target] of [...c.redirects].reverse()) {
      if (op === '<<<') return target + '\n';
      if (op === '<') return files.get(this.abs(target, cwd));
    }
    return stdin;
  }

  /**
   * What `c` prints, when it is plain text the guard can know (cat of a heredoc or of
   * a file written earlier, echo, printf, tee). Records the files its redirections and
   * `tee` write, so a later `bash file` is checked.
   */
  private output(
    c: Command,
    stdin: string | undefined,
    cwd: string,
    files: Map<string, string | undefined>
  ): string | undefined {
    const peeled = this.peel(c.words, cwd);
    const words = peeled.split === undefined ? c.words.slice(peeled.i) : [];
    const name = words.length > 0 ? basename(words[0].text) : '';
    const args = words.slice(1);
    let text: string | undefined;
    if (name === 'cat') {
      const operands = args.filter(a => a.text === '-' || !a.text.startsWith('-'));
      if (operands.length === 0) text = this.stdinText(c, stdin, cwd, files);
      else {
        const parts = operands.map(a =>
          a.text === '-' ? this.stdinText(c, stdin, cwd, files) : files.get(this.abs(a.text, cwd))
        );
        text = parts.some(p => p === undefined) ? undefined : parts.join('');
      }
    } else if (name === 'echo') text = echoText(args.map(a => a.text));
    else if (name === 'printf') text = printfText(args.map(a => a.text));
    else if (name === 'tee') {
      text = this.stdinText(c, stdin, cwd, files);
      const append = args.some(a => a.text === '-a' || a.text === '--append');
      for (const a of args) {
        if (!a.text.startsWith('-')) writeFile(files, this.abs(a.text, cwd), text, append);
      }
    }
    let piped = text;
    for (const [op, target, fd] of c.redirects) {
      if (STDOUT_FDS.has(fd) && ['>', '>|', '>>', '>&'].includes(op)) {
        writeFile(files, this.abs(target, cwd), text, op === '>>');
        piped = undefined;
      }
    }
    return piped;
  }

  /**
   * Judge the paths a delete gets from a feed like `find ... | xargs rm -r`: a find
   * (optionally piped through sort/uniq/grep/head/tail) whose printed paths are
   * narrowed by a -name/-path filter and reach nothing protected. Its Violation when
   * the find would reach a protected path; true when narrowed and safe; false when
   * the feed is not such a find (unknown).
   */
  private feedOk(feed: Feed, cwd: string): Violation | boolean {
    let cmds = feed.cmds;
    if (!cmds) {
      if (feed.text === undefined) return false;
      try {
        cmds = new Lexer(feed.text, { ...TEMP_ENV, HOME: this.r.home, PWD: cwd }).run();
      } catch (err) {
        if (err instanceof ParseError) return false;
        throw err;
      }
    }
    if (cmds.length === 0 || cmds.slice(1).some(c => c.sep !== '|' && c.sep !== '|&')) return false;
    const peeled = this.peel(cmds[0].words, cwd);
    const words = cmds[0].words.slice(peeled.i);
    if (peeled.split !== undefined || words.length === 0 || basename(words[0].text) !== 'find') {
      return false;
    }
    for (const c of cmds.slice(1)) {
      const p = this.peel(c.words, cwd);
      if (p.split !== undefined || !narrowsLines(c.words.slice(p.i))) return false;
    }
    const [v, filtered] = this.findCheck(words.slice(1), peeled.cwd, true);
    return v ?? filtered;
  }

  private rm(
    args: Word[],
    cwd: string,
    xargs: boolean,
    upstream: Command[]
  ): Violation | undefined {
    let recursive = false;
    let opts = true;
    const targets: Word[] = [];
    for (const w of args) {
      const t = w.text;
      if (opts && t === '--') opts = false;
      else if (opts && t.startsWith('--')) recursive ||= t === '--recursive';
      else if (opts && t.startsWith('-') && t.length > 1) recursive ||= /[rR]/.test(t);
      else targets.push(w);
    }
    if (!recursive) {
      for (const w of targets) {
        const folder = this.vaultGlob(w, cwd);
        if (folder)
          return this.r.violation('vault-delete', `rm would delete every note in ${folder}`);
      }
      return undefined;
    }
    for (const w of targets) {
      if (w.text === '' && w.unknown && !w.alts && w.feed) {
        const judged = this.feedOk(w.feed, cwd);
        if (judged instanceof Violation) return judged;
        if (judged) continue; // the paths come from a narrowed find that reaches nothing protected
      }
      const hit = this.targetHits(w, cwd);
      if (hit) return this.r.violation('recursive-delete', `rm -r would delete ${hit}`);
    }
    if (xargs) {
      const judged = upstream.length > 0 ? this.feedOk({ cmds: upstream }, cwd) : false;
      if (judged instanceof Violation) return judged;
      if (!judged) {
        return this.r.violation(
          'recursive-delete',
          'xargs rm -r deletes paths the guard cannot see (only a find with a -name/-path filter may feed it)'
        );
      }
    }
    return undefined;
  }

  private mv(args: Word[], cwd: string): Violation | undefined {
    const paths: Word[] = [];
    let targetDir = false;
    let opts = true;
    let skip = false;
    for (const w of args) {
      if (skip) {
        skip = false;
        continue;
      }
      const t = w.text;
      if (opts && t === '--') opts = false;
      else if (opts && (t === '-t' || t === '--target-directory')) {
        targetDir = true;
        skip = true;
      } else if (opts && t.startsWith('--target-directory=')) targetDir = true;
      else if (opts && t.startsWith('-') && t.length > 1) continue;
      else paths.push(w);
    }
    const sources = targetDir ? paths : paths.slice(0, -1);
    for (const w of sources) {
      const hit = this.targetHits(w, cwd);
      if (hit) return this.r.violation('move-protected', `mv would move ${hit}`);
    }
    return undefined;
  }

  private find(args: Word[], cwd: string): Violation | undefined {
    return this.findCheck(args, cwd)[0];
  }

  /**
   * A find that deletes (-delete, -exec rm), or with `feed` one whose printed paths
   * are deleted (`find | xargs rm -r`). Each delete is judged by the filters that
   * must match for it to run: those before it in its -a chain, not negated, not in an
   * earlier -o branch (`find . -delete -name x` deletes everything, so does `find .
   * -path ./node_modules -prune -o -delete`). Returns [the violation, whether every
   * delete is narrowed by a -name/-path filter].
   */
  private findCheck(args: Word[], cwd: string, feed = false): [Violation | undefined, boolean] {
    let k = 0;
    let follow = false;
    while (
      k < args.length &&
      (['-H', '-L', '-P', '-D'].includes(args[k].text) || /^-O\d*$/.test(args[k].text))
    ) {
      if (args[k].text === '-H' || args[k].text === '-L') follow = true;
      k += args[k].text === '-D' ? 2 : 1;
    }
    const roots: Word[] = [];
    while (
      k < args.length &&
      !(args[k].text.startsWith('-') || ['(', '!', ')'].includes(args[k].text))
    ) {
      roots.push(args[k]);
      k++;
    }
    const actions = findActions(
      args.slice(k).map(w => w.text),
      feed
    );
    if (actions.length === 0) return [undefined, false];
    const searched: Word[] = roots.length > 0 ? roots : [{ text: '.', glob: false }];
    const rootTexts = searched.map(w => w.text);
    let allFiltered = true;
    for (const [, recursive, dnf] of actions) {
      const narrowed = dnf.map(conj => conj.filter(f => !matchesAll(f, rootTexts)));
      const filtered = narrowed.length > 0 && narrowed.every(conj => conj.length > 0);
      allFiltered &&= filtered;
      for (const w of searched) {
        const p = this.abs(w.text, cwd);
        if (!p.includes(UNRESOLVED)) {
          for (const q of this.realPaths(p, follow || Checker.follows(w.text))) {
            const v = this.findRoot(q, w.text, narrowed, filtered, recursive || feed);
            if (v) return [v, false];
          }
        }
        if (!filtered && (w.unknown || p.includes(UNRESOLVED))) {
          const hit = w.text || cwd.includes(UNRESOLVED) ? this.targetHits(w, cwd) : undefined;
          if (hit && hit !== p) {
            return [
              this.r.violation('recursive-delete', `find would delete everything under ${hit}`),
              false,
            ];
          }
        }
      }
    }
    return [undefined, allFiltered];
  }

  private findRoot(
    p: string,
    rootText: string,
    narrowed: Dnf,
    filtered: boolean,
    recursive: boolean
  ): Violation | undefined {
    if (this.r.aboveSystem(p) || (this.r.hits(p) && !filtered)) {
      return this.r.violation(
        'recursive-delete',
        `find would delete under ${p}` +
          (filtered ? '' : ' with no -name/-path filter that narrows it')
      );
    }
    if (!this.r.hits(p)) return undefined;
    if (this.deletesNotes(p, rootText, narrowed)) {
      return this.r.violation(
        'recursive-delete',
        `find would delete the vault's notes under ${p} (its filter matches *.md files; the vault is not in git)`
      );
    }
    const hit = this.findReaches(p, rootText, narrowed, recursive);
    if (hit)
      return this.r.violation(
        'recursive-delete',
        `find would delete ${hit} (its filter matches it)`
      );
    return undefined;
  }

  /**
   * A protected path under the find root that a narrowed delete still matches: by
   * name or path for a recursive delete (`-name .git -exec rm -rf`), or all of its
   * contents for any delete (`-path './.git/*' -delete`).
   */
  private findReaches(
    p: string,
    rootText: string,
    narrowed: Dnf,
    recursive: boolean
  ): string | undefined {
    const base = rootText.replace(/\/+$/, '') || (rootText.startsWith('/') ? '/' : '.');
    // The root itself last, so a match inside it (.git) is the one named.
    const entries = this.r.protectedUnder(p).sort((a, b) => Number(a === p) - Number(b === p));
    for (const q of entries) {
      const rel = q !== p ? q.slice(p.length).replace(/^\/+/, '') : '';
      const printed = rel ? `${base.replace(/\/+$/, '')}/${rel}` : base;
      const name = basename(printed) || printed;
      const child = `${printed.replace(/\/+$/, '')}/\x01`;
      for (const conj of narrowed) {
        if (conj.length === 0) continue;
        if (recursive && conj.every(f => findMatch(f, name, printed))) return q;
        if (conj.every(f => findMatch(f, '\x01', child))) return `${q}/* (everything in it)`;
      }
    }
    return undefined;
  }

  /**
   * A find rooted at, in or above a vault whose filters can match its notes
   * (`-name '*.md'`, `-name '2026-*.md'`, `-iname '*.MD'`).
   */
  private deletesNotes(p: string, rootText: string, narrowed: Dnf): boolean {
    const printed: string[] = []; // the vault's path as this find prints it
    const base = rootText.replace(/\/+$/, '') || '/';
    for (const v of this.r.vaults) {
      const pre = p.replace(/\/+$/, '');
      if (v === p || v.startsWith(pre + '/')) {
        const rel = v.slice(pre.length).replace(/^\/+/, '');
        printed.push(rel ? `${base.replace(/\/+$/, '')}/${rel}` : base);
      } else if (p.startsWith(v + '/')) printed.push(base);
    }
    if (printed.length === 0) return false;
    const can = ([kind, pattern]: FindFilter): boolean => {
      if (kind === '-regex' || kind === '-iregex') return true; // cannot tell; the user's to run
      if (!/[*?[]/.test(pattern)) return false; // one named file, not the notes
      const folded = kind.startsWith('-i');
      const pat = folded ? pattern.toLowerCase() : pattern;
      if (FIND_PATH_FILTERS.has(kind)) {
        const literal = pat.split(/[*?[]/)[0];
        const fits = printed.some(x => {
          const y = folded ? x.toLowerCase() : x;
          return literal.startsWith(y) || y.startsWith(literal);
        });
        if (!fits) return false;
      }
      return globCanEndWith(pat, '.md');
    };
    return narrowed.some(conj => conj.length > 0 && conj.every(can));
  }

  private rsync(args: Word[], cwd: string): Violation | undefined {
    let deleting = false;
    let opts = true;
    const paths: Word[] = [];
    for (let k = 0; k < args.length; k++) {
      const t = args[k].text;
      if (opts && t === '--') opts = false;
      else if (opts && t.startsWith('--')) {
        const opt = t.split('=')[0];
        if (opt.startsWith('--del')) deleting = true; // --del, --delete, --delete-after, ...
        if (!t.includes('=') && RSYNC_ARG.has(opt)) k++;
      } else if (opts && t.startsWith('-') && t.length > 1) {
        for (let n = 1; n < t.length; n++) {
          if (RSYNC_SHORT_ARG.includes(t[n])) {
            if (n === t.length - 1) k++; // its value is the next word
            break;
          }
        }
      } else paths.push(args[k]);
    }
    if (!deleting || paths.length < 2) return undefined;
    const dest = paths[paths.length - 1];
    if (/^[^/]*:/.test(dest.text) || dest.text.startsWith('rsync://')) return undefined; // remote
    for (const src of paths.slice(0, -1)) {
      const s = src.text;
      // `src/` (or `.`) syncs the folder's contents into dest itself; `src` syncs into
      // dest/src, and only that folder is pruned.
      const contents =
        s === '' ||
        s.endsWith('/') ||
        s === '.' ||
        s === '..' ||
        s.endsWith('/.') ||
        s.endsWith('/..');
      const eff: Word = contents
        ? {
            text: dest.text,
            glob: dest.glob,
            unknown: dest.unknown,
            alts: dest.alts,
            tail: dest.tail,
          }
        : {
            text: `${dest.text.replace(/\/+$/, '')}/${basename(s.replace(/\/+$/, ''))}`,
            glob: src.glob || dest.glob,
            unknown: dest.unknown || src.unknown,
            tail: dest.tail,
          };
      const hit = this.targetHits(eff, cwd);
      if (hit) {
        return this.r.violation(
          'recursive-delete',
          `rsync --delete into ${hit} deletes everything there that the source lacks`
        );
      }
    }
    return undefined;
  }

  private disk(name: string, args: Word[]): Violation | undefined {
    const texts = args.map(w => w.text);
    if (name === 'dd') {
      for (const t of texts) {
        if (t.startsWith('of=') && DEVICE.test(t.slice(3))) {
          return this.r.violation('disk-wipe', `dd writes to the disk device ${t.slice(3)}`);
        }
      }
      return undefined;
    }
    if (
      name === 'sgdisk' &&
      !texts.some(t => ['-Z', '--zap-all', '--zap', '-z', '-o', '--clear'].includes(t))
    ) {
      return undefined;
    }
    for (const t of texts) {
      if (DEVICE.test(t)) return this.r.violation('disk-wipe', `${name} on the disk device ${t}`);
    }
    return undefined;
  }

  private docker(name: string, args: Word[]): Violation | undefined {
    const texts = args.map(w => w.text);
    if (name === 'docker-compose') return this.compose(args);
    let k = 0;
    while (k < texts.length && texts[k].startsWith('-')) {
      k += DOCKER_GLOBAL_ARG.has(texts[k]) ? 2 : 1;
    }
    if (k >= texts.length) return undefined;
    const sub = texts[k];
    const rest = texts.slice(k + 1);
    if (sub === 'compose') return this.compose(args.slice(k + 1));
    if (sub === 'volume' && rest.length > 0 && ['rm', 'remove', 'prune'].includes(rest[0])) {
      return this.r.violation(
        'docker-volume-delete',
        `docker volume ${rest[0]} deletes volume data`
      );
    }
    if (sub === 'system' && rest[0] === 'prune' && rest.includes('--volumes')) {
      return this.r.violation(
        'docker-volume-delete',
        'docker system prune --volumes deletes volume data'
      );
    }
    return undefined;
  }

  private compose(args: Word[]): Violation | undefined {
    const texts = args.map(w => w.text);
    const at = texts.indexOf('down');
    if (at < 0) return undefined;
    const after = texts.slice(at + 1);
    if (after.includes('--volumes') || after.some(t => /^-[a-zA-Z]*v[a-zA-Z]*$/.test(t))) {
      return this.r.violation(
        'docker-volume-delete',
        "compose down -v deletes the stack's volumes"
      );
    }
    return undefined;
  }

  private git(args: Word[], cwd: string): Violation | undefined {
    const texts = args.map(w => w.text);
    let k = 0;
    // --git-dir / --work-tree name another repo than the folder's: its branch is not read.
    let repoCwd = true;
    while (k < texts.length && texts[k].startsWith('-')) {
      if (texts[k] === '-C' && k + 1 < texts.length) {
        cwd = this.chdir(args[k + 1], cwd);
        k += 2;
      } else if (['-c', '--git-dir', '--work-tree', '--namespace'].includes(texts[k])) {
        if (texts[k] === '--git-dir' || texts[k] === '--work-tree') repoCwd = false;
        k += 2;
      } else {
        if (/^--(git-dir|work-tree)=/.test(texts[k])) repoCwd = false;
        k++;
      }
    }
    if (texts[k] === 'push')
      return this.forcePush(args.slice(k + 1), repoCwd ? cwd : UNRESOLVED_CWD);
    if (k >= texts.length || texts[k] !== 'clean') return undefined;
    const longs = texts.slice(k + 1);
    const flags = longs.filter(t => t.startsWith('-') && !t.startsWith('--'));
    const dry = longs.includes('--dry-run') || flags.some(f => f.slice(1).includes('n'));
    const force = longs.includes('--force') || flags.some(f => f.slice(1).includes('f'));
    const ignored = flags.some(f => /[xX]/.test(f.slice(1)));
    if (!(force && ignored && !dry)) return undefined;
    if (cwd.includes(UNRESOLVED)) {
      return this.r.violation(
        'git-wipe',
        'git clean -x runs in a folder the guard cannot resolve, which may be a project, and deletes its ignored data (databases, .venv, secret links)'
      );
    }
    for (const p of this.realPaths(cwd, true)) {
      if (this.r.inProject(p)) {
        return this.r.violation(
          'git-wipe',
          `git clean -x in ${p} deletes ignored data (databases, .venv, secret links)`
        );
      }
    }
    return undefined;
  }

  /**
   * Archon's force-push rule (force-push-default-branch): a forced push is refused when
   * a ref it forces is the default branch (force_push.default_branches or the remote's
   * HEAD) or cannot be named; any other branch (archon/thread-*, a rebased feature
   * branch) passes. Stixed's own guard refuses every force-push (rule force-push).
   */
  private forcePush(words: Word[], cwd: string): Violation | undefined {
    const spec = this.r.forcePush;
    const p = parsePush(words, spec);
    if (p.dryRun) return undefined;
    const plus = spec.refspec_force_prefix;
    const [repoWord, ...refspecs] = p.positionals;
    const forced = p.force ? refspecs : refspecs.filter(w => w.text.startsWith(plus));
    if (!p.force && forced.length === 0 && !repoWord?.text.startsWith(plus)) return undefined;
    const rule = 'force-push-default-branch';
    const how = p.force ?? forced[0]?.text ?? repoWord.text;
    const unnamed = (why: string): Violation =>
      this.r.violation(
        rule,
        `git push ${how}: the guard cannot tell which branch it overwrites (${why})`
      );
    if (p.force && p.every) {
      const flags = p.force === p.every ? p.every : `${p.every} ${p.force}`;
      return this.r.violation(
        rule,
        `git push ${flags} force-updates every branch or tag, the default branch among them`
      );
    }
    if (repoWord?.text.startsWith(plus))
      return unnamed(`${repoWord.text} stands where the remote goes`);
    const repo = gitRepoAt(cwd);
    const defaults = new Set(spec.default_branches);
    const remote = repoWord && !repoWord.unknown ? repoWord.text : 'origin';
    const head = repo ? remoteHead(repo, remote) : undefined;
    if (head) defaults.add(head);
    const targets: string[] = [];
    for (const t of forced.length > 0
      ? forced.map(w => refspecTargets(w, plus, repo))
      : [currentTargets(repo)]) {
      if (typeof t === 'string') return unnamed(t);
      targets.push(...t);
    }
    const hit = targets.find(t => defaults.has(t));
    if (hit)
      return this.r.violation(
        rule,
        `git push ${how} force-updates ${hit}, the repo's default branch`
      );
    return undefined;
  }
}

// ---------------------------------------------------------------- entry points

/** Where the rules come from; see the file header for the order. */
export function resolveRulesPath(
  env: Record<string, string | undefined> = process.env,
  rootOwned: string = ROOT_OWNED_RULES_PATH
): string | undefined {
  const configured = env[RULES_ENV];
  if (configured) return configured;
  // Missing (the VM, or a container without the mount): the built-in strict rules.
  return existsSync(rootOwned) ? rootOwned : undefined;
}

let cached: { key: string; checker: Checker } | undefined;

let cachedLog: ReturnType<typeof createLogger> | undefined;
/**
 * A command the guard could not read is allowed (bash rejects it too) and recorded
 * as a log-only entry, so a gap in the parser shows up in the logs, not as a refusal.
 */
const logUnparsed: LogOnly = entry => {
  cachedLog ??= createLogger('provider.destructive-guard');
  cachedLog.warn(
    { command: entry.command.slice(0, 2000), cwd: entry.cwd, reason: entry.reason },
    'destructive_guard.unparsed_allowed_log_only'
  );
};

/** Which rules file to use; `rulesPath: null` means the built-in DEFAULT_RULES. */
export interface CheckOptions {
  /**
   * The rules file, decided by the caller (the CLI hook dispatcher passes the one
   * the Archon server resolved, so the CLI's own environment cannot change it).
   * Omitted: resolved from this process's environment (resolveRulesPath).
   */
  rulesPath?: string | null;
}

function loadChecker(path: string | undefined): Checker | Violation {
  let key = path ?? '<default>';
  try {
    // The file's mtime is part of the key, so an edited rules file is reloaded.
    if (path) key = `${path}@${statSync(path).mtimeMs}`;
    if (cached?.key === key) return cached.checker;
    const data = path
      ? (JSON.parse(readFileSync(path, 'utf8')) as DestructiveRulesFile)
      : DEFAULT_RULES;
    const checker = new Checker(new Rules(data), logUnparsed);
    cached = { key, checker };
    return checker;
  } catch (err) {
    // Not cached: the next check retries, so a fixed file takes effect at once.
    return new Violation(
      'rules-unreadable',
      `the rules file ${path} could not be loaded (${(err as Error).message}), so no shell command is allowed`,
      `fix ${path} (named by ${RULES_ENV}, or Stixed's promoted copy at ${ROOT_OWNED_RULES_PATH})`
    );
  }
}

/**
 * Check one shell command run from `cwd`. Returns the rule it breaks, or undefined.
 * A configured rules file that cannot be loaded, or a fault in the guard itself,
 * yields a violation: the guard never waves a command through because it failed.
 */
export function checkCommand(
  command: string,
  cwd: string,
  options: CheckOptions = {}
): Violation | undefined {
  const path =
    options.rulesPath === undefined ? resolveRulesPath() : (options.rulesPath ?? undefined);
  const checker = loadChecker(path);
  if (checker instanceof Violation) return checker;
  try {
    return checker.check(command, normPath(cwd));
  } catch (err) {
    return new Violation(
      'guard-error',
      `the destructive-command guard failed on this command (${(err as Error).message})`,
      'Rewrite the command more simply, or split it into separate commands.'
    );
  }
}

/** Test hook: forget the cached rules so the next check reloads them. */
export function resetDestructiveGuardCache(): void {
  cached = undefined;
}

/**
 * The system message a provider without a shell hook point (Pi, OpenCode) shows on
 * a workflow node, so the gap in the guard is explicit rather than silent.
 */
export function guardGapNotice(provider: string): string {
  return `⚠️ Archon's destructive-command guard does not cover ${provider}'s shell tool (no hook point): a destructive command from this node is not refused. Run nodes that need the guard on Claude, Codex or Grok.`;
}
