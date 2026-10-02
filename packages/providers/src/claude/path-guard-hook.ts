/**
 * PreToolUse path guard for the Claude Agent SDK.
 *
 * Workflow nodes run inside an isolated working directory (a worktree), but the
 * SDK's own Write/Edit/MultiEdit/NotebookEdit tools run under
 * `bypassPermissions` and will write to any absolute path. When the prompt or a
 * prior tool result surfaces an absolute path to the source repo (e.g. via
 * `git worktree list`), the model often anchors on it and writes its outputs
 * there; downstream nodes then cannot find them and the run fails opaquely.
 *
 * This hook denies those tools when the target resolves outside the agent's
 * cwd and the run's engine write roots (artifacts, state, logs). The deny
 * reason names the boundary so the model can self-correct. The companion soft
 * guard is `prependCwdNotice` in @archon/workflows.
 */
import { isAbsolute, resolve } from 'node:path';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { createLogger, isPathInside } from '@archon/paths';

/** Tools whose `file_path` (or `notebook_path`) must stay inside the writable roots. */
export const PATH_GUARDED_TOOLS: ReadonlySet<string> = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
]);

/** Mirrors the SDK's PreToolUse hook-specific output shape. */
export interface PreToolUseHookResult {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow' | 'deny';
    permissionDecisionReason?: string;
  };
}

/** No decision: the hook passes, leaving the call to the SDK's normal permission flow. */
const PASS = { continue: true } as const;

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.claude.path-guard');
  return cachedLog;
}

/**
 * Build a PreToolUse hook bound to `cwd` plus any extra writable roots.
 *
 * - Tools outside PATH_GUARDED_TOOLS pass untouched (reads, search, Bash, web).
 * - Guarded tools pass when their path resolves inside `cwd` or an extra root.
 * - Guarded tools are denied otherwise, with a reason naming the boundary.
 * - A guarded call with no recognisable path field passes; the SDK's own input
 *   validation reports the malformed call.
 */
export function createPreToolUsePathGuardHook(
  cwd: string,
  extraRoots: readonly string[] = []
): HookCallback {
  const roots = [cwd, ...extraRoots].map(r => resolve(r));
  return (async (input: Record<string, unknown>) => {
    const toolName = (input as { tool_name?: string }).tool_name ?? '';
    if (!PATH_GUARDED_TOOLS.has(toolName)) return PASS;

    const toolInput = (input as { tool_input?: Record<string, unknown> }).tool_input ?? {};
    const rawPath =
      typeof toolInput.file_path === 'string'
        ? toolInput.file_path
        : typeof toolInput.notebook_path === 'string'
          ? toolInput.notebook_path
          : undefined;
    if (rawPath === undefined || rawPath === '') return PASS;

    const target = isAbsolute(rawPath) ? resolve(rawPath) : resolve(cwd, rawPath);
    if (roots.some(root => isPathInside(root, target, { includeRoot: true }))) return PASS;

    getLog().warn({ toolName, filePath: rawPath, cwd }, 'claude.pre_tool_use_path_blocked');
    const result: PreToolUseHookResult = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `${toolName} blocked: path "${rawPath}" is outside the working directory "${cwd}". ` +
          'Files outside the working directory are read-only for this run. ' +
          `Re-issue the call with a path inside ${cwd}.`,
      },
    };
    return result;
  }) as HookCallback;
}
