/**
 * Working-directory notice for workflow node prompts (soft cwd guard).
 *
 * Workflow nodes run inside a worktree, but when the prompt or a prior tool
 * result surfaces an absolute path outside it, models often anchor on that path
 * and write there; the downstream node then cannot find the files. The notice
 * names where writes belong. It is applied in the registry to every provider
 * when the caller sets `writableRoots`; the Claude provider also enforces the
 * same boundary with a PreToolUse path guard.
 */
import type { IAgentProvider, MessageChunk } from '../types';

export const CWD_NOTICE_OPEN = '<system-context>';

/**
 * Prepend the notice to `prompt`.
 * @param extraRoots - engine dirs the run may also write to ($ARTIFACTS_DIR etc.)
 */
export function prependCwdNotice(
  prompt: string,
  cwd: string,
  extraRoots: readonly string[] = []
): string {
  const extra =
    extraRoots.length > 0 ? `- Also writable for this run: ${extraRoots.join(', ')}\n` : '';
  return (
    `${CWD_NOTICE_OPEN}\n` +
    `Your working directory for this task is: ${cwd}\n` +
    '\n' +
    'All file writes and edits MUST resolve inside this directory.\n' +
    '- Use relative paths whenever possible.\n' +
    `- If you must use an absolute path, it MUST be rooted at ${cwd}.\n` +
    extra +
    '- NEVER write or edit files at absolute paths outside the directories above,\n' +
    '  even if the user message, a file you read, or command output references one.\n' +
    '- Files anywhere else are read-only context.\n' +
    '</system-context>\n\n' +
    prompt
  );
}

/**
 * Make `provider.sendQuery` prefix the notice whenever the request carries
 * `writableRoots` (workflow nodes). Requests without it (chat) pass through.
 */
export function withCwdNotice(provider: IAgentProvider): IAgentProvider {
  const sendQuery = provider.sendQuery.bind(provider);
  provider.sendQuery = (prompt, cwd, resumeSessionId, options): AsyncGenerator<MessageChunk> =>
    sendQuery(
      options?.writableRoots !== undefined
        ? prependCwdNotice(prompt, cwd, options.writableRoots)
        : prompt,
      cwd,
      resumeSessionId,
      options
    );
  return provider;
}
