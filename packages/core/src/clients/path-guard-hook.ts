/**
 * PreToolUse path-guard hook for the Claude Agent SDK.
 *
 * Why this exists: workflow nodes run inside an isolated working directory
 * (a worktree). The Claude Agent SDK uses its own internal Write/Edit/etc.
 * tools — they do NOT go through Archon's tool-loop, so they bypass the
 * `validatePath()` guard that protects Codex/OpenRouter/Llama.cpp. Combined
 * with `bypassPermissions: true`, the SDK will happily write to any absolute
 * path on disk, including files outside the worktree.
 *
 * If the user message or a prior tool result surfaces an absolute path to
 * the source repo (e.g. via `git worktree list`), the model frequently
 * anchors on it and writes its outputs there instead of into the worktree —
 * the downstream bash node then can't find the expected files and the
 * workflow fails opaquely. This hook closes that gap by denying any
 * Write/Edit/MultiEdit/NotebookEdit whose target path resolves outside the
 * agent's cwd.
 *
 * Path semantics intentionally reuse `validatePath()` from the Archon
 * tool-loop so the boundary check is identical across providers — Claude
 * via this hook, the others via their tool implementations.
 */
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { createLogger } from '@archon/paths';
import { validatePath } from './tools/path-validation';

/**
 * Tools whose `file_path` (or `notebook_path`) input must resolve
 * inside the agent's working directory.
 */
export const PATH_GUARDED_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/**
 * Result returned by a PreToolUse hook callback.
 * Mirrors the SDK's `PreToolUseHookSpecificOutput` shape.
 */
export interface PreToolUseHookResult {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow' | 'deny';
    permissionDecisionReason?: string;
  };
}

const ALLOW: PreToolUseHookResult = {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'allow',
  },
};

function deny(reason: string): PreToolUseHookResult {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

/** Lazy logger so tests can intercept `createLogger` via mock.module if needed. */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('client.claude.path-guard');
  return cachedLog;
}

/**
 * Build a PreToolUse hook callback bound to a specific cwd.
 *
 * The returned callback:
 * - Allows any tool not in `PATH_GUARDED_TOOLS` (read-only, search, web, etc.).
 * - Allows guarded tools whose path resolves inside `cwd`.
 * - Denies guarded tools whose path resolves outside `cwd`, returning a
 *   `permissionDecisionReason` that explains the boundary so the model can
 *   self-correct on retry.
 * - Allows guarded tools whose input has no recognizable path field — the
 *   SDK's own input validation will surface that as a malformed call rather
 *   than us silently denying.
 */
export function createPreToolUsePathGuardHook(cwd: string): HookCallback {
  return (async (input: Record<string, unknown>): Promise<PreToolUseHookResult> => {
    const toolName = (input as { tool_name?: string }).tool_name ?? '';
    if (!PATH_GUARDED_TOOLS.has(toolName)) {
      return ALLOW;
    }

    const toolInput = (input as { tool_input?: Record<string, unknown> }).tool_input ?? {};
    const rawPath =
      typeof toolInput.file_path === 'string'
        ? toolInput.file_path
        : typeof toolInput.notebook_path === 'string'
          ? toolInput.notebook_path
          : undefined;

    if (rawPath === undefined) {
      // No path field — let the SDK's own input validation handle it.
      return ALLOW;
    }

    try {
      validatePath(rawPath, cwd);
      return ALLOW;
    } catch {
      const reason =
        `${toolName} blocked: path "${rawPath}" is outside the working ` +
        `directory "${cwd}". Files outside the working directory are read-only ` +
        `for this run. Re-issue the call with a path inside ${cwd}.`;
      getLog().warn({ toolName, filePath: rawPath, cwd }, 'claude.pre_tool_use_path_blocked');
      return deny(reason);
    }
  }) as HookCallback;
}
