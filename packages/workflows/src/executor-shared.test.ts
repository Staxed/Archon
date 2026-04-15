import { describe, it, expect, mock } from 'bun:test';

// Mock logger before importing module under test
const mockLogFn = mock(() => {});
const mockLogger = {
  info: mockLogFn,
  warn: mockLogFn,
  error: mockLogFn,
  debug: mockLogFn,
  trace: mockLogFn,
  fatal: mockLogFn,
  child: mock(() => mockLogger),
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
};
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

import {
  substituteWorkflowVariables,
  buildPromptWithContext,
  detectCreditExhaustion,
  prependCwdNotice,
} from './executor-shared';

describe('substituteWorkflowVariables', () => {
  it('replaces $WORKFLOW_ID with the run ID', () => {
    const { prompt } = substituteWorkflowVariables(
      'Run ID: $WORKFLOW_ID',
      'run-123',
      'hello',
      '/tmp/artifacts',
      'main',
      'docs/'
    );
    expect(prompt).toBe('Run ID: run-123');
  });

  it('replaces $ARTIFACTS_DIR with the resolved path', () => {
    const { prompt } = substituteWorkflowVariables(
      'Save to $ARTIFACTS_DIR/output.txt',
      'run-1',
      'msg',
      '/tmp/artifacts/runs/run-1',
      'main',
      'docs/'
    );
    expect(prompt).toBe('Save to /tmp/artifacts/runs/run-1/output.txt');
  });

  it('replaces $BASE_BRANCH with config value', () => {
    const { prompt } = substituteWorkflowVariables(
      'Merge into $BASE_BRANCH',
      'run-1',
      'msg',
      '/tmp',
      'develop',
      'docs/'
    );
    expect(prompt).toBe('Merge into develop');
  });

  it('throws when $BASE_BRANCH is referenced but empty', () => {
    expect(() =>
      substituteWorkflowVariables('Merge into $BASE_BRANCH', 'run-1', 'msg', '/tmp', '', 'docs/')
    ).toThrow('No base branch could be resolved');
  });

  it('does not throw when $BASE_BRANCH is not referenced and baseBranch is empty', () => {
    const { prompt } = substituteWorkflowVariables(
      'No branch reference here',
      'run-1',
      'msg',
      '/tmp',
      '',
      'docs/'
    );
    expect(prompt).toBe('No branch reference here');
  });

  it('replaces $USER_MESSAGE and $ARGUMENTS with user message', () => {
    const { prompt } = substituteWorkflowVariables(
      'Goal: $USER_MESSAGE. Args: $ARGUMENTS',
      'run-1',
      'add dark mode',
      '/tmp',
      'main',
      'docs/'
    );
    expect(prompt).toBe('Goal: add dark mode. Args: add dark mode');
  });

  it('replaces $DOCS_DIR with configured path', () => {
    const { prompt } = substituteWorkflowVariables(
      'Check $DOCS_DIR for changes',
      'run-1',
      'msg',
      '/tmp',
      'main',
      'packages/docs-web/src/content/docs'
    );
    expect(prompt).toBe('Check packages/docs-web/src/content/docs for changes');
  });

  it('replaces $DOCS_DIR with default docs/ when default passed', () => {
    const { prompt } = substituteWorkflowVariables(
      'Check $DOCS_DIR for changes',
      'run-1',
      'msg',
      '/tmp',
      'main',
      'docs/'
    );
    expect(prompt).toBe('Check docs/ for changes');
  });

  it('does not affect prompts without $DOCS_DIR', () => {
    const { prompt } = substituteWorkflowVariables(
      'No docs reference here',
      'run-1',
      'msg',
      '/tmp',
      'main',
      'custom/docs/'
    );
    expect(prompt).toBe('No docs reference here');
  });

  it('falls back to docs/ when docsDir is empty string', () => {
    const { prompt } = substituteWorkflowVariables(
      'Check $DOCS_DIR for changes',
      'run-1',
      'msg',
      '/tmp',
      'main',
      ''
    );
    expect(prompt).toBe('Check docs/ for changes');
  });

  it('replaces $CONTEXT when issueContext is provided', () => {
    const { prompt, contextSubstituted } = substituteWorkflowVariables(
      'Fix this: $CONTEXT',
      'run-1',
      'msg',
      '/tmp',
      'main',
      'docs/',
      '## Issue #42\nBug report'
    );
    expect(prompt).toBe('Fix this: ## Issue #42\nBug report');
    expect(contextSubstituted).toBe(true);
  });

  it('replaces $ISSUE_CONTEXT and $EXTERNAL_CONTEXT with issueContext', () => {
    const { prompt } = substituteWorkflowVariables(
      'Issue: $ISSUE_CONTEXT. External: $EXTERNAL_CONTEXT',
      'run-1',
      'msg',
      '/tmp',
      'main',
      'docs/',
      'context-data'
    );
    expect(prompt).toBe('Issue: context-data. External: context-data');
  });

  it('clears context variables when issueContext is undefined', () => {
    const { prompt, contextSubstituted } = substituteWorkflowVariables(
      'Context: $CONTEXT here',
      'run-1',
      'msg',
      '/tmp',
      'main',
      'docs/'
    );
    expect(prompt).toBe('Context:  here');
    expect(contextSubstituted).toBe(false);
  });

  it('replaces $REJECTION_REASON with rejection reason', () => {
    const { prompt } = substituteWorkflowVariables(
      'Fix based on: $REJECTION_REASON',
      'run-1',
      'msg',
      '/tmp',
      'main',
      'docs/',
      undefined,
      undefined,
      'Missing error handling'
    );
    expect(prompt).toBe('Fix based on: Missing error handling');
  });

  it('clears $REJECTION_REASON when not provided', () => {
    const { prompt } = substituteWorkflowVariables(
      'Fix: $REJECTION_REASON',
      'run-1',
      'msg',
      '/tmp',
      'main',
      'docs/'
    );
    expect(prompt).toBe('Fix: ');
  });

  it('replaces $KNOWLEDGE with knowledge context', () => {
    const { prompt } = substituteWorkflowVariables(
      'Context: $KNOWLEDGE\nDo the work.',
      'run-1',
      'msg',
      '/tmp',
      'main',
      'docs/',
      undefined,
      undefined,
      undefined,
      '## Knowledge Base\n\n### Project Knowledge\n\nSome knowledge here'
    );
    expect(prompt).toBe(
      'Context: ## Knowledge Base\n\n### Project Knowledge\n\nSome knowledge here\nDo the work.'
    );
  });

  it('clears $KNOWLEDGE when not provided', () => {
    const { prompt } = substituteWorkflowVariables(
      'Before $KNOWLEDGE After',
      'run-1',
      'msg',
      '/tmp',
      'main',
      'docs/'
    );
    expect(prompt).toBe('Before  After');
  });
});

describe('buildPromptWithContext', () => {
  it('appends issueContext when no context variable in template', () => {
    const result = buildPromptWithContext(
      'Do the thing',
      'run-1',
      'msg',
      '/tmp',
      'main',
      'docs/',
      '## Issue #42\nDetails here',
      'test prompt'
    );
    expect(result).toContain('Do the thing');
    expect(result).toContain('## Issue #42');
  });

  it('does not append issueContext when $CONTEXT was substituted', () => {
    const result = buildPromptWithContext(
      'Fix this: $CONTEXT',
      'run-1',
      'msg',
      '/tmp',
      'main',
      'docs/',
      '## Issue #42\nDetails here',
      'test prompt'
    );
    // Context was substituted inline, should not be appended again
    const contextCount = (result.match(/## Issue #42/g) ?? []).length;
    expect(contextCount).toBe(1);
  });

  it('returns prompt unchanged when no issueContext provided', () => {
    const result = buildPromptWithContext(
      'Do the thing',
      'run-1',
      'msg',
      '/tmp',
      'main',
      'docs/',
      undefined,
      'test prompt'
    );
    expect(result).toBe('Do the thing');
  });
});

describe('detectCreditExhaustion', () => {
  it('detects "You\'re out of extra usage" (exact SDK phrase)', () => {
    const result = detectCreditExhaustion("You're out of extra usage · resets in 2h");
    expect(result).toBe('Credit exhaustion detected — resume when credits reset');
  });

  it('detects "out of credits" phrase', () => {
    expect(detectCreditExhaustion('Sorry, you are out of credits.')).not.toBeNull();
  });

  it('detects "credit balance" phrase', () => {
    expect(detectCreditExhaustion('Your credit balance is too low.')).not.toBeNull();
  });

  it('returns null for normal output', () => {
    expect(detectCreditExhaustion('Here is the investigation summary...')).toBeNull();
  });

  it('detects "insufficient credit" phrase', () => {
    expect(detectCreditExhaustion('Insufficient credit to continue.')).not.toBeNull();
  });

  it('is case-insensitive', () => {
    expect(detectCreditExhaustion("YOU'RE OUT OF EXTRA USAGE")).not.toBeNull();
  });
});

describe('prependCwdNotice', () => {
  const cwd = '/home/user/.archon/worktrees/projects/myrepo/archon/task-feat';

  it('prepends a system-context block that names the working directory', () => {
    const result = prependCwdNotice('Original prompt body', cwd);
    expect(result).toContain('<system-context>');
    expect(result).toContain('</system-context>');
    expect(result).toContain(cwd);
  });

  it('explicitly forbids Write/Edit outside the working directory', () => {
    const result = prependCwdNotice('Body', cwd);
    // The exact wording matters — it has to be unambiguous to the model that
    // outside-cwd writes are forbidden, not just discouraged.
    expect(result).toMatch(/NEVER Write or Edit/);
    expect(result).toContain('read-only');
  });

  it('preserves the original prompt body verbatim after the notice', () => {
    const body = 'Step 1: do the thing.\nStep 2: do another thing.';
    const result = prependCwdNotice(body, cwd);
    // The body must appear unchanged after the closing tag, so variable
    // substitution and node-output references downstream still work.
    expect(result.endsWith(body)).toBe(true);
  });

  it('places the notice before the body, not after', () => {
    const body = 'BODY_MARKER';
    const result = prependCwdNotice(body, cwd);
    const noticeIdx = result.indexOf('<system-context>');
    const bodyIdx = result.indexOf(body);
    expect(noticeIdx).toBeGreaterThanOrEqual(0);
    expect(bodyIdx).toBeGreaterThan(noticeIdx);
  });

  it('handles an empty prompt body without throwing', () => {
    const result = prependCwdNotice('', cwd);
    expect(result).toContain('<system-context>');
    expect(result).toContain(cwd);
  });

  it('is a pure function — different cwds produce different notices', () => {
    const a = prependCwdNotice('body', '/cwd/a');
    const b = prependCwdNotice('body', '/cwd/b');
    expect(a).not.toBe(b);
    expect(a).toContain('/cwd/a');
    expect(b).toContain('/cwd/b');
  });

  it('does not mention any specific provider (provider-agnostic)', () => {
    const result = prependCwdNotice('body', cwd);
    // The notice is wrapped at the dag-executor before dispatch to ANY of the
    // four providers (Claude/Codex/OpenRouter/Llama.cpp), so it must not be
    // worded as if it were Claude-specific.
    expect(result.toLowerCase()).not.toContain('claude');
    expect(result.toLowerCase()).not.toContain('codex');
    expect(result.toLowerCase()).not.toContain('openrouter');
    expect(result.toLowerCase()).not.toContain('llama');
  });
});
