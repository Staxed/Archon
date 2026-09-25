/**
 * Installs Archon's hook dispatcher (hook-dispatcher.ts) into the Codex and Grok
 * CLIs' global hook locations and prepares each run's hook spec.
 *
 * - Grok: ~/.grok/hooks/archon-dispatcher.json, a file Archon owns. Global hook
 *   files are always trusted.
 * - Codex: ~/.codex/hooks.json, merged (the user's own hooks are kept). Codex runs
 *   a non-managed hook only when config holds `hooks.state."<file>:<event>:<group>:<handler>".trusted_hash`
 *   equal to the hook's hash. Archon never edits config.toml: each run passes the
 *   trust as a `-c hooks.state={...}` override that also carries every entry already
 *   in config.toml (a dotted `-c hooks.state."<path>"...` key is split at the dots of
 *   the path, so the whole table goes inline). The hash is sha256 of the canonical
 *   JSON of {event_name, hooks: [handler]} with the handler's defaults filled in
 *   (reproduced from a hash Codex wrote itself, and verified by a live run).
 *
 * The installed command is `case ",$ARCHON_HOOK_EVENTS," in *,<Event>,*) exec bun
 * hook-dispatcher.ts <Event>;; esac`, so an event costs a Bun start only in a run
 * that asked for it.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HOOK_EVENTS_ENV,
  HOOK_SPEC_ENV,
  type HookRunSpec,
  type HookSpecsByEvent,
} from './hook-dispatcher';

/** Claude hook events the Codex CLI fires (codex 0.157), with Codex's snake_case name. */
export const CODEX_HOOK_EVENTS: Record<string, string> = {
  PreToolUse: 'pre_tool_use',
  PermissionRequest: 'permission_request',
  PostToolUse: 'post_tool_use',
  PreCompact: 'pre_compact',
  SessionStart: 'session_start',
  SessionEnd: 'session_end',
  SubagentStart: 'subagent_start',
  SubagentStop: 'subagent_stop',
  UserPromptSubmit: 'user_prompt_submit',
  Stop: 'stop',
};

/** Claude hook events the Grok CLI fires (grok 1.0.41, ~/.grok/docs/user-guide/10-hooks.md). */
export const GROK_HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
];

const MARKER = HOOK_EVENTS_ENV;

export function supportedHookEvents(provider: 'codex' | 'grok'): string[] {
  return provider === 'codex' ? Object.keys(CODEX_HOOK_EVENTS) : GROK_HOOK_EVENTS;
}

/** Events a node's YAML hooks use that the CLI never fires (refused, never dropped). */
export function unsupportedHookEvents(
  provider: 'codex' | 'grok',
  hooks: HookSpecsByEvent | undefined
): string[] {
  const ok = new Set(supportedHookEvents(provider));
  return Object.entries(hooks ?? {})
    .filter(([event, list]) => (list?.length ?? 0) > 0 && !ok.has(event))
    .map(([event]) => event);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Absolute path of hook-dispatcher.ts next to this file. */
export function dispatcherScriptPath(): string {
  return fileURLToPath(new URL('./hook-dispatcher.ts', import.meta.url));
}

export function dispatcherCommand(
  event: string,
  runtime: string = process.execPath,
  script: string = dispatcherScriptPath()
): string {
  return `case ",\${${MARKER}:-}," in *,${event},*) exec ${shellQuote(runtime)} ${shellQuote(script)} ${event} ;; esac`;
}

function assertDispatcherPresent(script: string): void {
  if (!existsSync(script)) {
    throw new Error(
      `Archon's hook dispatcher is missing at ${script}. Codex and Grok nodes need Archon running from source so the CLI hooks can start it.`
    );
  }
}

/** Write only when the content changed, via a same-directory rename (parallel nodes). */
function writeIfChanged(path: string, content: string): void {
  try {
    if (readFileSync(path, 'utf8') === content) return;
  } catch {
    // missing: write it
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.archon-${randomUUID()}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

/** JSON with object keys sorted at every level and no whitespace. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Codex's trusted_hash for a command handler with no matcher and default settings. */
export function codexHookHash(eventSnake: string, command: string): string {
  const normalized = {
    event_name: eventSnake,
    hooks: [{ async: false, command, timeout: 600, type: 'command' }],
  };
  return `sha256:${createHash('sha256').update(canonicalJson(normalized)).digest('hex')}`;
}

function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), '.codex');
}

function grokHome(): string {
  return process.env.GROK_HOME ?? join(homedir(), '.grok');
}

interface CodexHookGroup {
  matcher?: string;
  hooks?: { type?: string; command?: string }[];
}

function isArchonGroup(g: CodexHookGroup): boolean {
  return (g.hooks ?? []).some(h => typeof h.command === 'string' && h.command.includes(MARKER));
}

/**
 * Merge the dispatcher into $CODEX_HOME/hooks.json and return the trust entries
 * ("<file>:<event>:<group>:0" -> hash) for it. The user's own groups are kept in
 * place; Archon's are replaced by the current command.
 */
export function ensureCodexDispatcher(
  runtime: string = process.execPath,
  script: string = dispatcherScriptPath()
): Record<string, string> {
  assertDispatcherPresent(script);
  const path = join(codexHome(), 'hooks.json');
  let doc: { hooks?: Record<string, CodexHookGroup[]>; [k: string]: unknown } = {};
  if (existsSync(path)) {
    try {
      doc = JSON.parse(readFileSync(path, 'utf8')) as typeof doc;
    } catch (err) {
      throw new Error(
        `Cannot install Archon's Codex hook: ${path} is not valid JSON (${(err as Error).message}). Fix or remove it.`
      );
    }
  }
  const hooks: Record<string, CodexHookGroup[]> = { ...(doc.hooks ?? {}) };
  const trust: Record<string, string> = {};
  for (const [event, snake] of Object.entries(CODEX_HOOK_EVENTS)) {
    const command = dispatcherCommand(event, runtime, script);
    const groups = (hooks[event] ?? []).filter(g => !isArchonGroup(g));
    groups.push({ hooks: [{ type: 'command', command }] });
    hooks[event] = groups;
    trust[`${path}:${snake}:${groups.length - 1}:0`] = codexHookHash(snake, command);
  }
  writeIfChanged(path, JSON.stringify({ ...doc, hooks }, null, 2) + '\n');
  return trust;
}

function tomlString(s: string): string {
  return JSON.stringify(s); // a JSON string is a valid TOML basic string
}

function tomlScalar(v: unknown): string | undefined {
  if (typeof v === 'string') return tomlString(v);
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  return undefined;
}

/**
 * The `hooks.state={...}` override for a run: every entry already in
 * $CODEX_HOME/config.toml, plus trust for the dispatcher. Unparseable config is
 * treated as having no entries (Codex itself reports a broken config).
 */
export function codexHookTrustOverride(trust: Record<string, string>): string {
  let existing: Record<string, Record<string, unknown>> = {};
  try {
    const cfg = Bun.TOML.parse(readFileSync(join(codexHome(), 'config.toml'), 'utf8')) as {
      hooks?: { state?: Record<string, Record<string, unknown>> };
    };
    existing = cfg.hooks?.state ?? {};
  } catch {
    existing = {};
  }
  const merged: Record<string, Record<string, unknown>> = { ...existing };
  for (const [key, hash] of Object.entries(trust)) {
    merged[key] = { ...(merged[key] ?? {}), trusted_hash: hash };
  }
  const entries = Object.entries(merged).map(([key, fields]) => {
    const inner = Object.entries(fields)
      .map(([k, v]) => {
        const s = tomlScalar(v);
        return s === undefined ? undefined : `${k} = ${s}`;
      })
      .filter((x): x is string => x !== undefined)
      .join(', ');
    return `${tomlString(key)} = { ${inner} }`;
  });
  return `hooks.state={ ${entries.join(', ')} }`;
}

/** Write $GROK_HOME/hooks/archon-dispatcher.json (Archon owns this file). */
export function ensureGrokDispatcher(
  runtime: string = process.execPath,
  script: string = dispatcherScriptPath()
): string {
  assertDispatcherPresent(script);
  const path = join(grokHome(), 'hooks', 'archon-dispatcher.json');
  const hooks: Record<string, unknown[]> = {};
  for (const event of GROK_HOOK_EVENTS) {
    hooks[event] = [
      { hooks: [{ type: 'command', command: dispatcherCommand(event, runtime, script) }] },
    ];
  }
  writeIfChanged(
    path,
    JSON.stringify(
      {
        description:
          "Archon workflow hooks (path guard, tool lists, node hooks). A no-op unless an Archon run sets ARCHON_HOOK_EVENTS. Managed by Archon's cli-hooks.ts; edits are overwritten.",
        hooks,
      },
      null,
      2
    ) + '\n'
  );
  return path;
}

export interface PreparedHookRun {
  /** Env vars that switch the dispatcher on for this run. */
  env: Record<string, string>;
  /** Removes the spec file. Safe to call twice. */
  cleanup: () => void;
}

/** Write a run's spec to a private temp file and return the env that names it. */
export function prepareHookRun(spec: HookRunSpec): PreparedHookRun {
  const dir = join(tmpdir(), 'archon-hook-specs');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${randomUUID()}.json`);
  writeFileSync(path, JSON.stringify(spec), { mode: 0o600 });
  const events = new Set<string>(['PreToolUse']);
  for (const [event, list] of Object.entries(spec.hooks ?? {})) {
    if ((list?.length ?? 0) > 0) events.add(event);
  }
  return {
    env: { [HOOK_SPEC_ENV]: path, [HOOK_EVENTS_ENV]: [...events].join(',') },
    cleanup: (): void => {
      rmSync(path, { force: true });
    },
  };
}
