/**
 * Destructive-command guard for every provider's shell tool.
 *
 * Why this exists: an agent can, by mistake, run a shell command that destroys
 * something no git remote brings back -- a recursive delete or move of a project,
 * the folder that holds the projects, a system root; a disk wipe; `docker volume rm`;
 * `git clean -x` inside a project. This refuses those commands before they run, for
 * Claude (a PreToolUse hook, claude/destructive-guard-hook.ts), Codex and Grok
 * (shared/cli-hooks/hook-dispatcher.ts) and Copilot (its shell permission request).
 * Pi and OpenCode run their shell tools with no Archon hook point, so they are NOT
 * covered: their workflow nodes say so in a system message (GUARD_GAP_NOTICE).
 *
 * The rules are data. Resolution order:
 *   1. ARCHON_DESTRUCTIVE_RULES, a path to a rules JSON file;
 *   2. <ARCHON_HOME>/destructive-rules.json, if present;
 *   3. DEFAULT_RULES below (system roots only).
 * A configured file that cannot be read or parsed makes every check refuse: a guard
 * that cannot decide must not wave a command through.
 *
 * This is a TypeScript port of a Python guard that shares the same rules file and the
 * same test list (destructive_cases.json); both must pass every case. It reads command
 * TEXT, parsed the way a shell would, so quoted text (`grep "rm -rf /"`, commit
 * messages, heredoc bodies) is never mistaken for a command, while `sudo`, `bash -c`,
 * `$(...)` and `cd a && rm -rf b` are seen through. Threat model: mistakes, not a
 * hostile agent -- writing a script and running it gets past any text check.
 *
 * Where this port is stricter than the Python guard (security review 2026-10):
 * - a command it cannot parse is searched as raw text, and refused when it holds a
 *   command the rules cover (`unparsed-destructive`); the guard throwing refuses too;
 * - a recursive delete (rm -r, unfiltered find -delete, git clean -x) of a path, or
 *   from a `cd`, that holds an expansion it cannot resolve is refused
 *   (`unresolved-path`), unless the path ends in a build folder (node_modules,
 *   dist, .venv ...). $TMPDIR/$TMP/$TEMP and mktemp resolve to a temp path.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getArchonHome } from '@archon/paths/archon-paths';

export const RULES_ENV = 'ARCHON_DESTRUCTIVE_RULES';
export const RULES_FILE_NAME = 'destructive-rules.json';

/** The rules file's shape (only the fields the guard reads). */
export interface DestructiveRulesFile {
  protected_paths: string[];
  project_parent?: string | null;
  protected_children_of?: string[];
  rules: { id: string; instead: string }[];
}

/** Used when no rules file is configured: system roots and the home folder only. */
export const DEFAULT_RULES: DestructiveRulesFile = {
  protected_paths: ['/etc', '/usr', '/boot', '/var/lib/docker', '~'],
  project_parent: null,
  rules: [
    { id: 'recursive-delete', instead: 'Delete the specific subfolder you meant, not its parent.' },
    { id: 'move-protected', instead: 'Ask the user to move it.' },
    { id: 'disk-wipe', instead: "Disk and partition work is the user's to do by hand." },
    {
      id: 'docker-volume-delete',
      instead: 'Use `docker compose down` without -v; volumes hold databases.',
    },
    {
      id: 'git-wipe',
      instead: 'Remove the specific ignored folder you meant, or use git clean -fd.',
    },
  ],
};

export class Violation {
  constructor(
    readonly rule: string,
    readonly reason: string,
    readonly instead: string
  ) {}

  message(): string {
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

export class Rules {
  readonly home: string;
  readonly protectedPaths: string[];
  readonly projectParent: string | null;
  readonly childrenOf: string[];
  /** Protected paths outside the projects folder, plus the projects folder itself. */
  readonly system: string[];
  private readonly instead: Map<string, string>;

  constructor(data: DestructiveRulesFile, home: string = homedir()) {
    this.home = home;
    this.protectedPaths = data.protected_paths.map(p => normPath(p === '~' ? home : p));
    this.projectParent = data.project_parent ? normPath(data.project_parent) : null;
    this.childrenOf = (data.protected_children_of ?? []).map(normPath);
    const pp = this.projectParent;
    this.system = this.protectedPaths.filter(p => !pp || !p.startsWith(pp + '/'));
    this.instead = new Map(data.rules.map(r => [r.id, r.instead]));
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
    return new Violation(rule, reason, this.instead.get(rule) ?? 'ask the user');
  }
}

// ---------------------------------------------------------------- lexer

interface Word {
  text: string;
  /** Contains an unquoted * ? [ */
  glob: boolean;
  /** An expansion in it could not be resolved. */
  unknown?: boolean;
  /** [text, glob] per loop value, when a loop variable is in it. */
  alts?: [string, boolean][];
}

interface Command {
  words: Word[];
  redirects: [string, string][];
  heredocs: string[];
  /** The operator that preceded this command. */
  sep: string;
  /** $(...) and backtick bodies. */
  subs: string[];
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

/**
 * A small POSIX-shell reader. It never executes anything.
 *
 * Variables are followed in order: `NAME=value` (alone or after export/local/...)
 * sets NAME for the commands after it, `for NAME in a b` gives NAME each listed
 * value, and `read NAME` makes it unknown. A word holding an expansion that cannot
 * be resolved is marked `unknown`, so a delete of it can be judged as "anything".
 */
class Lexer {
  private i = 0;
  private readonly cmds: Command[] = [];
  private cur: Command = newCommand();
  private pendingHeredocs: [string, boolean, Command][] = [];
  private readonly loops = new Map<string, [string, boolean][]>();
  private readonly unknownNames = new Set<string>();
  private unk = false;

  constructor(
    private s: string,
    private readonly env: Record<string, string>
  ) {}

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
      } else if (this.redirect()) {
        // consumed
      } else if (this.operator()) {
        // consumed
      } else {
        const w = this.word();
        if (w) this.cur.words.push(w);
      }
    }
    this.end('');
    return this.cmds;
  }

  private end(op: string): void {
    if (this.cur.words.length > 0 || this.cur.redirects.length > 0) {
      this.bind(this.cur.words);
      this.cmds.push(this.cur);
    }
    this.cur = newCommand(op);
  }

  private setVar(name: string, value: string, unknown: boolean): void {
    this.loops.delete(name);
    this.env[name] = value;
    if (unknown) this.unknownNames.add(name);
    else this.unknownNames.delete(name);
  }

  /** Record what a finished command does to variables used after it. */
  private bind(all: Word[]): void {
    let k = 0;
    while (k < all.length && KEYWORDS.has(all[k].text)) k++;
    let words = all.slice(k);
    if (words.length === 0) return;
    const head = words[0].text;
    if ((head === 'for' || head === 'select') && words.length >= 2 && NAME.test(words[1].text)) {
      const name = words[1].text;
      const values = words.length >= 3 && words[2].text === 'in' ? words.slice(3) : [];
      if (values.length > 0 && !values.some(w => w.unknown || w.alts)) {
        this.setVar(name, '', false);
        this.loops.set(
          name,
          values.slice(0, MAX_ALTS).map(w => [w.text, w.glob] as [string, boolean])
        );
      } else {
        this.setVar(name, '', true);
      }
      return;
    }
    if (head === 'read') {
      for (const w of words.slice(1)) if (NAME.test(w.text)) this.setVar(w.text, '', true);
      return;
    }
    if (DECLARE.has(head)) words = words.slice(1).filter(w => !w.text.startsWith('-'));
    if (words.length > 0 && words.every(w => ASSIGN.test(w.text))) {
      for (const w of words) {
        const m = ASSIGN.exec(w.text);
        if (m) this.setVar(m[1], m[2], Boolean(w.unknown || w.alts));
      }
    }
  }

  private operator(): boolean {
    for (let op of OPS) {
      if (this.s.startsWith(op, this.i)) {
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
    const op = m[2];
    this.i = REDIRECT.lastIndex;
    while (this.i < this.s.length && (this.s[this.i] === ' ' || this.s[this.i] === '\t')) this.i++;
    if (op === '<<' || op === '<<-') {
      const w = this.word();
      this.pendingHeredocs.push([w ? w.text : '', op === '<<-', this.cur]);
      return true;
    }
    const w = this.word();
    if (!w) throw new ParseError('redirect without target');
    if ((op === '>&' || op === '<&') && /^(\d+|-)$/.test(w.text)) return true;
    this.cur.redirects.push([op, w.text]);
    return true;
  }

  private readHeredocs(): void {
    const lines = this.s.slice(this.i).split('\n');
    let consumed = 0;
    for (const [delim, stripTabs, cmd] of this.pendingHeredocs) {
      const body: string[] = [];
      while (consumed < lines.length) {
        const line = lines[consumed];
        consumed++;
        if ((stripTabs ? line.replace(/^\t+/, '') : line) === delim) break;
        body.push(line);
      }
      cmd.heredocs.push(body.join('\n'));
    }
    this.pendingHeredocs = [];
    const skip = lines.slice(0, consumed).reduce((n, l) => n + l.length + 1, 0);
    this.i = Math.min(this.s.length, this.i + skip);
  }

  private word(): Word | undefined {
    const s = this.s;
    const out: string[] = [];
    let glob = false;
    let started = false;
    this.unk = false;
    if (s.startsWith('~', this.i)) {
      const j = this.i + 1;
      if (j === s.length || '/ \t\n;&|)'.includes(s[j])) {
        out.push(this.env.HOME ?? '');
        this.i = j;
        started = true;
      }
    }
    while (this.i < s.length) {
      let c = s[this.i];
      if (' \t\n;&|()<>'.includes(c)) break;
      started = true;
      if (c === '\\') {
        if (this.i + 1 < s.length) out.push(s[this.i + 1]);
        this.i += 2;
      } else if (c === "'") {
        const end = s.indexOf("'", this.i + 1);
        if (end < 0) throw new ParseError("unbalanced '");
        out.push(s.slice(this.i + 1, end));
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
            out.push(s[this.i + 1]);
            this.i += 2;
          } else if (c === '$' || c === '`') {
            out.push(this.expansion());
          } else {
            out.push(c);
            this.i++;
          }
        }
      } else if (c === '$' && s[this.i + 1] === "'") {
        // $'...' (ANSI-C quoting): `rm -rf $'/etc'` is `rm -rf /etc`
        const [text, next] = skipAnsiC(s, this.i + 1);
        out.push(text);
        this.i = next;
      } else if (c === '$' && s[this.i + 1] === '"') {
        this.i++; // $"..." (locale quoting) reads as "..."
      } else if (c === '$' || c === '`') {
        out.push(this.expansion());
      } else {
        if (c === '*' || c === '?' || c === '[') glob = true;
        out.push(c);
        this.i++;
      }
    }
    if (!started) return undefined;
    const text = out.join('');
    if (!text.includes('\uE000')) return { text, glob, unknown: this.unk };
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
    return { text: alts[0][0], glob: alts[0][1], unknown: this.unk, alts };
  }

  private variable(name: string): string {
    if (this.loops.has(name)) return `\uE000${name}\uE000`;
    const own = Object.hasOwn(this.env, name);
    if (!own || this.unknownNames.has(name)) this.unk = true;
    return own ? this.env[name] : '';
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
        // An unset name may still be set in the environment the shell runs in.
        if (!known) this.unk = true;
        if (!own) return fallback;
        return val || (op[1].startsWith(':') ? fallback : val);
      }
      if (!known) this.unk = true;
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
      this.i++;
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
    return '';
  }
}

// ---------------------------------------------------------------- checks

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'ash', 'mksh']);
const MAX_DEPTH = 8;
/** Marks a directory the guard could not resolve (`cd "$X"`); never a real path. */
const UNRESOLVED = '\uE001';
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
/** Folder names a recursive delete may target even through an unresolved path. */
const DISPOSABLE = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  '.venv',
  'venv',
  'target',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.parcel-cache',
]);

/**
 * Used when the command cannot be parsed (or nests too deep): the raw text is
 * searched for the commands the rules cover. A match is refused, since the guard
 * cannot tell whether it runs; anything else is allowed (the shell would most
 * likely reject a command this guard cannot read).
 */
const RAW_DESTRUCTIVE: [RegExp, string][] = [
  [/\brm\b[^;&|\n]*\s(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(?=\s|$)/, 'a recursive rm'],
  [/\bfind\b[^\n]*\s(?:-delete\b|-(?:exec|execdir|ok|okdir)\s+\S*\brm\b)/, 'a find that deletes'],
  [/\bgit\b[^\n]*\bclean\b[^;&|\n]*\s-[a-zA-Z]*[xXf]/, 'git clean'],
  [/\b(?:mkfs[.\w]*|wipefs|blkdiscard|shred|sgdisk)\b/, 'a disk tool'],
  [/\bdd\b[^\n]*\bof=\/dev\//, 'dd onto a device'],
  [
    />\s*\/dev\/(?:sd|hd|vd|xvd|nvme|mmcblk|md|dm-|loop|mapper\/|disk\/)/,
    'a write to a disk device',
  ],
  [/\bvolume\s+(?:rm|remove|prune)\b/, 'a docker volume delete'],
  [/\bdown\b[^;&|\n]*\s(?:-[a-zA-Z]*v[a-zA-Z]*|--volumes)(?=\s|$)/, 'compose down -v'],
  [/\bsystem\s+prune\b[^\n]*--volumes/, 'docker system prune --volumes'],
];

function rawScan(cmd: string, why: string): Violation | undefined {
  for (const [re, what] of RAW_DESTRUCTIVE) {
    if (re.test(cmd)) {
      return new Violation(
        'unparsed-destructive',
        `the guard could not parse this command (${why}) and it contains ${what}`,
        'Rewrite it more simply: balanced quotes, no heredoc inside $(...), one destructive command per call (write long text such as a commit message to a file first).'
      );
    }
  }
  return undefined;
}
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

type Outcome = [Violation | undefined, string | undefined];

export class Checker {
  constructor(private readonly r: Rules) {}

  check(cmd: string, cwd: string, depth = 0): Violation | undefined {
    if (cmd.trim() === '') return undefined;
    if (depth > MAX_DEPTH) return rawScan(cmd, `nested more than ${MAX_DEPTH} levels deep`);
    const env: Record<string, string> = { ...TEMP_ENV, HOME: this.r.home, PWD: cwd };
    let cmds: Command[];
    try {
      cmds = new Lexer(cmd, env).run();
    } catch (err) {
      if (err instanceof ParseError) return rawScan(cmd, err.message);
      throw err;
    }
    let prev: Command | undefined;
    for (const c of cmds) {
      env.PWD = cwd;
      for (const body of c.subs) {
        const v = this.check(body, cwd, depth + 1);
        if (v) return v;
      }
      for (const [op, target] of c.redirects) {
        if (['>', '>>', '>|', '<>'].includes(op) && DEVICE.test(target)) {
          return this.r.violation('disk-wipe', `writes to the disk device ${target}`);
        }
      }
      const [v, newCwd] = this.command(c.words, c, prev, cwd, depth);
      if (v) return v;
      if (newCwd !== undefined) cwd = newCwd;
      prev = c;
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

  /** A path holding an expansion the guard could not resolve (target or effective cwd). */
  private unresolved(w: Word, cwd: string): boolean {
    if (w.unknown || w.text.includes(UNRESOLVED)) return true;
    return !w.text.startsWith('/') && cwd.includes(UNRESOLVED);
  }

  /**
   * Refuse a recursive delete of a path the guard cannot resolve, unless its last
   * component is plainly a disposable build folder (node_modules, dist, .venv ...).
   */
  private unresolvedDelete(w: Word, cwd: string, what: string): Violation | undefined {
    if (!this.unresolved(w, cwd)) return undefined;
    const name = basename(w.text.replace(/\/+$/, ''));
    if (!w.glob && !w.alts && DISPOSABLE.has(name) && !w.text.split('/').includes('..')) {
      return undefined;
    }
    const shown = w.text.includes(UNRESOLVED) || w.text === '' ? 'an unresolved path' : w.text;
    return new Violation(
      'unresolved-path',
      `${what} ${shown}, which holds a variable, $(...) or cd the guard cannot resolve (it could be any folder, a project included)`,
      'Write the path out literally: resolve the variable first (printf \'%s\\n\' "$X"), then run the delete on the printed path. Temp dirs ($TMPDIR, mktemp) and build folders (node_modules, dist, .venv, build) are fine as they are.'
    );
  }

  private targetHits(w: Word, cwd: string): string | undefined {
    if (w.alts) {
      for (const [text, glob] of w.alts) {
        const hit = this.targetHits({ text, glob, unknown: w.unknown }, cwd);
        if (hit) return hit;
      }
      return undefined;
    }
    if (w.text === '') {
      // A target that is nothing but an unresolved variable could be any name
      // here, so it is refused where a name here would be protected.
      if (w.unknown && this.r.protectedChildren(cwd).length > 0) {
        return joinPath(cwd, '<a variable the guard cannot resolve>');
      }
      return undefined;
    }
    if (!w.glob) {
      const p = this.abs(w.text, cwd);
      return this.r.hits(p) ? p : undefined;
    }
    // Judge the first globbed component: `projects/*` -> dir projects, pattern `*`.
    const head = w.text.split(/[*?[]/)[0];
    let directory: string;
    let pattern: string;
    if (head.includes('/')) {
      const d = head.slice(0, head.lastIndexOf('/'));
      pattern = w.text.slice(d.length + 1).split('/')[0];
      directory = this.abs(d || '/', cwd);
    } else {
      directory = cwd;
      pattern = w.text.split('/')[0];
    }
    if (!this.r.hits(directory)) return undefined;
    if (this.r.isProtected(directory) && pattern.replace(/[*.]/g, '') === '') {
      return joinPath(directory, pattern);
    }
    for (const name of this.r.protectedChildren(directory)) {
      if (name === '*' || globMatch(name, pattern)) return joinPath(directory, name);
    }
    return undefined;
  }

  private command(
    words: Word[],
    c: Command,
    prev: Command | undefined,
    cwd: string,
    depth: number
  ): Outcome {
    let xargs = false;
    let i = 0;
    // Peel prefixes: assignments, sudo, env, timeout, xargs, ...
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
            const rest = words
              .slice(i + 2)
              .map(w => shellQuote(w.text))
              .join(' ');
            return [this.check(`${words[i + 1].text} ${rest}`, cwd, depth + 1), undefined];
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
      } else break;
    }
    const rest = words.slice(i);
    if (rest.length === 0) return [undefined, undefined];
    const name = basename(rest[0].text);
    const args = rest.slice(1);

    if (name === 'cd' || name === 'pushd') {
      const dirs = args.filter(w => !/^-[LPe@]+$/.test(w.text));
      if (dirs.length === 0) return [undefined, this.r.home];
      if (dirs[0].text === '-') return [undefined, UNRESOLVED_CWD];
      return [undefined, this.chdir(dirs[0], cwd)];
    }
    if (name === 'popd') return [undefined, UNRESOLVED_CWD];
    if (SHELLS.has(name)) return [this.shell(args, c, prev, cwd, depth), undefined];
    if (name === 'eval') {
      return [this.check(args.map(w => w.text).join(' '), cwd, depth + 1), undefined];
    }
    if (name === 'rm') {
      const upstream = c.sep === '|' || c.sep === '|&' ? prev : undefined;
      return [this.rm(args, cwd, xargs, upstream), undefined];
    }
    if (name === 'mv') return [this.mv(args, cwd), undefined];
    if (name === 'find') return [this.find(args, cwd), undefined];
    if (
      ['dd', 'shred', 'wipefs', 'blkdiscard', 'sgdisk', 'mke2fs', 'mkswap'].includes(name) ||
      name.startsWith('mkfs')
    ) {
      return [this.disk(name, args), undefined];
    }
    if (name === 'docker' || name === 'docker-compose' || name === 'podman') {
      return [this.docker(name, args), undefined];
    }
    if (name === 'stixctl' && args.length > 0 && args[0].text === 'compose') {
      return [this.compose(args.slice(2)), undefined];
    }
    if (name === 'git') return [this.git(args, cwd), undefined];
    if (name === 'busybox' && args.length > 0) {
      return this.command(args, c, prev, cwd, depth);
    }
    return [undefined, undefined];
  }

  private shell(
    args: Word[],
    c: Command,
    prev: Command | undefined,
    cwd: string,
    depth: number
  ): Violation | undefined {
    for (let k = 0; k < args.length; k++) {
      const t = args[k].text;
      if (t.startsWith('-') && !t.startsWith('--') && t.slice(1).includes('c')) {
        return k + 1 < args.length ? this.check(args[k + 1].text, cwd, depth + 1) : undefined;
      }
      if (t === '--command' || t === '-command') {
        return k + 1 < args.length ? this.check(args[k + 1].text, cwd, depth + 1) : undefined;
      }
      if (!t.startsWith('-')) return undefined; // running a script file
    }
    // The script comes on stdin: a heredoc, a here-string, or a pipe from echo/printf/cat.
    const scripts = [...c.heredocs, ...c.redirects.filter(([op]) => op === '<<<').map(r => r[1])];
    if (prev && (c.sep === '|' || c.sep === '|&')) {
      const head = prev.words.findIndex(w => !KEYWORDS.has(w.text));
      const feeder = head >= 0 ? basename(prev.words[head].text) : '';
      const fed = prev.words.slice(head + 1).filter(w => !/^-[neE]+$/.test(w.text));
      if (feeder === 'echo' || feeder === 'printf') {
        scripts.push(fed.map(w => w.text).join(' '), ...fed.map(w => w.text));
      }
      scripts.push(
        ...prev.heredocs,
        ...prev.redirects.filter(([op]) => op === '<<<').map(r => r[1])
      );
    }
    for (const body of scripts) {
      const v = this.check(body.replace(/\\n/g, '\n'), cwd, depth + 1);
      if (v) return v;
    }
    return undefined;
  }

  private rm(
    args: Word[],
    cwd: string,
    xargs: boolean,
    prev: Command | undefined
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
    if (!recursive) return undefined;
    for (const w of targets) {
      const hit = this.targetHits(w, cwd);
      if (hit) return this.r.violation('recursive-delete', `rm -r would delete ${hit}`);
    }
    for (const w of targets) {
      const v = this.unresolvedDelete(w, cwd, 'rm -r would delete');
      if (v) return v;
    }
    if (xargs) {
      const upstream = prev ? prev.words : [];
      const ok =
        upstream.length > 0 &&
        basename(upstream[0].text) === 'find' &&
        this.find(upstream.slice(1), cwd, true) === undefined &&
        upstream.some(w => FIND_FILTERS.has(w.text));
      if (!ok) {
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

  private find(args: Word[], cwd: string, deleting = false): Violation | undefined {
    const roots: Word[] = [];
    for (const w of args) {
      if (w.text.startsWith('-') || w.text.startsWith('(') || w.text.startsWith('!')) break;
      roots.push(w);
    }
    const texts = args.map(w => w.text);
    if (!deleting) {
      deleting =
        texts.includes('-delete') ||
        texts.some(
          (t, k) =>
            ['-exec', '-execdir', '-ok', '-okdir'].includes(t) &&
            k + 1 < texts.length &&
            basename(texts[k + 1]) === 'rm'
        );
    }
    if (!deleting) return undefined;
    const filtered = texts.some(t => FIND_FILTERS.has(t));
    const searched: Word[] = roots.length > 0 ? roots : [{ text: '.', glob: false }];
    for (const w of searched) {
      const p = this.abs(w.text, cwd);
      if (this.r.aboveSystem(p) || (this.r.hits(p) && !filtered)) {
        return this.r.violation(
          'recursive-delete',
          `find would delete under ${p}` + (filtered ? '' : ' with no -name/-path filter')
        );
      }
    }
    if (!filtered) {
      for (const w of searched) {
        const v = this.unresolvedDelete(w, cwd, 'find would delete everything under');
        if (v) return v;
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
      k += ['-H', '--host', '-c', '--context', '--config', '-l', '--log-level'].includes(texts[k])
        ? 2
        : 1;
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
    while (k < texts.length && texts[k].startsWith('-')) {
      if (texts[k] === '-C' && k + 1 < texts.length) {
        cwd = this.chdir(args[k + 1], cwd);
        k += 2;
      } else if (['-c', '--git-dir', '--work-tree', '--namespace'].includes(texts[k])) k += 2;
      else k++;
    }
    if (k >= texts.length || texts[k] !== 'clean') return undefined;
    const longs = texts.slice(k + 1);
    const flags = longs.filter(t => t.startsWith('-') && !t.startsWith('--'));
    const dry = longs.includes('--dry-run') || flags.some(f => f.slice(1).includes('n'));
    const force = longs.includes('--force') || flags.some(f => f.slice(1).includes('f'));
    const ignored = flags.some(f => /[xX]/.test(f.slice(1)));
    if (force && ignored && !dry && cwd.includes(UNRESOLVED)) {
      return new Violation(
        'unresolved-path',
        'git clean -x runs in a directory the guard cannot resolve (a variable, $(...) or cd), which could be a project, and deletes ignored data there',
        'cd to the literal project path first, or remove the specific ignored folder you meant.'
      );
    }
    if (force && ignored && !dry && this.r.inProject(cwd)) {
      return this.r.violation(
        'git-wipe',
        `git clean -x in ${cwd} deletes ignored data (databases, .venv, secret links)`
      );
    }
    return undefined;
  }
}

// ---------------------------------------------------------------- entry points

/** Where the rules come from; see the file header for the order. */
export function resolveRulesPath(
  env: Record<string, string | undefined> = process.env
): string | undefined {
  const configured = env[RULES_ENV];
  if (configured) return configured;
  const candidate = join(getArchonHome(), RULES_FILE_NAME);
  return existsSync(candidate) ? candidate : undefined;
}

let cached: { key: string; checker: Checker } | undefined;

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
    const checker = new Checker(new Rules(data));
    cached = { key, checker };
    return checker;
  } catch (err) {
    // Not cached: the next check retries, so a fixed file takes effect at once.
    return new Violation(
      'rules-unreadable',
      `the rules file ${path} could not be loaded (${(err as Error).message}), so no shell command is allowed`,
      `fix or remove ${path} (${RULES_ENV} or ${RULES_FILE_NAME} in the Archon home)`
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
