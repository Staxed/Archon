/**
 * PreToolUse Jev guard hook for the Claude Agent SDK (shared/jev-shadow.ts).
 *
 * It waits for stixed's session guard (profile "archon") and answers
 * `permissionDecision: deny` with the guard's reason when the Decision is an
 * enforced deny, or when no Decision came (crash, 40 s backstop): fail closed.
 * An allow, or a log-only would-deny, is "no opinion": the destructive-command
 * and path guards and the SDK's permission mode decide as before.
 *
 * A Bash call Archon's destructive floor already refuses is not sent: the floor
 * hook denies it on its own and the guard has nothing to add. The floor is asked as
 * the floor hook asks it: in `enforce` it leaves the rules flagged `moves_to_jev` to
 * this guard, so those calls are sent.
 */
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { checkCommand } from '../shared/destructive-guard';
import {
  JUDGED_TOOLS,
  RecentBlocks,
  callContext,
  jevDecidesFor,
  judgeCall,
  readArchonGuardMode,
  type GuardVerdict,
  type JevGuardMode,
  type JevShadowConfig,
  type ShadowCall,
} from '../shared/jev-shadow';
import type { GuardContext } from '../types';

const NO_OPINION = { continue: true } as const;

/** The SDK hook timeout for this matcher, in seconds (the guard's backstop is 40 s). */
export const JEV_GUARD_HOOK_TIMEOUT_S = 45;

export interface ClaudeShadowContext {
  /** The env Claude's Bash commands run with (claudeBashEnv of the CLI env). */
  env: Record<string, string | undefined>;
  guardContext?: GuardContext;
  /** The session's own recent refusals (test seam; default: a fresh one per hook). */
  blocks?: RecentBlocks;
  /** Test seam: replaces shared/jev-shadow.ts judgeCall. */
  judge?: (call: ShadowCall, config: JevShadowConfig) => Promise<GuardVerdict>;
  /** Test seam: replaces readArchonGuardMode. */
  mode?: () => JevGuardMode;
}

/** The PreToolUse deny the SDK reads. */
export function claudeDeny(reason: string): Record<string, unknown> {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

/** Archon's destructive floor on a Bash command: undefined = pass, else the rule. */
function floorRule(command: string, cwd: string, jevDecides: boolean): string | undefined {
  try {
    return checkCommand(command, cwd, { jevDecides })?.rule;
  } catch {
    return 'guard-error';
  }
}

export function createPreToolUseJevShadowHook(
  cwd: string,
  config: JevShadowConfig,
  ctx: ClaudeShadowContext
): HookCallback {
  const judge = ctx.judge ?? judgeCall;
  // This node session's own refusals, so the guard sees a retry as one (recent_blocked_calls).
  const blocks = ctx.blocks ?? new RecentBlocks();
  const mode = ctx.mode ?? readArchonGuardMode;
  return (async (input: Record<string, unknown>) => {
    let call: ShadowCall;
    try {
      const toolName = (input as { tool_name?: string }).tool_name ?? '';
      if (!JUDGED_TOOLS.has(toolName)) return NO_OPINION;
      const raw = (input as { tool_input?: unknown }).tool_input;
      const toolInput = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      const hookCwd = (input as { cwd?: unknown }).cwd;
      const effectiveCwd = typeof hookCwd === 'string' && hookCwd ? hookCwd : cwd;
      const command = typeof toolInput.command === 'string' ? toolInput.command : '';
      if (
        toolName === 'Bash' &&
        command &&
        floorRule(command, effectiveCwd, jevDecidesFor(config, mode)) !== undefined
      ) {
        return NO_OPINION; // the destructive-guard hook refuses it
      }
      call = {
        provider: 'claude',
        toolName,
        toolInput,
        cwd: effectiveCwd,
        projectRoot: cwd,
        env: ctx.env,
        ...callContext(ctx.guardContext),
        ...(toolName === 'Bash' ? { archonGuard: 'pass' } : {}),
        recentBlockedCalls: blocks.list(),
      };
    } catch (err) {
      return claudeDeny(
        `jev-guard: the call could not be read for judging (${(err as Error).message}); denied (fail closed).`
      );
    }
    try {
      const verdict = await judge(call, config);
      if (verdict.decision !== 'deny') return NO_OPINION;
      blocks.add(call, verdict);
      return claudeDeny(verdict.reason);
    } catch (err) {
      return claudeDeny(
        `jev-guard: the guard failed (${(err as Error).message}); the call is denied (fail closed).`
      );
    }
  }) as HookCallback;
}
