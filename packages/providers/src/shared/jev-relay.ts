/**
 * The Jev guard's judge relay, for Codex and Grok nodes.
 *
 * session_guard's judge stage (judge_sdk.py) runs the Claude CLI on the user's
 * subscription, so it needs the CLI's login. The Archon server process has it and
 * judges Claude nodes' calls in-process. The Codex and Grok CLIs never have it
 * (agent-env.ts removes it, so neither the CLI, its tools, its hook dispatcher nor the
 * run's spec file can read it), and judging in their dispatcher always found the judge
 * unavailable. So the dispatcher sends each call here, to the server process, which
 * runs judgeCall with its own config and its own env and sends back the verdict alone.
 *
 * Server: a node:net server on a unix socket, never TCP, in a fresh 0700 directory
 * under tmpdir() with a random name. prepareHookRun starts it the first time a Codex or
 * Grok run pins a Jev config, once per server process (per config: in production there
 * is one), and pins its path into the run's spec as `relay`. The directory is removed
 * when the process exits. It is unref'd, so it never keeps a process alive.
 *
 * Protocol: one newline-terminated JSON request per connection, the ShadowCall; one
 * JSON line back, the GuardVerdict; then the connection closes. The server reads the
 * call's own fields by name and type and nothing else, and judges with the config it
 * was started with: a client can never choose the python, the scripts, the log or the
 * gateway. A request over RELAY_MAX_REQUEST, or one that is not a well-formed Codex or
 * Grok call, is denied. A connection is closed RELAY_CONNECTION_MS after it opened,
 * just past judgeCall's own backstop.
 *
 * Client (relayJudge, the dispatcher's judge): when the spec pins a relay, the call
 * goes there and its verdict is the answer. A relay that cannot be reached, fails, or
 * answers nothing readable leaves the call to judgeCall in the dispatcher (code floors
 * and Jev still decide; only the judge stage is unavailable), and the relay's failure
 * goes into that call's log line. The whole wait, relay and fallback together, stays
 * inside RELAY_CLIENT_MS, under the CLIs' 45 s hook timeout (past which both let the
 * call through). A relayed call is logged once, by the server's judgeCall.
 *
 * Who can connect: the socket's directory is 0700, so only Archon's own user. The
 * agents' tools run as that user too; one could ask the relay for a verdict, which
 * costs a judge call and shows what the guard would say, never the login.
 *
 * This file imports node built-ins only (the CLI hook dispatcher imports it).
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JUDGE_KILL_MS,
  failClosed,
  guardToolInput,
  judgeCall,
  judgeEnv,
  logGuardCall,
  type BlockedCall,
  type GuardVerdict,
  type JevShadowConfig,
  type ShadowCall,
} from './jev-shadow';

/** Largest request the server reads (a clipped call is far smaller); over it is a deny. */
export const RELAY_MAX_REQUEST = 1_000_000;
/** Largest answer the client reads (a verdict is a few KB). */
const RELAY_MAX_RESPONSE = 256_000;
/** The server closes a connection this long after it opened: judgeCall's backstop plus slack. */
export const RELAY_CONNECTION_MS = JUDGE_KILL_MS + 2_000;
/**
 * The client's whole budget for one call, relay and local fallback together: just past
 * the server's backstop, so the server's own deadline verdict arrives first, and under
 * the CLIs' hook timeout (install.ts PRE_TOOL_USE_TIMEOUT_S).
 */
export const RELAY_CLIENT_MS = JUDGE_KILL_MS + 1_000;
/** Below this much budget left, a fallback could not finish: the call is denied instead. */
const MIN_FALLBACK_MS = 2_000;
/** Guard processes the relay runs at once; past it a connection is refused (local fallback). */
const RELAY_MAX_CONNECTIONS = 64;
/** A unix socket path must fit sun_path (108 bytes on Linux), with room to spare. */
const MAX_SOCKET_PATH = 100;

interface Relay {
  server: Server;
  dir: string;
  path: string;
  /** Open connections, so stopping the relay never waits on a client. */
  sockets: Set<Socket>;
}

const relays = new Map<string, Relay>();
let exitHooked = false;

/** The config the server judges with: the resolved fields only, never a relay of its own. */
function ownConfig(c: JevShadowConfig): JevShadowConfig {
  return {
    python: c.python,
    scriptsDir: c.scriptsDir,
    logDir: c.logDir,
    ...(c.gatewayUrl !== undefined ? { gatewayUrl: c.gatewayUrl } : {}),
    caller: c.caller,
  };
}

function configKey(c: JevShadowConfig): string {
  return JSON.stringify([c.python, c.scriptsDir, c.logDir, c.gatewayUrl ?? null, c.caller]);
}

/** tmpdir(), unless its path is too long for a socket under it (then /tmp). */
function socketBase(): string {
  const base = tmpdir();
  // archon-jev-relay-XXXXXX/<16 hex>.sock
  return base.length + 48 <= MAX_SOCKET_PATH ? base : '/tmp';
}

function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // already gone
  }
}

function closeRelay(key: string, relay: Relay): void {
  if (relays.get(key) === relay) relays.delete(key);
  try {
    relay.server.close();
  } catch {
    // not listening
  }
  removeDir(relay.dir);
}

/**
 * The relay socket for this config, started on first use; null when it cannot start
 * (the caller then pins none, and the dispatcher judges locally as before).
 */
export function ensureJevRelay(config: JevShadowConfig): string | null {
  const own = ownConfig(config);
  const key = configKey(own);
  const existing = relays.get(key);
  if (existing) return existing.path;
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(socketBase(), 'archon-jev-relay-'));
    chmodSync(dir, 0o700);
    const path = join(dir, `${randomBytes(8).toString('hex')}.sock`);
    // Half-open: a client that ends its side after the request still gets the answer.
    const sockets = new Set<Socket>();
    const server = createServer({ allowHalfOpen: true }, socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      serveConnection(socket, own);
    });
    server.maxConnections = RELAY_MAX_CONNECTIONS;
    const relay: Relay = { server, dir, path, sockets };
    // A relay that fails is dropped; the next run starts a fresh one, and calls pinned
    // to this one fall back to judging locally.
    server.on('error', () => {
      closeRelay(key, relay);
    });
    server.listen(path);
    server.unref();
    relays.set(key, relay);
    if (!exitHooked) {
      exitHooked = true;
      process.once('exit', () => {
        for (const r of relays.values()) removeDir(r.dir);
      });
    }
    return path;
  } catch {
    if (dir) removeDir(dir);
    return null;
  }
}

/** Close every relay and remove its directory (tests; the exit hook removes them otherwise). */
export async function stopJevRelays(): Promise<void> {
  const all = [...relays.entries()];
  await Promise.all(
    all.map(
      ([key, relay]) =>
        new Promise<void>(resolve => {
          if (relays.get(key) === relay) relays.delete(key);
          for (const socket of relay.sockets) socket.destroy();
          try {
            relay.server.close(() => {
              resolve();
            });
          } catch {
            resolve();
          }
          removeDir(relay.dir);
        })
    )
  );
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

const OPTIONAL_STRINGS = [
  'userRequest',
  'runId',
  'nodeId',
  'workflow',
  'parentRunId',
  'archonGuard',
] as const;
const REQUEST_SOURCES = new Set(['user', 'orchestrator', 'parent_run', 'trigger']);
const WORKFLOW_SOURCES = new Set(['bundled', 'repo']);

/**
 * The call in a relay request, read field by field (anything else in the request is
 * ignored, a config included), or undefined when it is not a well-formed Codex or Grok
 * call: the server then denies it.
 */
export function relayedCall(value: unknown): ShadowCall | undefined {
  if (!isRecord(value)) return undefined;
  const { provider, toolName, toolInput, cwd, projectRoot } = value;
  if (provider !== 'codex' && provider !== 'grok') return undefined;
  if (typeof toolName !== 'string' || toolName === '' || !isRecord(toolInput)) return undefined;
  if (typeof cwd !== 'string' || typeof projectRoot !== 'string') return undefined;
  const env: Record<string, string> = {};
  if (value.env !== undefined) {
    if (!isRecord(value.env)) return undefined;
    for (const [k, v] of Object.entries(value.env)) {
      if (typeof v !== 'string') return undefined;
      env[k] = v;
    }
  }
  const call: ShadowCall = { provider, toolName, toolInput, cwd, projectRoot, env };
  for (const k of OPTIONAL_STRINGS) {
    const v = value[k];
    if (v === undefined) continue;
    if (typeof v !== 'string') return undefined;
    call[k] = v;
  }
  if (value.requestSource !== undefined) {
    if (!REQUEST_SOURCES.has(value.requestSource as string)) return undefined;
    call.requestSource = value.requestSource as ShadowCall['requestSource'];
  }
  if (value.workflowSource !== undefined) {
    if (!WORKFLOW_SOURCES.has(value.workflowSource as string)) return undefined;
    call.workflowSource = value.workflowSource as ShadowCall['workflowSource'];
  }
  if (value.recentBlockedCalls !== undefined) {
    const list = value.recentBlockedCalls;
    if (!Array.isArray(list)) return undefined;
    const blocked: BlockedCall[] = [];
    for (const b of list.slice(-5)) {
      if (!isRecord(b) || typeof b.call !== 'string' || typeof b.blocked_by !== 'string')
        return undefined;
      blocked.push({ call: b.call, blocked_by: b.blocked_by });
    }
    call.recentBlockedCalls = blocked;
  }
  return call;
}

/** One connection: read one request line, judge it with the server's config, answer, close. */
function serveConnection(socket: Socket, config: JevShadowConfig): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let started = false;
  let answered = false;
  const timer = setTimeout(() => socket.destroy(), RELAY_CONNECTION_MS);
  socket.on('close', () => {
    clearTimeout(timer);
  });
  socket.on('error', () => {
    // the client went away; its own deadline settles its call
  });
  const answer = (verdict: GuardVerdict): void => {
    if (answered) return;
    answered = true;
    if (!socket.destroyed) socket.end(`${JSON.stringify(verdict)}\n`);
  };
  socket.on('data', (chunk: Buffer) => {
    if (started || answered) return; // one request per connection; the rest is ignored
    size += chunk.length;
    if (size > RELAY_MAX_REQUEST) {
      answer(failClosed('archon:relay', 'the judge relay request is over 1 MB'));
      return;
    }
    chunks.push(chunk);
    if (!chunk.includes(10)) return;
    started = true;
    const text = Buffer.concat(chunks).toString('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.slice(0, text.indexOf('\n')));
    } catch {
      parsed = undefined;
    }
    const call = relayedCall(parsed);
    if (!call) {
      answer(failClosed('archon:relay', 'the judge relay request is malformed'));
      return;
    }
    void judgeCall(call, config).then(answer);
  });
  socket.on('end', () => {
    if (!started) answer(failClosed('archon:relay', 'the judge relay request was incomplete'));
  });
}

/**
 * What the client sends: the call with its input clipped as the guard would clip it and
 * Archon's hook plumbing left out of its env (the server clips again; both are no-ops
 * the second time), so a large write or patch never reaches the size cap.
 */
export function relayRequest(call: ShadowCall): string {
  return JSON.stringify({
    ...call,
    toolInput: guardToolInput(call.toolName, call.toolInput),
    env: judgeEnv(call.env),
    ...(call.userRequest !== undefined ? { userRequest: call.userRequest.slice(0, 4_000) } : {}),
  });
}

/** A verdict line from the relay, or undefined when it is not one. */
function readVerdict(line: string): GuardVerdict | undefined {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(v)) return undefined;
  if (v.decision !== 'allow' && v.decision !== 'deny') return undefined;
  if (typeof v.reason !== 'string' || typeof v.stage !== 'string') return undefined;
  if (v.mode !== undefined && typeof v.mode !== 'string') return undefined;
  if (v.enforced !== undefined && typeof v.enforced !== 'boolean') return undefined;
  return {
    decision: v.decision,
    reason: v.reason,
    stage: v.stage,
    ...(v.mode !== undefined ? { mode: v.mode } : {}),
    ...(v.enforced !== undefined ? { enforced: v.enforced } : {}),
  };
}

/** Ask the relay at `path` for the call's verdict. Never rejects; a failure says why. */
export function askRelay(
  path: string,
  call: ShadowCall,
  timeoutMs: number = RELAY_CLIENT_MS
): Promise<{ verdict: GuardVerdict } | { error: string }> {
  return new Promise(resolve => {
    let payload: string;
    try {
      payload = relayRequest(call);
    } catch (err) {
      resolve({ error: `request not built: ${(err as Error).message}` });
      return;
    }
    if (Buffer.byteLength(payload) >= RELAY_MAX_REQUEST) {
      resolve({ error: 'request over 1 MB' });
      return;
    }
    let settled = false;
    let out = '';
    let socket: Socket | undefined;
    const done = (r: { verdict: GuardVerdict } | { error: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      resolve(r);
    };
    const fromLine = (line: string): void => {
      const verdict = readVerdict(line);
      done(verdict ? { verdict } : { error: 'no readable verdict' });
    };
    const timer = setTimeout(() => {
      done({ error: `no verdict in ${String(timeoutMs / 1000)} s` });
    }, timeoutMs);
    try {
      socket = createConnection({ path });
    } catch (err) {
      done({ error: `unreachable: ${(err as Error).message}` });
      return;
    }
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket?.write(`${payload}\n`);
    });
    socket.on('data', (c: string) => {
      out += c;
      const nl = out.indexOf('\n');
      if (nl !== -1) fromLine(out.slice(0, nl));
      else if (out.length > RELAY_MAX_RESPONSE) done({ error: 'answer too large' });
    });
    socket.on('error', (e: NodeJS.ErrnoException) => {
      done({ error: `unreachable: ${e.code ?? e.message}` });
    });
    socket.on('close', () => {
      if (out.trim()) fromLine(out.trim());
      else done({ error: 'closed with no verdict' });
    });
  });
}

/**
 * The dispatcher's judge: the server's relay when the spec pins one, else judgeCall here.
 * A relay failure falls back to judgeCall with what is left of the budget, its reason in
 * the call's log line; with too little left the call is denied. Never rejects.
 */
export async function relayJudge(call: ShadowCall, config: JevShadowConfig): Promise<GuardVerdict> {
  if (!config.relay) return judgeCall(call, config);
  const started = performance.now();
  const answer = await askRelay(config.relay, call, RELAY_CLIENT_MS);
  if ('verdict' in answer) return answer.verdict;
  const note = `judge relay: ${answer.error}`.slice(0, 160);
  const left = Math.floor(RELAY_CLIENT_MS - (performance.now() - started));
  if (left < MIN_FALLBACK_MS) {
    const verdict = failClosed('archon:relay', `the judge relay gave no verdict (${answer.error})`);
    logGuardCall(config, call, verdict, Math.round(performance.now() - started), note);
    return verdict;
  }
  return judgeCall(call, config, Math.min(JUDGE_KILL_MS, left), note);
}
