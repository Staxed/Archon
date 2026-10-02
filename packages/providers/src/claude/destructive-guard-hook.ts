/**
 * PreToolUse destructive-command hook for the Claude Agent SDK.
 *
 * The SDK runs its own Bash tool, so the destructive-command guard reaches Claude
 * nodes as a hook. Codex and Grok get the same check from the CLI hook dispatcher
 * (shared/cli-hooks/hook-dispatcher.ts). See shared/destructive-guard.ts for the rules.
 */
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { createLogger } from '@archon/paths';
import { checkCommand } from '../shared/destructive-guard';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.claude.destructive-guard');
  return cachedLog;
}

/** Mirrors the SDK's PreToolUse hook-specific output. */
export interface PreToolUseHookResult {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow' | 'deny';
    permissionDecisionReason?: string;
  };
}

/** No opinion: the SDK's other hooks and permission mode decide. */
const NO_OPINION = { continue: true } as const;

/** Build a PreToolUse hook that denies destructive Bash commands; `cwd` is the node's. */
export function createPreToolUseDestructiveGuardHook(cwd: string): HookCallback {
  return (async (input: Record<string, unknown>) => {
    if ((input as { tool_name?: string }).tool_name !== 'Bash') return NO_OPINION;
    const toolInput = (input as { tool_input?: Record<string, unknown> }).tool_input ?? {};
    const command = typeof toolInput.command === 'string' ? toolInput.command : '';
    if (!command) return NO_OPINION;
    const hookCwd = (input as { cwd?: unknown }).cwd;
    const effectiveCwd = typeof hookCwd === 'string' && hookCwd ? hookCwd : cwd;
    const violation = checkCommand(command, effectiveCwd);
    if (!violation) return NO_OPINION;
    getLog().warn(
      { command, cwd: effectiveCwd, rule: violation.rule },
      'claude.pre_tool_use_destructive_blocked'
    );
    const deny: PreToolUseHookResult = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: violation.message(),
      },
    };
    return deny;
  }) as HookCallback;
}
