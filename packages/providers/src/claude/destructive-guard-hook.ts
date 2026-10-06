/**
 * PreToolUse destructive-command hook for the Claude Agent SDK.
 *
 * The SDK runs its own Bash tool, so the destructive-command guard reaches Claude
 * nodes as a hook. Codex and Grok get the same check from the CLI hook dispatcher
 * (shared/cli-hooks/hook-dispatcher.ts). See shared/destructive-guard.ts for the rules.
 */
import type { HookCallback, HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import { createLogger } from '@archon/paths';
import { Violation, checkCommand } from '../shared/destructive-guard';

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

/** The SDK's matcher rule: omitted, empty or `*` match everything, else an anchored regex. */
function matcherMatches(matcher: string | undefined, toolName: string): boolean {
  if (matcher === undefined || matcher === '' || matcher === '*') return true;
  try {
    return new RegExp(`^(?:${matcher})$`).test(toolName);
  } catch {
    return matcher === toolName;
  }
}

function denyOf(out: unknown): PreToolUseHookResult | undefined {
  const hso = (out as { hookSpecificOutput?: { permissionDecision?: unknown } } | undefined)
    ?.hookSpecificOutput;
  return hso?.permissionDecision === 'deny' ? (out as PreToolUseHookResult) : undefined;
}

/**
 * Wrap a node's PreToolUse hooks so a hook that rewrites the call (returns
 * `hookSpecificOutput.updatedInput`) has the rewritten call judged by Archon's
 * own guards (`guards`: the destructive-command and path guards). The SDK runs
 * the guards on the input the model sent, so without this a node hook could turn
 * `ls` into `rm -rf ~` after the guard said yes.
 */
export function guardRewrittenInput(
  nodeMatchers: HookCallbackMatcher[],
  guards: HookCallbackMatcher[]
): HookCallbackMatcher[] {
  if (guards.length === 0) return nodeMatchers;
  return nodeMatchers.map(m => ({
    ...m,
    hooks: m.hooks.map(
      (hook): HookCallback =>
        async (input, toolUseID, options) => {
          const out = await hook(input, toolUseID, options);
          const updated = (out as { hookSpecificOutput?: { updatedInput?: unknown } } | undefined)
            ?.hookSpecificOutput?.updatedInput;
          if (updated === undefined || !updated || typeof updated !== 'object') return out;
          const toolName = (input as { tool_name?: string }).tool_name ?? '';
          const rewritten = { ...input, tool_input: updated } as typeof input;
          for (const g of guards) {
            if (!matcherMatches(g.matcher, toolName)) continue;
            for (const guard of g.hooks) {
              const deny = denyOf(await guard(rewritten, toolUseID, options));
              if (deny) {
                getLog().warn({ toolName }, 'claude.pre_tool_use_rewrite_blocked');
                return {
                  hookSpecificOutput: {
                    ...deny.hookSpecificOutput,
                    permissionDecisionReason: `${deny.hookSpecificOutput.permissionDecisionReason ?? 'Blocked'} (after this node's hook rewrote the call)`,
                  },
                };
              }
            }
          }
          return out;
        }
    ),
  }));
}

/**
 * Build a PreToolUse hook that denies destructive Bash commands; `cwd` is the node's.
 * `jevDecides` (asked per call): the node's Jev guard decides, so the floor leaves it
 * the rules flagged `moves_to_jev`. Default: never, every rule kept.
 */
export function createPreToolUseDestructiveGuardHook(
  cwd: string,
  jevDecides: () => boolean = () => false
): HookCallback {
  return (async (input: Record<string, unknown>) => {
    if ((input as { tool_name?: string }).tool_name !== 'Bash') return NO_OPINION;
    const toolInput = (input as { tool_input?: Record<string, unknown> }).tool_input ?? {};
    const command = typeof toolInput.command === 'string' ? toolInput.command : '';
    if (!command) return NO_OPINION;
    const hookCwd = (input as { cwd?: unknown }).cwd;
    const effectiveCwd = typeof hookCwd === 'string' && hookCwd ? hookCwd : cwd;
    let violation: Violation | undefined;
    try {
      violation = checkCommand(command, effectiveCwd, { jevDecides: jevDecides() });
    } catch (err) {
      // Fail closed: a guard that crashed must not let the command run.
      violation = new Violation(
        'guard-error',
        `the destructive-command guard failed (${(err as Error).message})`,
        'Rewrite the command more simply, or split it into separate commands.'
      );
    }
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
