/**
 * Jev shadow judge for agent tool calls (Claude, Codex, Grok). LOG-ONLY.
 *
 * Stixed's Jev guard client (`jev_guard.py`, `decide()`) is the one implementation
 * of the judgement; Archon does not port it. Archon runs the ROOT-OWNED promoted
 * copy (`/usr/local/lib/stixed/.claude/scripts/`, mounted read-only into the
 * container the way `destructive_rules.json` is) with python3, once per tool call
 * that writes, runs a shell command or fetches a URL, and appends the verdict to
 * `<archon home>/logs/jev-shadow/<YYYY-MM-DD>.jsonl`.
 *
 * Shadow mode, by construction:
 *  - the judge runs in a detached process: the tool call never waits for it
 *    (the CLI hook dispatcher waits only for its payload to reach the pipe);
 *  - nothing it returns reaches the agent: the Claude hook and the dispatcher
 *    return their own decision whatever Jev says;
 *  - any failure (no python, no scripts, a crash, a timeout) is one log line.
 *
 * Log entries are redacted with jev_guard's own `redact()`; they hold the call
 * (clipped to 300 chars), the verdict, its triggers and the names of the facts
 * code computed. Never the env, the user's request, file contents or fact values.
 *
 * Switches (server env, pinned into each run so a project's env cannot change
 * them): ARCHON_JEV_SHADOW=off disables; ARCHON_JEV_SCRIPTS_DIR overrides the
 * scripts folder (tests); ARCHON_LLM_GATEWAY_URL sets the gateway base. Under
 * `bun test` (NODE_ENV=test) it is off unless ARCHON_JEV_SCRIPTS_DIR is set.
 *
 * This file imports node built-ins only (the CLI hook dispatcher imports it).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const JEV_SHADOW_ENV = 'ARCHON_JEV_SHADOW';
export const JEV_SCRIPTS_DIR_ENV = 'ARCHON_JEV_SCRIPTS_DIR';
/** The root-owned promoted copy of stixed's scripts (stixctl promote). */
export const DEFAULT_JEV_SCRIPTS_DIR = '/usr/local/lib/stixed/.claude/scripts';
/** llm-metrics' systemone route, appended to ARCHON_LLM_GATEWAY_URL. */
const SYSTEMONE_ROUTE = '/openrouter/v1/systemone';
/** Upper bound for one judgement, the Jev call included (jev_guard's own timeout is 3 s). */
const JUDGE_TIMEOUT_S = 30;
/** Per-string cap on what is sent to the judge, so a payload always fits a pipe buffer. */
const MAX_TEXT = 24_000;
const MAX_ENV_VALUE = 2_000;
/** Judges in flight at once in this process (stixed's host shadow uses 4 slots too). */
export const MAX_CONCURRENT_JUDGES = 4;
/** TS-side hard deadline: the judge's own alarm is JUDGE_TIMEOUT_S; this kills it if that fails. */
const KILL_AFTER_MS = (JUDGE_TIMEOUT_S + 5) * 1000;
let inFlight = 0;

/** Judges currently running in this process (tests). */
export function judgesInFlight(): number {
  return inFlight;
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

/** One tool call, in Claude's vocabulary (what jev_guard reads). */
export interface ShadowCall {
  provider: 'claude' | 'codex' | 'grok';
  toolName: string;
  toolInput: Record<string, unknown>;
  cwd: string;
  /** The node's working directory (worktree root); jev_guard's `project_root`. */
  projectRoot: string;
  /** The env the agent's tool runs with (after the scrub). Sent to the judge, never logged. */
  env: Record<string, string | undefined>;
  userRequest?: string;
  runId?: string;
  nodeId?: string;
  workflow?: string;
  /** What Archon's own guards decided for this call ("pass" or the deny reason's head). */
  archonGuard?: string;
}

function isOff(v: string | undefined): boolean {
  return v !== undefined && /^(?:0|off|false|no)$/i.test(v.trim());
}

/**
 * The shadow judge's config for this server, or null when it cannot or must
 * not run (switched off, or jev_guard.py is not where the promoted copy lives).
 */
export function resolveJevShadowConfig(
  env: Record<string, string | undefined>,
  archonHome: string
): JevShadowConfig | null {
  if (isOff(env[JEV_SHADOW_ENV])) return null;
  // Under `bun test` only an explicitly named scripts folder counts, so no test
  // run ever starts the real judge (or calls Jev) by finding the promoted copy.
  if (env.NODE_ENV === 'test' && !env[JEV_SCRIPTS_DIR_ENV]) return null;
  const scriptsDir = env[JEV_SCRIPTS_DIR_ENV] || DEFAULT_JEV_SCRIPTS_DIR;
  if (!existsSync(join(scriptsDir, 'jev_guard.py'))) return null;
  const base = env.ARCHON_LLM_GATEWAY_URL?.trim().replace(/\/+$/, '');
  return {
    python: existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3',
    scriptsDir,
    logDir: join(archonHome, 'logs', 'jev-shadow'),
    ...(base ? { gatewayUrl: `${base}${SYSTEMONE_ROUTE}` } : {}),
    caller: 'archon',
  };
}

/** Tool names jev_guard's pre-filter reads (it has nothing to say about the others). */
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
 * from its shellCommand (argv arrays already joined into one line).
 */
export function claudeShapedCall(
  names: string[],
  writes: string[],
  rawInput: unknown,
  command: string | undefined
): { toolName: string; toolInput: Record<string, unknown> } | undefined {
  const input = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Record<
    string,
    unknown
  >;
  if (names.includes('Bash')) {
    return command ? { toolName: 'Bash', toolInput: { command } } : undefined;
  }
  if (names.includes('WebFetch')) {
    const url = str(input.url);
    return url ? { toolName: 'WebFetch', toolInput: { url } } : undefined;
  }
  const writeName = names.find(n => n === 'Write' || n === 'Edit' || n === 'MultiEdit');
  if (writeName) {
    // apply_patch carries the patch; Grok's write/search_replace carry the text.
    const text =
      str(input.content) ??
      str(input.new_string) ??
      str(input.replace) ??
      str(input.command) ??
      str(input.patch) ??
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

function clipStrings(value: unknown, max: number): unknown {
  if (typeof value === 'string') return value.length > max ? value.slice(0, max) : value;
  if (Array.isArray(value)) return value.map(v => clipStrings(v, max));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      out[k] = clipStrings(v, max);
    return out;
  }
  return value;
}

/** The env the judge sees: the tool's env minus Archon's own hook plumbing, values capped. */
export function judgeEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || k === 'ARCHON_HOOK_SPEC' || k === 'ARCHON_HOOK_EVENTS') continue;
    out[k] = v.length > MAX_ENV_VALUE ? v.slice(0, MAX_ENV_VALUE) : v;
  }
  return out;
}

/** The JSON a judge process reads on stdin. */
export function shadowPayload(call: ShadowCall, config: JevShadowConfig): string {
  return JSON.stringify({
    config: {
      scripts_dir: config.scriptsDir,
      log_dir: config.logDir,
      caller: config.caller,
      timeout_s: JUDGE_TIMEOUT_S,
      ...(config.gatewayUrl ? { gateway_url: config.gatewayUrl } : {}),
    },
    call: {
      provider: call.provider,
      tool_name: call.toolName,
      tool_input: clipStrings(call.toolInput, MAX_TEXT),
      cwd: call.cwd,
      project_root: call.projectRoot,
      env: judgeEnv(call.env),
      user_request: (call.userRequest ?? '').slice(0, 4_000),
      run_id: call.runId ?? null,
      node_id: call.nodeId ?? null,
      workflow: call.workflow ?? null,
      archon_guard: call.archonGuard ?? null,
    },
  });
}

/**
 * The judge process: reads the payload, asks jev_guard.decide(), appends one
 * redacted JSON line. Everything it writes goes through jev_guard.redact().
 * Runs with -I (no PYTHON* env, no user site), so only the scripts folder named
 * in the payload is importable besides the standard library.
 */
export const JUDGE_SCRIPT = String.raw`
import json, os, signal, sys, threading, time
started = time.monotonic()
# Backstop that does not depend on the parent or the main thread: a daemon timer
# works while the main thread is stuck reading stdin or in a C call. The env var
# is only ever set by tests (the judge process env is pinned by the parent).
_backstop = threading.Timer(float(os.environ.get("ARCHON_JEV_BACKSTOP_S") or ${JUDGE_TIMEOUT_S + 5}), os._exit, (0,))
_backstop.daemon = True
_backstop.start()
payload = json.load(sys.stdin)
cfg, call = payload["config"], payload["call"]
entry = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "provider": call.get("provider"),
         "tool": call.get("tool_name"), "cwd": call.get("cwd"), "run_id": call.get("run_id"),
         "node_id": call.get("node_id"), "workflow": call.get("workflow"),
         "archon_guard": call.get("archon_guard")}
redact = lambda s: str(s)
def write_entry():
    entry["elapsed_ms"] = int((time.monotonic() - started) * 1000)
    os.makedirs(cfg["log_dir"], mode=0o700, exist_ok=True)
    path = os.path.join(cfg["log_dir"], time.strftime("%Y-%m-%d") + ".jsonl")
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        os.write(fd, (json.dumps(entry, sort_keys=True) + "\n").encode())
    finally:
        os.close(fd)
def _take_slot():
    # One of SLOTS non-blocking flock slots, shared by every judge on this host
    # (the dispatcher is a fresh process per Codex/Grok hook call, so no in-process
    # counter can cap them). Held until the process dies, SIGKILL included.
    try:
        import fcntl
        folder = os.path.join(cfg["log_dir"], "slots")
        os.makedirs(folder, mode=0o700, exist_ok=True)
        for n in range(${MAX_CONCURRENT_JUDGES}):
            fd = os.open(os.path.join(folder, "slot-%d.lock" % n), os.O_RDWR | os.O_CREAT, 0o600)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return True
            except OSError:
                os.close(fd)
        return False
    except BaseException:
        return True  # no usable slot folder: judge anyway, the backstop still bounds it
if not _take_slot():
    entry.update(decision="skipped", error="skipped: busy")
    try:
        write_entry()
    except BaseException:
        pass
    os._exit(0)
def _timeout(*_):
    # os._exit, never an exception: jev_guard's broad except blocks would swallow it
    try:
        entry.update(decision="error", error="timeout: jev shadow judge timed out")
        write_entry()
    except BaseException:
        pass
    os._exit(0)
try:
    signal.signal(signal.SIGALRM, _timeout)
    signal.alarm(int(cfg.get("timeout_s") or 30))
    sys.path.insert(0, cfg["scripts_dir"])
    if cfg.get("gateway_url"):
        os.environ["JEV_GATEWAY_URL"] = cfg["gateway_url"]
    import jev_guard as jg
    redact = jg.redact
    jg.CALLER = cfg.get("caller") or "archon"
    ti = call.get("tool_input") or {}
    shown = ti.get("command") or ti.get("url") or ti.get("file_path") or ""
    entry["call"] = redact(str(shown))[:300]
    context = {"cwd": call.get("cwd") or "/", "project_root": call.get("project_root") or call.get("cwd") or "/",
               "user_request": call.get("user_request") or "", "env": call.get("env") or {}}
    v = jg.decide(call.get("tool_name") or "", ti, context)
    entry.update(decision=v.decision, reason=redact(v.reason)[:400], asked=v.asked,
                 triggers=[redact(t)[:200] for t in v.triggers][:12], fact_keys=sorted(v.facts)[:24],
                 model=v.model, latency_ms=v.latency_ms, cost=v.cost)
    if v.error:
        entry["error"] = redact(v.error)[:300]
except BaseException as e:
    entry.update(decision="error", error=redact(type(e).__name__ + ": " + str(e))[:300])
finally:
    signal.alarm(0)
write_entry()
`;

/** The judge process's env: enough to run python and reach the gateway, nothing else. */
function judgeProcessEnv(): Record<string, string> {
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
  for (const k of keep) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Append one line from this side (a judge that could not even start). Never throws. */
export function logShadowFailure(
  config: JevShadowConfig,
  call: ShadowCall,
  error: string,
  decision = 'error'
): void {
  try {
    mkdirSync(config.logDir, { recursive: true, mode: 0o700 });
    const day = new Date().toISOString().slice(0, 10);
    const entry = {
      ts: new Date().toISOString(),
      provider: call.provider,
      tool: call.toolName,
      cwd: call.cwd,
      run_id: call.runId ?? null,
      node_id: call.nodeId ?? null,
      workflow: call.workflow ?? null,
      archon_guard: call.archonGuard ?? null,
      decision,
      error: error.slice(0, 300),
    };
    appendFileSync(join(config.logDir, `${day}.jsonl`), `${JSON.stringify(entry)}\n`, {
      mode: 0o600,
    });
  } catch {
    // shadow mode: a log that cannot be written changes nothing
  }
}

/**
 * Start the judge for one call and return at once. The returned promise settles
 * when the payload has been handed to the judge's stdin (or after `waitMs`), for
 * a short-lived caller (the CLI hook dispatcher) that must not exit first. It
 * never rejects, and nothing about the judgement ever reaches the caller.
 */
export function shadowJudge(
  call: ShadowCall,
  config: JevShadowConfig,
  waitMs = 250
): Promise<void> {
  return new Promise<void>(resolve => {
    let settled = false;
    const done = (): void => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    if (inFlight >= MAX_CONCURRENT_JUDGES) {
      logShadowFailure(config, call, 'skipped: busy', 'skipped');
      done();
      return;
    }
    let payload: string;
    try {
      payload = shadowPayload(call, config);
    } catch (err) {
      logShadowFailure(config, call, `judge did not start: ${(err as Error).message}`);
      done();
      return;
    }
    let counted = false;
    let child: ChildProcess | undefined;
    const release = (): void => {
      if (counted) {
        counted = false;
        inFlight--;
      }
    };
    try {
      inFlight++;
      counted = true;
      child = spawn(config.python, ['-I', '-c', JUDGE_SCRIPT], {
        cwd: '/',
        detached: true,
        stdio: ['pipe', 'ignore', 'ignore'],
        env: judgeProcessEnv(),
      });
      const proc = child;
      proc.on('exit', release);
      proc.on('error', (err: Error) => {
        release();
        logShadowFailure(config, call, `judge did not start: ${err.message}`);
        done();
      });
      proc.stdin?.on('error', () => {
        // EPIPE: the judge died before reading; it logs its own failure if it can
        done();
      });
      proc.unref();
      proc.stdin?.end(payload, () => {
        done();
      });
      const timer = setTimeout(done, waitMs);
      timer.unref?.();
      // Hard deadline whatever the judge does: kill its process group.
      const killer = setTimeout(() => {
        try {
          if (proc.pid) process.kill(-proc.pid, 'SIGKILL');
        } catch {
          // already gone
        }
        release();
      }, KILL_AFTER_MS);
      killer.unref?.();
      proc.on('exit', () => clearTimeout(killer));
    } catch (err) {
      release();
      try {
        if (child?.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
      logShadowFailure(config, call, `judge did not start: ${(err as Error).message}`);
      done();
    }
  });
}
