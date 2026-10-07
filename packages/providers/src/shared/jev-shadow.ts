/**
 * The Jev guard for agent tool calls (Claude, Codex, Grok): one decision per call.
 *
 * Stixed's session guard (`session_guard.py --stdin-json`, profile "archon") is the
 * one implementation of the judgement; Archon does not port it. Archon runs the
 * ROOT-OWNED promoted copy (`/usr/local/lib/stixed/.claude/scripts/`, mounted
 * read-only into the container the way `destructive_rules.json` is) with python3,
 * once per tool call that writes, runs a shell command or fetches a URL, and WAITS
 * for its Decision:
 *
 *  - outcome `deny` (enforced): the call is refused with the guard's reason;
 *  - outcome `allow`, including a log-only would-deny (`enforced: false`): the call
 *    proceeds. The mode (off | log-only | enforce, root-owned
 *    `/etc/stixed/jev-guard-mode.json`, key `archon`) is decided inside session_guard;
 *    this side only obeys the Decision. Code floors (secret opens, wall files, path
 *    rules) are enforced by session_guard in every mode;
 *  - no Decision (the child crashed, printed nothing readable, or did not answer in
 *    40 s): deny. session_guard keeps its own 30 s deadline; 40 s is the backstop.
 *
 * The guard's own ledger (stixed's security log) holds the call and the reason,
 * redacted. This side appends one line per judged call to
 * `<archon home>/logs/jev-shadow/<YYYY-MM-DD>.jsonl` with the outcome, stage and
 * mode only: never the command, the env, the user's request or the reason text.
 *
 * Switches (server env, pinned into each run so a project's env cannot change
 * them): ARCHON_JEV_SHADOW=off disables the guard; ARCHON_JEV_SCRIPTS_DIR overrides
 * the scripts folder (tests); ARCHON_LLM_GATEWAY_URL sets the gateway base. Under
 * `bun test` (NODE_ENV=test) it is off unless ARCHON_JEV_SCRIPTS_DIR is set.
 *
 * This file imports node built-ins only (the CLI hook dispatcher imports it).
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_LOGIN_ENV_KEYS } from './agent-env';

export const JEV_SHADOW_ENV = 'ARCHON_JEV_SHADOW';
export const JEV_SCRIPTS_DIR_ENV = 'ARCHON_JEV_SCRIPTS_DIR';
/** The root-owned promoted copy of stixed's scripts (stixctl promote). */
export const DEFAULT_JEV_SCRIPTS_DIR = '/usr/local/lib/stixed/.claude/scripts';
/** The script judgeCall runs (session_guard.py, wave 3). */
export const SESSION_GUARD_SCRIPT = 'session_guard.py';
/** llm-metrics' systemone route, appended to ARCHON_LLM_GATEWAY_URL. */
const SYSTEMONE_ROUTE = '/openrouter/v1/systemone';
/** session_guard's own deadline for one call (code, Jev and the judge together). */
export const GUARD_DEADLINE_S = 30;
/** TS-side backstop: past this the child is killed and the call denied. */
export const JUDGE_KILL_MS = 40_000;
/** Per-string cap on what is sent to the guard, so a payload always fits a pipe buffer. */
const MAX_TEXT = 24_000;
const MAX_ENV_VALUE = 2_000;
/** What is kept of the child's output (a Decision is a few KB). */
const MAX_OUTPUT = 256_000;

/** The root-owned mode file session_guard reads (`{"archon": "off|log-only|enforce", ...}`). */
export const JEV_GUARD_MODE_FILE = '/etc/stixed/jev-guard-mode.json';
export type JevGuardMode = 'off' | 'log-only' | 'enforce';
const MODES: readonly JevGuardMode[] = ['off', 'log-only', 'enforce'];
const DEFAULT_MODE: JevGuardMode = 'log-only';

/**
 * Archon's Jev guard mode, read the way session_guard.read_mode reads it: the
 * `archon` key, else `default`. A missing, unreadable or malformed file, or one
 * that is not root's or is group/world-writable, is `log-only` (today's behaviour).
 * Read on every call: flipping the file needs no restart.
 */
export function readArchonGuardMode(
  path: string = JEV_GUARD_MODE_FILE,
  requireRoot = true
): JevGuardMode {
  try {
    const st = statSync(path);
    if (!st.isFile()) return DEFAULT_MODE;
    if (requireRoot && (st.uid !== 0 || (st.mode & 0o022) !== 0)) return DEFAULT_MODE;
    const data = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return DEFAULT_MODE;
    const d = data as Record<string, unknown>;
    // Python's data.get("archon", data.get("default")): a present key wins even when it
    // is null or unknown (log-only), so this side never reads `enforce` where the guard
    // reads log-only (and switches Claude's sandbox off without the guard enforcing).
    const value = 'archon' in d ? d.archon : 'default' in d ? d.default : DEFAULT_MODE;
    return MODES.includes(value as JevGuardMode) ? (value as JevGuardMode) : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
}

/**
 * Whether the Jev guard decides this call: it is wired for the node (`config`) and
 * Archon's mode is `enforce`. Archon's destructive floor then leaves the rules flagged
 * `moves_to_jev` to it (Stixed's jev_decides_for). Read per call, like the mode.
 */
export function jevDecidesFor(
  config: JevShadowConfig | null | undefined,
  mode: () => JevGuardMode = readArchonGuardMode
): boolean {
  return !!config && mode() === 'enforce';
}

/** Pinned per run by the server (HookRunSpec.jevShadow), or resolved in-process for Claude. */
export interface JevShadowConfig {
  python: string;
  scriptsDir: string;
  logDir: string;
  /** Full systemone URL; unset = jev_guard's own default (host or container spelling). */
  gatewayUrl?: string;
  caller: string;
}

/** Where the request behind a run came from (stixed's archon channel reads it). */
export type RequestSource = 'user' | 'orchestrator' | 'parent_run' | 'trigger';
/** Whether the run's workflow is Archon's bundled one or a repo/global file. */
export type GuardWorkflowSource = 'bundled' | 'repo';

/** One tool call, in Claude's vocabulary (what session_guard reads). */
export interface ShadowCall {
  provider: 'claude' | 'codex' | 'grok';
  toolName: string;
  toolInput: Record<string, unknown>;
  cwd: string;
  /** The node's working directory (worktree root); the guard's `project_root`. */
  projectRoot: string;
  /** The env the agent's tool runs with (after the scrub). Sent to the guard, never logged. */
  env: Record<string, string | undefined>;
  userRequest?: string;
  runId?: string;
  nodeId?: string;
  workflow?: string;
  workflowSource?: GuardWorkflowSource;
  requestSource?: RequestSource;
  parentRunId?: string;
  /** What Archon's own guards decided for this call ("pass" or the deny reason's head). */
  archonGuard?: string;
  /**
   * This node session's own recent enforced denies (RecentBlocks), sent as
   * `recent_blocked_calls`. Unset: session_guard reads the shared ledger instead.
   */
  recentBlockedCalls?: BlockedCall[];
}

/** One earlier refused call, as session_guard's `recent_blocked_calls` holds it. */
export interface BlockedCall {
  call: string;
  blocked_by: string;
}

/** The one-line form of a call for `recent_blocked_calls` (session_guard redacts and clips it). */
export function blockedCallText(toolName: string, toolInput: Record<string, unknown>): string {
  const text =
    toolName === 'Bash'
      ? (str(toolInput.command) ?? '')
      : toolName === 'apply_patch'
        ? `apply_patch ${(str(toolInput.patch) ?? '')
            .split('\n')
            .map(l => l.trim())
            .filter(l => /^\*\*\* (Add File|Update File|Delete File|Move to): /.test(l))
            .join('; ')}`
        : `${toolName} ${str(toolInput.file_path) ?? str(toolInput.url) ?? str(toolInput.notebook_path) ?? ''}`;
  return text.trim().slice(0, 300);
}

/**
 * A node session's own recent enforced denies (the last 5 of the last 10 minutes,
 * session_guard's window for the ledger). Kept in memory by the hook that judges the
 * session's calls, so a retry of a refused call is seen as one, and no other session's
 * refusals are.
 */
export class RecentBlocks {
  private items: { at: number; entry: BlockedCall }[] = [];
  constructor(
    private readonly windowMs = 10 * 60_000,
    private readonly limit = 5,
    private readonly now: () => number = Date.now
  ) {}

  /** Record a call the guard refused (an enforced deny only). */
  add(call: Pick<ShadowCall, 'provider' | 'toolName' | 'toolInput'>, verdict: GuardVerdict): void {
    if (verdict.decision !== 'deny') return;
    this.items.push({
      at: this.now(),
      entry: {
        call: blockedCallText(call.toolName, call.toolInput),
        blocked_by: `jev:archon-${call.provider}:${verdict.stage}`,
      },
    });
    if (this.items.length > this.limit) this.items = this.items.slice(-this.limit);
  }

  /** The denies still inside the window, oldest first. */
  list(): BlockedCall[] {
    const since = this.now() - this.windowMs;
    this.items = this.items.filter(i => i.at >= since);
    return this.items.map(i => ({ ...i.entry }));
  }
}

/** The run fields of a GuardContext (providers/src/types.ts), structurally. */
export interface GuardContextFields {
  runId?: string;
  nodeId?: string;
  workflow?: string;
  userRequest?: string;
  requestSource?: RequestSource;
  parentRunId?: string;
  workflowSource?: GuardWorkflowSource;
}

/** The ShadowCall fields a request's GuardContext supplies (undefined ones left out). */
export function callContext(g: GuardContextFields | undefined): Partial<ShadowCall> {
  if (!g) return {};
  const out: Partial<ShadowCall> = {};
  if (g.userRequest !== undefined) out.userRequest = g.userRequest;
  if (g.runId !== undefined) out.runId = g.runId;
  if (g.nodeId !== undefined) out.nodeId = g.nodeId;
  if (g.workflow !== undefined) out.workflow = g.workflow;
  if (g.requestSource !== undefined) out.requestSource = g.requestSource;
  if (g.parentRunId !== undefined) out.parentRunId = g.parentRunId;
  if (g.workflowSource !== undefined) out.workflowSource = g.workflowSource;
  return out;
}

/** What a caller does with a call: run it, or refuse it with the reason. */
export interface GuardVerdict {
  decision: 'allow' | 'deny';
  reason: string;
  /** session_guard's stage (floor, open_check, prefilter, jev, judge, ...) or the TS failure. */
  stage: string;
  /** The mode session_guard applied; undefined when no Decision was read. */
  mode?: string;
  /** False for a log-only would-deny (the call proceeds). */
  enforced?: boolean;
}

function isOff(v: string | undefined): boolean {
  return v !== undefined && /^(?:0|off|false|no)$/i.test(v.trim());
}

/**
 * The guard's config for this server, or null when it cannot or must not run
 * (switched off, or session_guard.py is not where the promoted copy lives).
 */
export function resolveJevShadowConfig(
  env: Record<string, string | undefined>,
  archonHome: string
): JevShadowConfig | null {
  if (isOff(env[JEV_SHADOW_ENV])) return null;
  // Under `bun test` only an explicitly named scripts folder counts, so no test
  // run ever starts the real guard (or calls Jev) by finding the promoted copy.
  if (env.NODE_ENV === 'test' && !env[JEV_SCRIPTS_DIR_ENV]) return null;
  const scriptsDir = env[JEV_SCRIPTS_DIR_ENV] || DEFAULT_JEV_SCRIPTS_DIR;
  if (!existsSync(join(scriptsDir, SESSION_GUARD_SCRIPT))) return null;
  const base = env.ARCHON_LLM_GATEWAY_URL?.trim().replace(/\/+$/, '');
  return {
    python: existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3',
    scriptsDir,
    logDir: join(archonHome, 'logs', 'jev-shadow'),
    ...(base ? { gatewayUrl: `${base}${SYSTEMONE_ROUTE}` } : {}),
    caller: 'archon',
  };
}

/** Tool names the guard reads past its code floors (it has nothing to say about the others). */
export const JUDGED_TOOLS = new Set([
  'Bash',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'WebFetch',
]);

/** SDK matcher for the Claude hook: exactly the judged tools. */
export const JUDGED_TOOLS_MATCHER = [...JUDGED_TOOLS].join('|');

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * A Codex or Grok call in Claude's vocabulary, or undefined when nothing in it
 * is judged. `names` and `writes` come from the dispatcher's toolView; `command`
 * from its shellCommand (argv arrays already joined into one line); `toolName` is
 * the CLI's own. A Codex apply_patch goes whole, as `apply_patch {patch}`:
 * session_guard splits it into every file and delete (payload_calls), so each
 * file gets its path rules and each delete the floor.
 */
export function claudeShapedCall(
  names: string[],
  writes: string[],
  rawInput: unknown,
  command: string | undefined,
  toolName?: string
): { toolName: string; toolInput: Record<string, unknown> } | undefined {
  const input = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Record<
    string,
    unknown
  >;
  if (toolName === 'apply_patch') {
    const patch = str(input.command) ?? str(input.patch) ?? str(input.input);
    return patch ? { toolName: 'apply_patch', toolInput: { patch } } : undefined;
  }
  if (names.includes('Bash')) {
    return command ? { toolName: 'Bash', toolInput: { command } } : undefined;
  }
  if (names.includes('WebFetch')) {
    const url = str(input.url);
    return url ? { toolName: 'WebFetch', toolInput: { url } } : undefined;
  }
  const writeName = names.find(n => n === 'Write' || n === 'Edit' || n === 'MultiEdit');
  if (writeName) {
    // Grok's write/search_replace carry the text.
    const text =
      str(input.content) ??
      str(input.new_string) ??
      str(input.replace) ??
      str(input.command) ??
      str(input.input) ??
      '';
    const filePath = writes[0] ?? str(input.file_path) ?? str(input.path);
    if (!filePath) return undefined;
    return writeName === 'Write'
      ? { toolName: 'Write', toolInput: { file_path: filePath, content: text } }
      : { toolName: 'Edit', toolInput: { file_path: filePath, new_string: text } };
  }
  return undefined;
}

/** A patch header line (`*** Add File: x`, `*** Delete File: x`...), read as Codex reads it. */
function isPatchHeader(line: string): boolean {
  return line.trim().startsWith('*** ');
}

/**
 * A patch cut to MAX_TEXT without losing a header: every `***` line is kept whole and the
 * hunk lines fill what is left, in order, so a long file early in the patch never hides a
 * later file or delete from the guard (guardRequest).
 */
export function fitPatch(patch: string, max: number = MAX_TEXT): string {
  if (patch.length <= max) return patch;
  const lines = patch.split('\n');
  let left = max - lines.filter(isPatchHeader).reduce((n, l) => n + l.length + 1, 0);
  const out: string[] = [];
  for (const line of lines) {
    if (isPatchHeader(line)) out.push(line);
    else if (line.length + 1 <= left) {
      out.push(line);
      left -= line.length + 1;
    }
  }
  return out.join('\n');
}

function clipStrings(value: unknown, max: number, seen = new WeakSet()): unknown {
  if (typeof value === 'string') return value.length > max ? value.slice(0, max) : value;
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[cycle]';
    seen.add(value);
    if (Array.isArray(value)) return value.map(v => clipStrings(v, max, seen));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      out[k] = clipStrings(v, max, seen);
    return out;
  }
  return value;
}

/** The env the guard sees: the tool's env minus Archon's own hook plumbing, values capped. */
export function judgeEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || k === 'ARCHON_HOOK_SPEC' || k === 'ARCHON_HOOK_EVENTS') continue;
    out[k] = v.length > MAX_ENV_VALUE ? v.slice(0, MAX_ENV_VALUE) : v;
  }
  return out;
}

/**
 * The JSON session_guard reads on stdin (`--stdin-json`, the archon channel): the
 * call, the env the agent's tool runs with (`env`), and in `context` the run's
 * message (`user_request`), where it came from (`request_source`, `parent_run_id`),
 * which workflow asked (`workflow`, `workflow_source`: `bundled` only for Archon's
 * shipped default), the run and node ids, and the session's own recent refusals
 * (`recent_blocked_calls`, when the caller keeps them). Exactly those fields:
 * session_guard derives the request's source label and the project root itself.
 * Exit 2 (malformed request) denies.
 */
export function guardRequest(call: ShadowCall): string {
  const context: Record<string, unknown> = {
    user_request: (call.userRequest ?? '').slice(0, 4_000),
  };
  if (call.workflow !== undefined) context.workflow = call.workflow;
  if (call.workflowSource !== undefined) context.workflow_source = call.workflowSource;
  if (call.requestSource !== undefined) context.request_source = call.requestSource;
  if (call.parentRunId !== undefined) context.parent_run_id = call.parentRunId;
  if (call.runId !== undefined) context.run_id = call.runId;
  if (call.nodeId !== undefined) context.node_id = call.nodeId;
  if (call.recentBlockedCalls !== undefined)
    context.recent_blocked_calls = call.recentBlockedCalls.slice(-5);
  return JSON.stringify({
    cli: call.provider,
    tool: call.toolName,
    // a patch keeps every header whole (fitPatch); everything else is clipped per string
    tool_input:
      call.toolName === 'apply_patch'
        ? { patch: fitPatch(str(call.toolInput.patch) ?? '') }
        : clipStrings(call.toolInput, MAX_TEXT),
    cwd: call.cwd,
    profile: 'archon',
    env: judgeEnv(call.env),
    deadline_s: GUARD_DEADLINE_S,
    context,
  });
}

/**
 * The verdict for session_guard's stdout. Only an `allow` (a log-only would-deny
 * included) lets the call run; a deny that is not enforced is an allow; `ask` and
 * anything unreadable deny (nobody answers an ask in an unattended run).
 */
export function verdictOf(stdout: string): GuardVerdict {
  let d: Record<string, unknown> | undefined;
  for (const line of stdout.trim().split('\n').reverse()) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        d = parsed as Record<string, unknown>;
        break;
      }
    } catch {
      // not the Decision line
    }
  }
  if (!d || typeof d.outcome !== 'string') {
    return {
      decision: 'deny',
      stage: 'archon:unreadable',
      reason: 'the Jev guard gave no readable decision; the call is denied (fail closed)',
    };
  }
  const stage = typeof d.stage === 'string' ? d.stage : 'unknown';
  const reason = typeof d.reason === 'string' && d.reason ? d.reason : 'no reason given';
  const mode = typeof d.mode === 'string' ? d.mode : undefined;
  const enforced = typeof d.enforced === 'boolean' ? d.enforced : undefined;
  const base = {
    stage,
    ...(mode ? { mode } : {}),
    ...(enforced !== undefined ? { enforced } : {}),
  };
  if (d.outcome === 'allow') return { decision: 'allow', reason, ...base };
  if (d.outcome === 'deny') {
    // session_guard turns a log-only would-deny into allow itself; obey `enforced` too.
    if (enforced === false) return { decision: 'allow', reason, ...base };
    return { decision: 'deny', reason: denyText(stage, reason, d.user_runs_it === true), ...base };
  }
  return {
    decision: 'deny',
    reason: `jev-guard: denied (the guard asked for a human, and an Archon run has none: ${reason})\n${ANOTHER_WAY}`,
    ...base,
  };
}

const ANOTHER_WAY =
  'Nothing ran. Do it another way; if there is no other way, stop and report what you needed and why.';
const USER_RUNS_IT =
  "Nothing ran. This is the user's to run: do not look for another way; report the command and why you need it.";
/** session_guard's code floors: their reason is the whole message (HARD STOP included). */
const FLOOR_STAGES = new Set(['floor', 'open_check', 'identity', 'wall_file', 'path_rule']);

/** The agent's text for a deny, as session_guard.deny_text words it for the host hooks. */
function denyText(stage: string, reason: string, userRunsIt: boolean): string {
  const flat = reason.split(/\s+/).join(' ');
  if (FLOOR_STAGES.has(stage) || /hard stop/i.test(flat)) return flat;
  return `jev-guard: denied (${flat.slice(0, 900)})\n${userRunsIt ? USER_RUNS_IT : ANOTHER_WAY}`;
}

/**
 * The guard process's env: enough to run python, reach the gateway and start the judge,
 * nothing else. The judge (session_guard's judge_sdk.py child) runs the Claude CLI on the
 * user's subscription, so it gets the CLI's own login and the binary the entrypoint pinned
 * (CLAUDE_BIN_PATH, as stixed's STIXED_CLAUDE_CLI). Both are in the server's env (Claude
 * nodes); the Codex and Grok CLIs never carry the login (agent-env.ts), so their hook
 * dispatcher passes none.
 */
export function judgeProcessEnv(
  config: JevShadowConfig,
  server: Record<string, string | undefined> = process.env
): Record<string, string> {
  const keep = [
    'PATH',
    'HOME',
    'LANG',
    'LC_ALL',
    'TZ',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
  ];
  const out: Record<string, string> = {};
  for (const k of [...keep, ...CLAUDE_LOGIN_ENV_KEYS]) {
    const v = server[k];
    if (v !== undefined) out[k] = v;
  }
  if (server.CLAUDE_BIN_PATH) out.STIXED_CLAUDE_CLI = server.CLAUDE_BIN_PATH;
  out.JEV_CALLER = config.caller || 'archon';
  if (config.gatewayUrl) out.JEV_GATEWAY_URL = config.gatewayUrl;
  return out;
}

/** Append one line about a judged call (no command, env, request or reason). Never throws. */
export function logGuardCall(
  config: JevShadowConfig,
  call: ShadowCall,
  verdict: GuardVerdict,
  elapsedMs: number,
  error?: string
): void {
  try {
    mkdirSync(config.logDir, { recursive: true, mode: 0o700 });
    const day = new Date().toISOString().slice(0, 10);
    const entry = {
      ts: new Date().toISOString(),
      provider: call.provider,
      tool: call.toolName,
      run_id: call.runId ?? null,
      node_id: call.nodeId ?? null,
      workflow: call.workflow ?? null,
      archon_guard: call.archonGuard ?? null,
      decision: verdict.decision,
      stage: verdict.stage,
      mode: verdict.mode ?? null,
      enforced: verdict.enforced ?? null,
      elapsed_ms: elapsedMs,
      ...(error ? { error: error.slice(0, 300) } : {}),
    };
    appendFileSync(join(config.logDir, `${day}.jsonl`), `${JSON.stringify(entry)}\n`, {
      mode: 0o600,
    });
  } catch {
    // a log that cannot be written changes nothing
  }
}

/**
 * Judge one call and wait for the verdict. Never rejects: a child that cannot
 * start, crashes, prints no Decision or outlives `killAfterMs` is a deny.
 */
export function judgeCall(
  call: ShadowCall,
  config: JevShadowConfig,
  killAfterMs: number = JUDGE_KILL_MS
): Promise<GuardVerdict> {
  const started = performance.now();
  return new Promise<GuardVerdict>(resolve => {
    let settled = false;
    const finish = (verdict: GuardVerdict, error?: string): void => {
      if (settled) return;
      settled = true;
      logGuardCall(config, call, verdict, Math.round(performance.now() - started), error);
      resolve(verdict);
    };
    const failed = (stage: string, why: string): void => {
      finish(
        {
          decision: 'deny',
          stage,
          reason: `jev-guard: denied (${why}; the call is denied, fail closed)\n${ANOTHER_WAY}`,
        },
        why
      );
    };
    let payload: string;
    try {
      payload = guardRequest(call);
    } catch (err) {
      failed('archon:error', `the guard request could not be built: ${(err as Error).message}`);
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        config.python,
        [
          '-I',
          join(config.scriptsDir, SESSION_GUARD_SCRIPT),
          '--stdin-json',
          '--caller',
          config.caller || 'archon',
        ],
        {
          cwd: '/',
          // its own process group, so the deadline kills the guard and anything it started
          detached: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: judgeProcessEnv(config),
        }
      );
    } catch (err) {
      failed('archon:error', `the guard did not start: ${(err as Error).message}`);
      return;
    }
    const proc = child;
    const kill = (): void => {
      try {
        if (proc.pid) process.kill(-proc.pid, 'SIGKILL');
      } catch {
        try {
          proc.kill('SIGKILL');
        } catch {
          // already gone
        }
      }
    };
    let out = '';
    let err = '';
    proc.stdout?.on('data', (c: Buffer) => {
      if (out.length < MAX_OUTPUT) out += c.toString('utf8');
    });
    proc.stderr?.on('data', (c: Buffer) => {
      if (err.length < 4_000) err += c.toString('utf8');
    });
    const timer = setTimeout(() => {
      kill();
      failed('archon:deadline', `no verdict in ${String(killAfterMs / 1000)} s`);
    }, killAfterMs);
    proc.on('error', (e: Error) => {
      clearTimeout(timer);
      failed('archon:error', `the guard did not start: ${e.message}`);
    });
    proc.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      if (settled) return;
      if (code !== 0) {
        const head = err.trim().split('\n').pop() ?? '';
        failed(
          'archon:crash',
          `the guard exited with ${code === null ? `signal ${String(signal)}` : `code ${String(code)}`}${head ? `: ${head.slice(0, 200)}` : ''}`
        );
        return;
      }
      const verdict = verdictOf(out);
      finish(verdict, verdict.stage === 'archon:unreadable' ? 'no readable Decision' : undefined);
    });
    proc.stdin?.on('error', () => {
      // EPIPE: the guard died before reading; its exit settles the call
    });
    proc.stdin?.end(payload);
  });
}
