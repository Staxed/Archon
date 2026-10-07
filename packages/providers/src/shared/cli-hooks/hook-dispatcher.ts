/**
 * Archon's hook dispatcher for the subscription CLIs (Codex, Grok).
 *
 * Why this exists: Claude nodes get their workflow hooks and tool allow/deny
 * lists as in-process SDK callbacks. Codex and Grok run as separate CLIs on the
 * user's subscriptions, so the same rules must reach them as CLI hooks. Both
 * CLIs load hooks from a global, always-trusted location (`~/.codex/hooks.json`,
 * `~/.grok/hooks/*.json`); install.ts puts ONE command there that runs this
 * file. A run switches it on by naming a spec file in ARCHON_HOOK_SPEC (and the
 * events it needs in ARCHON_HOOK_EVENTS); with neither, the installed command
 * exits before starting Bun, so interactive CLI sessions are not affected.
 *
 * Verified live (codex 0.157, grok 1.0.41): hook processes inherit the CLI's
 * environment, stdin carries Claude's snake_case fields (`hook_event_name`,
 * `tool_name`, `tool_input`; Grok adds camelCase twins), and a Claude-shaped
 * `hookSpecificOutput.permissionDecision: "deny"` blocks the call in both.
 *
 * For PreToolUse the dispatcher applies, in order: the path guard (no file
 * writes outside the working directory), the destructive-command guard on shell
 * calls (../destructive-guard.ts), the node's tool allow/deny list, then
 * the node's static hook responses by matcher. Every other event only replays
 * the node's static responses. A PreToolUse that cannot read its spec DENIES
 * (fail closed); both CLIs treat a crashed hook as "allow". A PreToolUse those
 * guards let through then waits for the Jev guard (../jev-shadow.ts, stixed's
 * session guard, profile "archon"): its enforced deny, or no verdict at all
 * (crash, 40 s), is printed as the same deny. A log-only would-deny lets the call
 * run. The verdict comes from the Archon server through its judge relay
 * (../jev-relay.ts, a unix socket pinned in the spec), because the judge stage needs
 * the Claude login and this process, a child of the CLI, never has it; a relay it
 * cannot reach leaves the call to the guard run here, without the judge. The deny is the Claude-shaped JSON on stdout with exit 0 for both CLIs
 * (Grok treats a non-zero exit as a failed hook and fails open).
 *
 * This file is executed directly by the CLIs (`bun hook-dispatcher.ts <Event>`),
 * so it keeps its imports to node built-ins and small sibling modules.
 */
import { readFileSync } from 'node:fs';
import { validatePath } from './path-validation';
import { checkCommand, shellQuote } from '../destructive-guard';
import {
  callContext,
  claudeShapedCall,
  jevDecidesFor,
  type GuardVerdict,
  type JevShadowConfig,
  type ShadowCall,
} from '../jev-shadow';
import { relayJudge } from '../jev-relay';
import type { GuardContext } from '../../types';

export const HOOK_SPEC_ENV = 'ARCHON_HOOK_SPEC';
export const HOOK_EVENTS_ENV = 'ARCHON_HOOK_EVENTS';

/** One static hook from workflow YAML (same shape as WorkflowHookMatcher). */
export interface HookMatcherSpec {
  matcher?: string;
  response: Record<string, unknown>;
  timeout?: number;
}

export type HookSpecsByEvent = Partial<Record<string, HookMatcherSpec[]>>;

export type HookCliProvider = 'codex' | 'grok';

/** What a run hands the dispatcher, as JSON in the file named by ARCHON_HOOK_SPEC. */
export interface HookRunSpec {
  version: 1;
  provider: HookCliProvider;
  /** The node's working directory (the worktree). */
  cwd: string;
  /** Deny file writes that resolve outside `cwd`. */
  pathGuard: boolean;
  /** Claude built-in tool names the node may use; undefined = no restriction. */
  allowedTools?: string[];
  /** Claude tool names the node may not use (MCP globs like `mcp__github__*` allowed). */
  deniedTools?: string[];
  /** The node's YAML hooks, by Claude event name. */
  hooks?: HookSpecsByEvent;
  /**
   * The destructive-command rules file the Archon server resolved (null: the
   * built-in defaults). Carried here, not in the CLI's environment, so a
   * project's env cannot point the guard at a weaker file.
   */
  rulesPath?: string | null;
  /**
   * The Jev guard the server resolved (null: off). Pinned here like rulesPath,
   * so a project's env cannot point it at other scripts.
   */
  jevShadow?: JevShadowConfig | null;
  /** The run, node, request and its source behind this CLI session (for the Jev guard). */
  guardContext?: GuardContext;
}

/** The subset of a hook's stdin the dispatcher reads (both CLIs send these keys). */
export interface HookInput {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: unknown;
  cwd?: string;
  source?: string;
  trigger?: string;
  reason?: string;
  notification_type?: string;
  agent_type?: string;
  [key: string]: unknown;
}

/** A Claude tool name plus, for file-writing tools, the paths it would write. */
interface ToolView {
  /** Claude names this call counts as (allowed if any is allowed, denied if any is denied). */
  names: string[];
  /** Paths the call writes; checked by the path guard. */
  writes: string[];
  /** MCP (or MCP dispatcher) call: exempt from the built-in allowlist, like Claude's `tools`. */
  mcp: boolean;
}

/**
 * Grok tool ids -> Claude names, the reverse of the Grok provider's
 * CLAUDE_TO_GROK_TOOLS (checked against a live run's available_commands, grok 1.0.41).
 */
const GROK_TO_CLAUDE: Record<string, string[]> = {
  run_terminal_command: ['Bash'],
  // the name Grok's headless docs give its shell tool; Grok also maps `Bash` itself
  run_terminal_cmd: ['Bash'],
  Bash: ['Bash'],
  kill_command_or_subagent: ['Bash'],
  get_command_or_subagent_output: ['Bash'],
  read_file: ['Read'],
  search_replace: ['Edit', 'MultiEdit', 'NotebookEdit'],
  write: ['Write'],
  // seen live: under `--tools read_file` the model asked use_tool for `write_file`
  write_file: ['Write'],
  list_dir: ['Glob', 'LS'],
  grep: ['Grep'],
  web_search: ['WebSearch'],
  web_fetch: ['WebFetch'],
  spawn_subagent: ['Task', 'Agent'],
  todo_write: ['TodoWrite'],
};

/** Codex tool names -> Claude names (Bash and apply_patch verified live; the rest by name). */
const CODEX_TO_CLAUDE: Record<string, string[]> = {
  Bash: ['Bash'],
  shell: ['Bash'],
  exec_command: ['Bash'],
  local_shell: ['Bash'],
  container_exec: ['Bash'],
  // types into a running exec session: the keystrokes are a command line too
  write_stdin: ['Bash'],
  update_plan: ['TodoWrite'],
  view_image: ['Read'],
  web_search: ['WebSearch'],
};

/**
 * The files an apply_patch envelope touches, with the Claude tool each operation
 * counts as: adding a file is a Write, updating/deleting/moving one is an Edit.
 */
export function parseApplyPatch(patch: string): { op: 'Write' | 'Edit'; path: string }[] {
  const out: { op: 'Write' | 'Edit'; path: string }[] = [];
  for (const raw of patch.split('\n')) {
    // Codex reads a header with its indentation stripped
    const line = raw.trim();
    const m = /^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/.exec(line);
    if (!m) continue;
    out.push({ op: m[1] === 'Add File' ? 'Write' : 'Edit', path: m[2].trim() });
  }
  return out;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export function toolView(
  provider: HookCliProvider,
  toolName: string,
  toolInput: unknown
): ToolView {
  const input = (toolInput && typeof toolInput === 'object' ? toolInput : {}) as Record<
    string,
    unknown
  >;
  if (toolName.startsWith('mcp__')) return { names: [toolName], writes: [], mcp: true };

  if (provider === 'codex') {
    if (toolName === 'apply_patch') {
      const patch = str(input.command) ?? str(input.patch) ?? str(input.input) ?? '';
      const ops = parseApplyPatch(patch);
      const names = new Set<string>();
      for (const o of ops) {
        if (o.op === 'Write') names.add('Write');
        else ['Edit', 'MultiEdit'].forEach(n => names.add(n));
      }
      if (names.size === 0) names.add('Edit');
      return { names: [...names], writes: ops.map(o => o.path), mcp: false };
    }
    return { names: CODEX_TO_CLAUDE[toolName] ?? [toolName], writes: [], mcp: false };
  }

  // grok
  if (toolName === 'search_tool' || toolName === 'use_tool') {
    return { names: [toolName], writes: [], mcp: true };
  }
  // an MCP call routed through use_tool appears as the qualified `server__tool`
  if (!(toolName in GROK_TO_CLAUDE) && toolName.includes('__')) {
    return { names: [`mcp__${toolName}`], writes: [], mcp: true };
  }
  const names = GROK_TO_CLAUDE[toolName] ?? [toolName];
  const isWrite = names.includes('Write') || names.includes('Edit');
  const path =
    str(input.file_path) ?? str(input.target_file) ?? str(input.notebook_path) ?? str(input.path);
  return { names, writes: isWrite && path ? [path] : [], mcp: false };
}

/** The shell command a Bash-like call would run: a string, or Codex's argv array. */
export function shellCommand(toolInput: unknown): string | undefined {
  if (!toolInput || typeof toolInput !== 'object') return undefined;
  const input = toolInput as Record<string, unknown>;
  const raw = input.command ?? input.cmd ?? input.chars;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && raw.every((a): a is string => typeof a === 'string')) {
    // ['bash', '-lc', 'script'] -> a line a shell parser reads back into the same argv
    return raw.map(shellQuote).join(' ');
  }
  return undefined;
}

/** The directory a shell call runs in: its own workdir/cwd, else the hook's, else the node's. */
export function shellCwd(input: HookInput, fallback: string): string {
  const toolInput = (
    input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {}
  ) as Record<string, unknown>;
  const base = str(input.cwd) ?? fallback;
  const own = str(toolInput.workdir) ?? str(toolInput.cwd);
  if (!own) return base;
  return own.startsWith('/') ? own : `${base.replace(/\/+$/, '')}/${own}`;
}

/** Claude-style tool pattern: exact name, or a trailing `*` glob (`mcp__github__*`). */
function toolPatternMatches(pattern: string, name: string): boolean {
  if (pattern === '*' || pattern === name) return true;
  if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
  return false;
}

/**
 * A YAML hook matcher, as the Claude SDK reads it: omitted, empty or `*` matches
 * everything; otherwise a regex over the whole value (`Write|Edit`).
 */
export function matcherMatches(matcher: string | undefined, values: string[]): boolean {
  if (matcher === undefined || matcher === '' || matcher === '*') return true;
  let re: RegExp;
  try {
    re = new RegExp(`^(?:${matcher})$`);
  } catch {
    return values.includes(matcher);
  }
  return values.some(v => re.test(v));
}

export function denyOutput(reason: string): Record<string, unknown> {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

function isDenyResponse(r: Record<string, unknown>): boolean {
  const hso = r.hookSpecificOutput as Record<string, unknown> | undefined;
  return hso?.permissionDecision === 'deny' || r.decision === 'block' || r.decision === 'deny';
}

/** The value a non-tool event's matcher is tested against, per Claude's hook docs. */
function eventSubject(input: HookInput): string[] {
  const v =
    input.source ?? input.trigger ?? input.notification_type ?? input.agent_type ?? input.reason;
  return typeof v === 'string' ? [v] : [];
}

/**
 * Guards checked on PreToolUse before the node's own rules. Each returns a deny
 * reason or undefined. Kept as a list so a guard can be added without touching
 * the dispatch order below.
 */
export type PreToolGuard = (
  spec: HookRunSpec,
  input: HookInput,
  view: { names: string[]; writes: string[] }
) => string | undefined;

const pathGuard: PreToolGuard = (spec, _input, view) => {
  if (!spec.pathGuard) return undefined;
  for (const p of view.writes) {
    try {
      validatePath(p, spec.cwd);
    } catch {
      return (
        `${view.names[0]} blocked: path "${p}" is outside the working directory ` +
        `"${spec.cwd}". Files outside the working directory are read-only for ` +
        `this run. Re-issue the call with a path inside ${spec.cwd}.`
      );
    }
  }
  return undefined;
};

/** Shell calls (Bash-like on either CLI) must not destroy what git cannot restore. */
const destructiveGuard: PreToolGuard = (spec, input, view) => {
  if (!view.names.includes('Bash')) return undefined;
  const command = shellCommand(input.tool_input);
  if (!command) return undefined;
  // The server decided the rules file; the CLI's env (fed by the project) does not.
  const rules = 'rulesPath' in spec ? { rulesPath: spec.rulesPath ?? null } : {};
  // Rules flagged moves_to_jev are left to the Jev guard when it enforces for this run.
  return checkCommand(command, shellCwd(input, spec.cwd), {
    ...rules,
    jevDecides: jevDecidesFor(spec.jevShadow),
  })?.message();
};

export const PRE_TOOL_GUARDS: PreToolGuard[] = [pathGuard, destructiveGuard];

/**
 * Decide one hook event. Returns the JSON to print (Claude's hook output shape,
 * which both CLIs accept) or undefined for "no opinion".
 */
export function dispatchHook(
  spec: HookRunSpec,
  event: string,
  input: HookInput
): Record<string, unknown> | undefined {
  const toolName = str(input.tool_name);
  const view = toolName ? toolView(spec.provider, toolName, input.tool_input) : undefined;

  if (event === 'PreToolUse' && view && toolName) {
    for (const guard of PRE_TOOL_GUARDS) {
      const reason = guard(spec, input, view);
      if (reason) return denyOutput(reason);
    }
    const denied = spec.deniedTools ?? [];
    const hit = view.names.find(n => denied.some(p => toolPatternMatches(p, n)));
    if (hit) {
      return denyOutput(`${hit} is not allowed in this workflow node (denied_tools).`);
    }
    if (spec.allowedTools !== undefined && !view.mcp) {
      const allowed = spec.allowedTools;
      if (!view.names.some(n => allowed.some(p => toolPatternMatches(p, n)))) {
        return denyOutput(
          `${view.names[0]} is not allowed in this workflow node (allowed_tools: ${
            allowed.length > 0 ? allowed.join(', ') : 'none'
          }).`
        );
      }
    }
  }

  const matchers = spec.hooks?.[event] ?? [];
  const subjects = view ? [...view.names, ...(toolName ? [toolName] : [])] : eventSubject(input);
  const responses = matchers.filter(m => matcherMatches(m.matcher, subjects)).map(m => m.response);
  if (responses.length === 0) return undefined;

  // Claude runs every matching hook and a deny wins; context from the others is kept.
  const deny = responses.find(isDenyResponse);
  if (deny) return deny;
  // A node hook may rewrite the call (updatedInput): the guards judge what will
  // actually run, not what the model asked for.
  if (event === 'PreToolUse' && view && toolName) {
    for (const r of responses) {
      const updated = (r.hookSpecificOutput as Record<string, unknown> | undefined)?.updatedInput;
      if (updated === undefined) continue;
      const rewritten: HookInput = { ...input, tool_input: updated };
      const newView = toolView(spec.provider, toolName, updated);
      for (const guard of PRE_TOOL_GUARDS) {
        const reason = guard(spec, rewritten, newView);
        if (reason) return denyOutput(`${reason} (after this node's hook rewrote the call)`);
      }
    }
  }
  const contexts = responses
    .map(r => (r.hookSpecificOutput as Record<string, unknown> | undefined)?.additionalContext)
    .filter((c): c is string => typeof c === 'string' && c.length > 0);
  const merged: Record<string, unknown> = { ...responses[0] };
  if (contexts.length > 1) {
    merged.hookSpecificOutput = {
      ...(responses[0].hookSpecificOutput as Record<string, unknown> | undefined),
      hookEventName: event,
      additionalContext: contexts.join('\n\n'),
    };
  }
  return merged;
}

/** The judge the dispatcher awaits (tests pass a fake). */
export type GuardJudge = (call: ShadowCall, config: JevShadowConfig) => Promise<GuardVerdict>;

/**
 * The Jev guard's call for a PreToolUse, in Claude's vocabulary, or undefined when
 * the guard has nothing to judge (no guard configured, an MCP call, a read).
 */
export function guardCallFor(
  spec: HookRunSpec,
  input: HookInput,
  env: Record<string, string | undefined>
): ShadowCall | undefined {
  const toolName = str(input.tool_name);
  if (!spec.jevShadow || !toolName) return undefined;
  const view = toolView(spec.provider, toolName, input.tool_input);
  if (view.mcp) return undefined;
  const command = shellCommand(input.tool_input);
  const shaped = claudeShapedCall(view.names, view.writes, input.tool_input, command, toolName);
  if (!shaped) return undefined;
  return {
    provider: spec.provider,
    toolName: shaped.toolName,
    toolInput: shaped.toolInput,
    cwd: shellCwd(input, spec.cwd),
    projectRoot: spec.cwd,
    env,
    ...callContext(spec.guardContext),
    archonGuard: 'pass',
  };
}

/**
 * Decide one hook event, the Jev guard included. A PreToolUse that Archon's own
 * guards and the node's rules let through (`dispatchHook` printed no deny) waits
 * for the Jev guard; its deny is printed as Archon's. When a node hook rewrote
 * the call, the guard judges the rewritten call. Never rejects.
 */
export async function decideHook(
  spec: HookRunSpec,
  event: string,
  input: HookInput,
  env: Record<string, string | undefined>,
  judge: GuardJudge = relayJudge
): Promise<Record<string, unknown> | undefined> {
  let out: Record<string, unknown> | undefined;
  try {
    out = dispatchHook(spec, event, input);
  } catch (err) {
    if (event !== 'PreToolUse') return undefined;
    return denyOutput(
      `Archon hook dispatcher failed (${(err as Error).message}); refusing tool calls for safety.`
    );
  }
  if (event !== 'PreToolUse' || !spec.jevShadow || (out && isDenyResponse(out))) return out;
  const config = spec.jevShadow;
  try {
    const updated = (out?.hookSpecificOutput as Record<string, unknown> | undefined)?.updatedInput;
    const judged: HookInput = updated === undefined ? input : { ...input, tool_input: updated };
    const call = guardCallFor(spec, judged, env);
    if (!call) return out;
    const verdict = await judge(call, config);
    if (verdict.decision !== 'deny') return out;
    return denyOutput(
      updated === undefined
        ? verdict.reason
        : `${verdict.reason} (after this node's hook rewrote the call)`
    );
  } catch (err) {
    return denyOutput(
      `jev-guard: the guard failed (${(err as Error).message}); the call is denied (fail closed).`
    );
  }
}

/** Entry point for the installed hook command. Never rejects. */
export async function runDispatcher(
  event: string,
  stdin: string,
  env: Record<string, string | undefined>,
  judge: GuardJudge = relayJudge
): Promise<{ stdout: string; exitCode: number }> {
  const specPath = env[HOOK_SPEC_ENV];
  if (!specPath) return { stdout: '', exitCode: 0 };
  let spec: HookRunSpec;
  try {
    spec = JSON.parse(readFileSync(specPath, 'utf8')) as HookRunSpec;
  } catch (err) {
    // Fail closed where it matters: a tool call must not run without its guard.
    if (event === 'PreToolUse') {
      return {
        stdout: JSON.stringify(
          denyOutput(
            `Archon hook spec ${specPath} is unreadable (${(err as Error).message}); refusing tool calls for safety.`
          )
        ),
        exitCode: 0,
      };
    }
    return { stdout: '', exitCode: 0 };
  }
  let input: HookInput = {};
  try {
    input = JSON.parse(stdin || '{}') as HookInput;
  } catch {
    // malformed stdin: decide on the event alone
  }
  const out = await decideHook(spec, event, input, env, judge);
  return { stdout: out ? JSON.stringify(out) : '', exitCode: 0 };
}

if (import.meta.main) {
  const event = process.argv[2] ?? '';
  const chunks: Buffer[] = [];
  process.stdin.on('data', (c: Buffer) => chunks.push(c));
  process.stdin.on('end', () => {
    void runDispatcher(event, Buffer.concat(chunks).toString('utf8'), process.env)
      .then(({ stdout, exitCode }) => {
        if (stdout) process.stdout.write(stdout, () => process.exit(exitCode));
        else process.exit(exitCode);
      })
      .catch((err: unknown) => {
        // Never reached (runDispatcher does not reject); a PreToolUse still fails closed.
        if (event === 'PreToolUse') {
          process.stdout.write(
            JSON.stringify(
              denyOutput(
                `Archon hook dispatcher failed (${String(err)}); refusing tool calls for safety.`
              )
            ),
            () => process.exit(0)
          );
        } else {
          process.exit(0);
        }
      });
  });
}
