/**
 * Archon's hook dispatcher for the Codex and Grok CLIs.
 *
 * Why this exists: Claude nodes get their workflow hooks, tool allow/deny lists and
 * the worktree path guard as in-process SDK callbacks. Codex and Grok run as
 * separate CLIs on the user's subscriptions, so the same rules must reach them as
 * CLI hooks. Both CLIs load hooks from a global, always-trusted location
 * (`~/.codex/hooks.json`, `~/.grok/hooks/*.json`); cli-hooks.ts installs ONE
 * command there that runs this file. A run switches it on by naming a spec file in
 * ARCHON_HOOK_SPEC (and the events it needs in ARCHON_HOOK_EVENTS); with neither,
 * the installed command exits before starting Bun, so interactive sessions in the
 * same sandbox are not affected.
 *
 * Verified live (codex 0.157, grok 1.0.41): hook processes inherit the CLI's
 * environment, stdin carries Claude's snake_case fields (`hook_event_name`,
 * `tool_name`, `tool_input`; Grok adds camelCase twins), and a Claude-shaped
 * `hookSpecificOutput.permissionDecision: "deny"` blocks the call in both.
 *
 * For PreToolUse the dispatcher applies, in order: the path guard (no file writes
 * outside the worktree, as path-guard-hook.ts does for Claude), the node's tool
 * allow/deny list, then the node's static hook responses by matcher. Every other
 * event only replays the node's static responses. A PreToolUse that cannot read
 * its spec DENIES (fail closed); both CLIs treat a crashed hook as "allow".
 *
 * Usage (from the installed hook command): bun hook-dispatcher.ts <ClaudeEventName>
 */
import { readFileSync } from 'node:fs';
import { validatePath } from './tools/path-validation';

export const HOOK_SPEC_ENV = 'ARCHON_HOOK_SPEC';
export const HOOK_EVENTS_ENV = 'ARCHON_HOOK_EVENTS';

/** One static hook from workflow YAML (same shape as WorkflowHookMatcher). */
export interface HookMatcherSpec {
  matcher?: string;
  response: Record<string, unknown>;
  timeout?: number;
}

export type HookSpecsByEvent = Partial<Record<string, HookMatcherSpec[]>>;

/** What a run hands the dispatcher, as JSON in the file named by ARCHON_HOOK_SPEC. */
export interface HookRunSpec {
  version: 1;
  provider: 'codex' | 'grok';
  /** The node's working directory (the worktree). */
  cwd: string;
  /** Deny file writes that resolve outside `cwd` (always on for workflow runs). */
  pathGuard: boolean;
  /** Claude built-in tool names the node may use; undefined = no restriction. */
  allowedTools?: string[];
  /** Claude tool names the node may not use (MCP globs like `mcp__github__*` allowed). */
  deniedTools?: string[];
  /** The node's YAML hooks, by Claude event name. */
  hooks?: HookSpecsByEvent;
}

/** The subset of a hook's stdin the dispatcher reads (both CLIs send these keys). */
export interface HookInput {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: unknown;
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
 * Grok tool ids -> Claude names, the reverse of grok.ts's CLAUDE_TO_GROK_TOOLS
 * (checked against a live run's available_commands, grok 1.0.41).
 */
const GROK_TO_CLAUDE: Record<string, string[]> = {
  run_terminal_command: ['Bash'],
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
    const line = raw.trimEnd();
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
  provider: HookRunSpec['provider'],
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

function denyOutput(reason: string): Record<string, unknown> {
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
    if (spec.pathGuard) {
      for (const p of view.writes) {
        try {
          validatePath(p, spec.cwd);
        } catch {
          return denyOutput(
            `${view.names[0]} blocked: path "${p}" is outside the working directory ` +
              `"${spec.cwd}". Files outside the working directory are read-only for ` +
              `this run. Re-issue the call with a path inside ${spec.cwd}.`
          );
        }
      }
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

/** Entry point for the installed hook command. Never throws. */
export function runDispatcher(
  event: string,
  stdin: string,
  env: Record<string, string | undefined>
): { stdout: string; exitCode: number } {
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
  const out = dispatchHook(spec, event, input);
  return { stdout: out ? JSON.stringify(out) : '', exitCode: 0 };
}

if (import.meta.main) {
  const event = process.argv[2] ?? '';
  const chunks: Buffer[] = [];
  process.stdin.on('data', (c: Buffer) => chunks.push(c));
  process.stdin.on('end', () => {
    const { stdout, exitCode } = runDispatcher(
      event,
      Buffer.concat(chunks).toString('utf8'),
      process.env
    );
    if (stdout) process.stdout.write(stdout);
    process.exit(exitCode);
  });
}
