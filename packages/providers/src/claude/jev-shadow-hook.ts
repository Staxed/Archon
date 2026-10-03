/**
 * PreToolUse Jev shadow hook for the Claude Agent SDK. LOG-ONLY: it always
 * answers "no opinion", so the destructive-command and path guards and the
 * SDK's permission mode decide exactly as before. See shared/jev-shadow.ts.
 */
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { checkCommand } from '../shared/destructive-guard';
import { JUDGED_TOOLS, shadowJudge, type JevShadowConfig } from '../shared/jev-shadow';
import type { GuardContext } from '../types';

const NO_OPINION = { continue: true } as const;

export interface ClaudeShadowContext {
  /** The env Claude's Bash commands run with (claudeBashEnv of the CLI env). */
  env: Record<string, string | undefined>;
  guardContext?: GuardContext;
  /** Test seam: replaces shared/jev-shadow.ts shadowJudge. */
  judge?: typeof shadowJudge;
}

/** What Archon's destructive floor says about a Bash command ("pass" or the rule). */
function floorVerdict(command: string, cwd: string): string {
  try {
    const v = checkCommand(command, cwd);
    return v ? `deny: ${v.rule}` : 'pass';
  } catch {
    return 'deny: guard-error';
  }
}

export function createPreToolUseJevShadowHook(
  cwd: string,
  config: JevShadowConfig,
  ctx: ClaudeShadowContext
): HookCallback {
  const judge = ctx.judge ?? shadowJudge;
  return (async (input: Record<string, unknown>) => {
    try {
      const toolName = (input as { tool_name?: string }).tool_name ?? '';
      if (!JUDGED_TOOLS.has(toolName)) return NO_OPINION;
      const toolInput = ((input as { tool_input?: unknown }).tool_input ?? {}) as Record<
        string,
        unknown
      >;
      const hookCwd = (input as { cwd?: unknown }).cwd;
      const effectiveCwd = typeof hookCwd === 'string' && hookCwd ? hookCwd : cwd;
      const command = typeof toolInput.command === 'string' ? toolInput.command : '';
      const g = ctx.guardContext;
      void judge(
        {
          provider: 'claude',
          toolName,
          toolInput,
          cwd: effectiveCwd,
          projectRoot: cwd,
          env: ctx.env,
          ...(g?.userRequest !== undefined ? { userRequest: g.userRequest } : {}),
          ...(g?.runId !== undefined ? { runId: g.runId } : {}),
          ...(g?.nodeId !== undefined ? { nodeId: g.nodeId } : {}),
          ...(g?.workflow !== undefined ? { workflow: g.workflow } : {}),
          ...(toolName === 'Bash' && command
            ? { archonGuard: floorVerdict(command, effectiveCwd) }
            : {}),
        },
        config
      );
    } catch {
      // shadow mode: nothing here may affect the call
    }
    return NO_OPINION;
  }) as HookCallback;
}
