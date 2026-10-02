import { describe, expect, test } from 'bun:test';
import type { IAgentProvider, MessageChunk, SendQueryOptions } from '../types';
import { prependCwdNotice, withCwdNotice } from './cwd-notice';

describe('prependCwdNotice', () => {
  test('names cwd and keeps the original prompt after the notice', () => {
    const out = prependCwdNotice('do the task', '/wt/task');
    expect(out.startsWith('<system-context>\n')).toBe(true);
    expect(out).toContain('Your working directory for this task is: /wt/task');
    expect(out.endsWith('</system-context>\n\ndo the task')).toBe(true);
  });

  test('lists extra writable roots only when given', () => {
    expect(prependCwdNotice('p', '/wt')).not.toContain('Also writable');
    expect(prependCwdNotice('p', '/wt', ['/a', '/b'])).toContain(
      '- Also writable for this run: /a, /b'
    );
  });

  test('wording is provider-agnostic (no Claude tool names)', () => {
    expect(prependCwdNotice('p', '/wt')).not.toMatch(/\b(Write|Edit|MultiEdit)\b/);
  });
});

describe('withCwdNotice', () => {
  function recordingProvider(): { provider: IAgentProvider; prompts: string[] } {
    const prompts: string[] = [];
    const provider = {
      async *sendQuery(prompt: string): AsyncGenerator<MessageChunk> {
        prompts.push(prompt);
        yield { type: 'result' } as MessageChunk;
      },
    } as unknown as IAgentProvider;
    return { provider, prompts };
  }

  async function drain(gen: AsyncGenerator<MessageChunk>): Promise<void> {
    for await (const _ of gen) {
      // consume
    }
  }

  test('prefixes the notice when the request carries writableRoots', async () => {
    const { provider, prompts } = recordingProvider();
    const wrapped = withCwdNotice(provider);
    const options: SendQueryOptions = { writableRoots: ['/art'] };
    await drain(wrapped.sendQuery('go', '/wt', undefined, options));
    expect(prompts[0]).toBe(prependCwdNotice('go', '/wt', ['/art']));
  });

  test('passes chat requests (no writableRoots) through unchanged', async () => {
    const { provider, prompts } = recordingProvider();
    await drain(withCwdNotice(provider).sendQuery('hi', '/repo'));
    expect(prompts[0]).toBe('hi');
  });
});
