/**
 * PreToolUse destructive-command hook for the Claude Agent SDK.
 *
 * The SDK runs its own Bash tool, which never passes through tools/bash.ts, so the
 * destructive-command guard reaches Claude nodes as a hook -- the same way the
 * worktree path guard does (path-guard-hook.ts). Codex and Grok get the same check
 * from hook-dispatcher.ts. See destructive-guard.ts for the rules.
 */
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { createLogger } from '@archon/paths';
import { checkCommand } from './destructive-guard';
import type { PreToolUseHookResult } from './path-guard-hook';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('client.claude.destructive-guard');
  return cachedLog;
}

const ALLOW: PreToolUseHookResult = {
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
};

/** Build a PreToolUse hook that denies destructive Bash commands; `cwd` is the node's. */
export function createPreToolUseDestructiveGuardHook(cwd: string): HookCallback {
  return (async (input: Record<string, unknown>): Promise<PreToolUseHookResult> => {
    if ((input as { tool_name?: string }).tool_name !== 'Bash') return ALLOW;
    const toolInput = (input as { tool_input?: Record<string, unknown> }).tool_input ?? {};
    const command = typeof toolInput.command === 'string' ? toolInput.command : '';
    if (!command) return ALLOW;
    const hookCwd = (input as { cwd?: unknown }).cwd;
    const effectiveCwd = typeof hookCwd === 'string' && hookCwd ? hookCwd : cwd;
    const violation = checkCommand(command, effectiveCwd);
    if (!violation) return ALLOW;
    getLog().warn(
      { command, cwd: effectiveCwd, rule: violation.rule },
      'claude.pre_tool_use_destructive_blocked'
    );
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: violation.message(),
      },
    };
  }) as HookCallback;
}
