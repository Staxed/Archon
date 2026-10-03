/**
 * Codex node-option parity: every Claude node option a Codex node can honour on
 * the ChatGPT subscription (tool lists, hooks, skills, sandbox, maxBudgetUsd,
 * fallbackModel), and the ones it refuses.
 */
import { describe, test, expect, mock, beforeEach, afterAll } from 'bun:test';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Codex as SdkCodex, Thread as SdkThread } from '@openai/codex-sdk';
import type { MessageChunk, SendQueryOptions } from '../types';
import { createMockLogger } from '../test/mocks/logger';

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

const usage = {
  input_tokens: 10,
  cached_input_tokens: 0,
  cache_write_input_tokens: 0,
  output_tokens: 5,
  reasoning_output_tokens: 0,
};

type RunStreamed = (
  ...args: Parameters<SdkThread['runStreamed']>
) => Promise<{ events: AsyncGenerator<unknown, void, unknown> }>;

const completed = (): Promise<{ events: AsyncGenerator<unknown, void, unknown> }> =>
  Promise.resolve({
    events: (async function* () {
      yield { type: 'turn.completed', usage };
    })(),
  });

const mockRunStreamed = mock<RunStreamed>(completed);
const thread = (id: string): { id: string; runStreamed: typeof mockRunStreamed } => ({
  id,
  runStreamed: mockRunStreamed,
});
const mockStartThread = mock((..._args: Parameters<SdkCodex['startThread']>) => thread('thr-1'));
const mockResumeThread = mock((..._args: Parameters<SdkCodex['resumeThread']>) => thread('thr-1'));
const MockCodex = mock((..._args: ConstructorParameters<typeof SdkCodex>) => ({
  startThread: mockStartThread,
  resumeThread: mockResumeThread,
}));
mock.module('@openai/codex-sdk', () => ({ Codex: MockCodex }));

import { CodexProvider } from './provider';

const root = mkdtempSync(join(tmpdir(), 'codex-parity-'));
const codexHome = join(root, 'codex-home');
const workdir = join(root, 'work');
mkdirSync(workdir, { recursive: true });
const savedCodexHome = process.env.CODEX_HOME;
process.env.CODEX_HOME = codexHome;
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
});

async function run(options: SendQueryOptions): Promise<MessageChunk[]> {
  const chunks: MessageChunk[] = [];
  for await (const c of new CodexProvider({ retryBaseDelayMs: 1 }).sendQuery(
    'go',
    workdir,
    undefined,
    options
  )) {
    chunks.push(c);
  }
  return chunks;
}

function codexOptions(call = 0): {
  env: Record<string, string>;
  config?: Record<string, unknown>;
  configOverrides?: string[];
} {
  return MockCodex.mock.calls[call][0] as never;
}

beforeEach(() => {
  MockCodex.mockClear();
  mockStartThread.mockClear();
  mockResumeThread.mockClear();
  mockRunStreamed.mockReset();
  mockRunStreamed.mockImplementation(completed);
});

describe('Codex hooks and tool lists go through the CLI hook dispatcher', () => {
  test('installs the dispatcher, trusts it per run and hands the CLI the node spec', async () => {
    let specSeen: Record<string, unknown> | undefined;
    mockRunStreamed.mockImplementation(() => {
      // the spec must exist while the CLI runs
      specSeen = JSON.parse(readFileSync(codexOptions().env.ARCHON_HOOK_SPEC, 'utf8')) as Record<
        string,
        unknown
      >;
      return completed();
    });
    const hooks = {
      PreToolUse: [{ matcher: 'Bash', response: { decision: 'block' } }],
      Stop: [{ response: { systemMessage: 'bye' } }],
    };

    await run({
      nodeConfig: {
        nodeId: 'n1',
        allowed_tools: ['Read'],
        denied_tools: ['Bash'],
        hooks,
      },
    });

    const opts = codexOptions();
    expect(opts.env.ARCHON_HOOK_EVENTS).toBe('PreToolUse,Stop');
    expect(specSeen).toMatchObject({
      provider: 'codex',
      cwd: workdir,
      pathGuard: true,
      allowedTools: ['Read'],
      deniedTools: ['Bash'],
      hooks,
    });
    expect(opts.configOverrides?.[0]).toStartWith('hooks.state={ ');
    expect(opts.configOverrides?.[0]).toContain(`${join(codexHome, 'hooks.json')}:pre_tool_use:`);
    expect(existsSync(join(codexHome, 'hooks.json'))).toBe(true);
    // the spec file is removed after the run
    expect(existsSync(opts.env.ARCHON_HOOK_SPEC)).toBe(false);
  });

  test('CODEX_HOME is the home the hooks were installed in, even with a project HOME', async () => {
    await run({ nodeConfig: { nodeId: 'n' }, env: { HOME: '/tmp/elsewhere' } });
    expect(codexOptions().env.CODEX_HOME).toBe(codexHome);
  });

  test('a node that denies WebSearch gets web search disabled', async () => {
    await run({ nodeConfig: { nodeId: 'n', denied_tools: ['WebSearch'] } });
    expect(mockStartThread.mock.calls[0][0]).toMatchObject({ webSearchMode: 'disabled' });
  });

  test('refuses hook events Codex never fires, and betas', async () => {
    await expect(
      run({ nodeConfig: { nodeId: 'n', hooks: { Setup: [{ response: {} }] } } })
    ).rejects.toThrow('hook events Codex never fires: Setup');
    await expect(run({ nodeConfig: { nodeId: 'n', betas: ['x'] } })).rejects.toThrow('betas');
    expect(MockCodex).not.toHaveBeenCalled();
  });
});

describe('Codex sandbox, skills', () => {
  test('sandbox maps to workspace-write with writable roots and no network', async () => {
    await run({
      nodeConfig: { nodeId: 'n', sandbox: { enabled: true, filesystem: { allowWrite: ['out'] } } },
    });
    expect(mockStartThread.mock.calls[0][0]).toMatchObject({
      sandboxMode: 'workspace-write',
      networkAccessEnabled: false,
    });
    expect(codexOptions().config).toMatchObject({
      sandbox_workspace_write: { writable_roots: [join(workdir, 'out')] },
    });
  });

  test('no sandbox keeps full access', async () => {
    await run({ nodeConfig: { nodeId: 'n' } });
    expect(mockStartThread.mock.calls[0][0]).toMatchObject({
      sandboxMode: 'danger-full-access',
      networkAccessEnabled: true,
    });
  });

  test('skills are preloaded into developer_instructions; missing ones warn', async () => {
    const dir = join(workdir, '.claude', 'skills', 'parity-skill');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '# Parity Heading\nDo the thing.');

    const chunks = await run({ nodeConfig: { nodeId: 'n', skills: ['parity-skill', 'nope'] } });

    const config = codexOptions().config as { developer_instructions?: string };
    expect(config.developer_instructions).toContain('# Parity Heading');
    expect(config).toMatchObject({ skills: { include_instructions: false } });
    expect(
      chunks.some(c => c.type === 'system' && c.content.includes('missing skills: nope'))
    ).toBe(true);
  });
});

describe('Codex fallbackModel', () => {
  test('retries once on the fallback after a model-access turn failure', async () => {
    mockRunStreamed.mockImplementationOnce(() =>
      Promise.resolve({
        events: (async function* () {
          yield {
            type: 'turn.failed',
            error: {
              message:
                "The 'gpt-nope' model is not supported when using Codex with a ChatGPT account.",
            },
          };
        })(),
      })
    );

    const chunks = await run({ model: 'gpt-nope', fallbackModel: 'gpt-6-astra' });

    expect(mockStartThread).toHaveBeenCalledTimes(2);
    expect(mockStartThread.mock.calls[0][0]).toMatchObject({ model: 'gpt-nope' });
    expect(mockStartThread.mock.calls[1][0]).toMatchObject({ model: 'gpt-6-astra' });
    expect(chunks.some(c => c.type === 'system' && c.content.includes('fallback model'))).toBe(
      true
    );
    const result = chunks.find(c => c.type === 'result');
    expect(result).toMatchObject({ type: 'result' });
    expect((result as { isError?: boolean }).isError).toBeUndefined();
  });

  test('without a fallback the model failure is reported as before', async () => {
    mockRunStreamed.mockImplementationOnce(() =>
      Promise.resolve({
        events: (async function* () {
          yield { type: 'turn.failed', error: { message: 'model is not available' } };
        })(),
      })
    );
    const chunks = await run({ model: 'gpt-nope' });
    expect(mockStartThread).toHaveBeenCalledTimes(1);
    expect(chunks.at(-1)).toMatchObject({ type: 'result', isError: true });
  });
});

describe('Codex maxBudgetUsd', () => {
  test('stops the turn once the rollout spend passes the cap', async () => {
    const day = join(codexHome, 'sessions', '2026', '10', '01');
    mkdirSync(day, { recursive: true });
    const rollout = join(day, 'rollout-2026-10-01T00-00-00-thr-1.jsonl');
    writeFileSync(rollout, '');
    mockRunStreamed.mockImplementation(() =>
      Promise.resolve({
        events: (async function* () {
          appendFileSync(
            rollout,
            JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6-astra' } }) +
              '\n' +
              JSON.stringify({
                type: 'event_msg',
                payload: {
                  type: 'token_count',
                  info: {
                    last_token_usage: {
                      input_tokens: 2000,
                      cached_input_tokens: 1000,
                      output_tokens: 100,
                    },
                  },
                },
              }) +
              '\n'
          );
          yield { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'hi' } };
          yield { type: 'turn.completed', usage };
        })(),
      })
    );

    const chunks = await run({ model: 'gpt-6-astra', maxBudgetUsd: 0.001 });

    const result = chunks.find(c => c.type === 'result') as Record<string, unknown>;
    expect(result).toMatchObject({
      isError: true,
      errorSubtype: 'error_max_budget_usd',
      tokens: { input: 2000, output: 100, cacheRead: 1000 },
    });
    // (1000 * 10 + 1000 * 1 + 100 * 50) / 1e6 = 0.016
    expect(result.cost).toBeCloseTo(0.016, 6);
    expect(chunks.some(c => c.type === 'assistant')).toBe(false);
  });

  test('refuses a budget for a model Archon cannot price', async () => {
    await expect(run({ model: 'gpt-unpriced', maxBudgetUsd: 1 })).rejects.toThrow(
      'ARCHON_MODEL_RATES'
    );
  });
});

describe('Codex resolved model', () => {
  const rollout = join(
    codexHome,
    'sessions',
    '2026',
    '10',
    '01',
    'rollout-2026-10-01T00-00-00-thr-1.jsonl'
  );
  const turn = (lines: object[]): void => {
    mockRunStreamed.mockImplementation(() =>
      Promise.resolve({
        events: (async function* () {
          for (const line of lines) appendFileSync(rollout, JSON.stringify(line) + '\n');
          yield { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'hi' } };
          yield { type: 'turn.completed', usage };
        })(),
      })
    );
  };
  beforeEach(() => {
    mkdirSync(join(codexHome, 'sessions', '2026', '10', '01'), { recursive: true });
    writeFileSync(rollout, '');
  });

  test('the result names the model the rollout says served the turn, with no budget set', async () => {
    // No model configured: Codex picks its own default, which only the rollout names.
    turn([{ type: 'turn_context', payload: { model: 'gpt-6-astra' } }]);
    const result = (await run({})).find(c => c.type === 'result');
    expect(result).toMatchObject({ type: 'result', resolvedModel: { id: 'gpt-6-astra' } });
  });

  test('a configured model is not reported as resolved when the rollout names none', async () => {
    turn([]);
    const result = (await run({ model: 'gpt-6-astra' })).find(c => c.type === 'result');
    expect(result).toBeDefined();
    expect(result).not.toHaveProperty('resolvedModel');
  });
});
