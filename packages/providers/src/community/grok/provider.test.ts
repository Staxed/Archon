import { describe, test, expect, mock, afterAll } from 'bun:test';
import { createMockLogger } from '../../test/mocks/logger';

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GrokProvider,
  buildGrokAgentFile,
  buildGrokArgs,
  mapToolsToGrok,
  readTurnCostFromUsageFile,
  type GrokSpawner,
} from './provider';
import { GROK_CAPABILITIES } from './capabilities';
import { parseGrokConfigStrict } from './config';
import type { MessageChunk, SendQueryOptions } from '../../types';

// Keep the hook file, sandbox.toml and usage.json fallback off the real ~/.grok.
const root = mkdtempSync(join(tmpdir(), 'grok-provider-'));
const grokHome = join(root, 'grok-home');
const workdir = join(root, 'work');
mkdirSync(workdir, { recursive: true });
const savedGrokHome = process.env.GROK_HOME;
process.env.GROK_HOME = grokHome;
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  if (savedGrokHome === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = savedGrokHome;
});

interface SpawnCall {
  bin: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  spec?: Record<string, unknown>;
}

/** A fake grok process per call: prints the NDJSON lines and exits with `code`. */
function fakeSpawner(runs: { lines: unknown[]; code?: number; stderr?: string }[]): {
  spawner: GrokSpawner;
  calls: SpawnCall[];
  kills: number[];
} {
  const calls: SpawnCall[] = [];
  const kills: number[] = [];
  const spawner: GrokSpawner = (bin, args, cwd, env) => {
    const specPath = env.ARCHON_HOOK_SPEC;
    calls.push({
      bin,
      args,
      cwd,
      env,
      ...(specPath && existsSync(specPath)
        ? { spec: JSON.parse(readFileSync(specPath, 'utf8')) as Record<string, unknown> }
        : {}),
    });
    const n = calls.length - 1;
    const run = runs[Math.min(n, runs.length - 1)];
    return {
      lines: (async function* () {
        for (const l of run.lines) yield typeof l === 'string' ? l : JSON.stringify(l);
      })(),
      stderr: Promise.resolve(run.stderr ?? ''),
      exitCode: Promise.resolve(run.code ?? 0),
      kill: (): void => {
        kills.push(n);
      },
    };
  };
  return { spawner, calls, kills };
}

async function collect(
  provider: GrokProvider,
  options?: SendQueryOptions,
  resume?: string
): Promise<MessageChunk[]> {
  const out: MessageChunk[] = [];
  for await (const c of provider.sendQuery('hello', workdir, resume, options)) out.push(c);
  return out;
}

const END = {
  type: 'end',
  stopReason: 'end_turn',
  sessionId: 'sess-1',
  usage: {
    input_tokens: 4233,
    cache_read_input_tokens: 12032,
    cache_creation_input_tokens: 0,
    output_tokens: 31,
    total_tokens: 16296,
  },
  num_turns: 1,
  total_cost_usd: 0.00498712,
  total_cost_usd_ticks: 49871200,
  modelUsage: { 'grok-4.7-build': { outputTokens: 31 } },
};

describe('GrokProvider streaming', () => {
  test('type and capabilities', () => {
    const p = new GrokProvider({ spawner: fakeSpawner([{ lines: [] }]).spawner });
    expect(p.getType()).toBe('grok');
    expect(p.getCapabilities()).toBe(GROK_CAPABILITIES);
  });

  test('streams thinking, text, paired tools and a result with cost, cache split and model', async () => {
    const { spawner, calls } = fakeSpawner([
      {
        lines: [
          { type: 'available_commands', tools: ['read_file'] },
          { type: 'thought', data: 'thinking' },
          { type: 'text', data: 'I will' },
          {
            type: 'tool_call',
            toolCallId: 'c1',
            toolName: 'run_terminal_command',
            rawInput: { command: 'echo hi' },
          },
          { type: 'tool_call_update', toolCallId: 'c1', status: 'in_progress' },
          {
            type: 'tool_call_update',
            toolCallId: 'c1',
            status: 'completed',
            rawOutput: { output_for_prompt: 'hi\n' },
          },
          'not json',
          END,
        ],
      },
    ]);
    const chunks = await collect(new GrokProvider({ spawner, executable: '/bin/grok' }));

    expect(calls[0].bin).toBe('/bin/grok');
    expect(calls[0].cwd).toBe(workdir);
    expect(calls[0].args).toContain('streaming-json');
    expect(chunks).toEqual([
      { type: 'thinking', content: 'thinking' },
      { type: 'assistant', content: 'I will' },
      {
        type: 'tool',
        toolName: 'run_terminal_command',
        toolInput: { command: 'echo hi' },
        toolCallId: 'c1',
      },
      {
        type: 'tool_result',
        toolName: 'run_terminal_command',
        toolOutput: 'hi\n',
        toolCallId: 'c1',
        toolOutcome: 'success',
      },
      {
        type: 'result',
        sessionId: 'sess-1',
        tokens: { input: 16265, output: 31, cacheRead: 12032, cacheWrite: 0, total: 16296 },
        cost: 0.00498712,
        resolvedModel: { id: 'grok-4.7-build' },
        stopReason: 'end_turn',
        numTurns: 1,
      },
    ]);
  });

  test('a stream that ends without `end` fails with stderr', async () => {
    const { spawner } = fakeSpawner([{ lines: [], code: 1, stderr: 'not logged in' }]);
    await expect(collect(new GrokProvider({ spawner, executable: 'grok' }))).rejects.toThrow(
      'Grok query failed: not logged in'
    );
  });

  test('marks a resumed session', async () => {
    const { spawner, calls } = fakeSpawner([{ lines: [END] }]);
    const chunks = await collect(new GrokProvider({ spawner }), undefined, 'sess-1');
    expect(calls[0].args).toEqual(expect.arrayContaining(['--resume', 'sess-1']));
    expect(chunks.at(-1)).toMatchObject({ type: 'result', resumed: true });
  });

  test('--json-schema result becomes structuredOutput', async () => {
    const { spawner, calls } = fakeSpawner([
      { lines: [{ text: '{"ok":true}', sessionId: 's', usage: { input_tokens: 1 } }] },
    ]);
    const chunks = await collect(new GrokProvider({ spawner }), {
      outputFormat: { type: 'json_schema', schema: { type: 'object' } },
    });
    expect(calls[0].args).toEqual(expect.arrayContaining(['--json-schema', '{"type":"object"}']));
    expect(chunks.at(-1)).toMatchObject({ type: 'result', structuredOutput: { ok: true } });
  });
});

describe('GrokProvider: subscription only', () => {
  test('the CLI env never carries an API key or base URL', async () => {
    const keys = ['XAI_API_KEY', 'GROK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'];
    const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
    for (const k of keys) process.env[k] = `host-${k}`;
    try {
      const { spawner, calls } = fakeSpawner([{ lines: [END] }]);
      await collect(new GrokProvider({ spawner }), {
        env: { XAI_API_KEY: 'project-key', XAI_BASE_URL: 'http://gw', PROJECT_VAR: 'kept' },
      });
      for (const k of [...keys, 'XAI_BASE_URL']) expect(calls[0].env[k]).toBeUndefined();
      expect(calls[0].env.PROJECT_VAR).toBe('kept');
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});

describe('GrokProvider: node options', () => {
  test('maps systemPrompt, effort and tool lists onto grok flags', async () => {
    const { spawner, calls } = fakeSpawner([{ lines: [END] }]);
    await collect(new GrokProvider({ spawner }), {
      model: 'grok-4.7',
      systemPrompt: 'You are PARITYBOT',
      nodeConfig: {
        nodeId: 'n',
        effort: 'ultra',
        allowed_tools: ['Read', 'Bash'],
        denied_tools: ['WebSearch'],
      },
    });
    const args = calls[0].args;
    const flag = (f: string): string | undefined => args[args.indexOf(f) + 1];
    expect(flag('--model')).toBe('grok-4.7');
    expect(flag('--system-prompt-override')).toBe('You are PARITYBOT');
    expect(flag('--effort')).toBe('max'); // clamped to Grok's ladder
    expect(flag('--tools')).toBe(
      'read_file,run_terminal_command,kill_command_or_subagent,get_command_or_subagent_output'
    );
    expect(flag('--disallowed-tools')).toBe('web_search');
  });

  test('allowed_tools: [] denies every mapped tool', () => {
    const args = buildGrokArgs('p', '/w', undefined, { allowedTools: [] });
    expect(args).not.toContain('--tools');
    expect(args[args.indexOf('--disallowed-tools') + 1]).toContain('run_terminal_command');
  });

  test('mapToolsToGrok passes unknown names through', () => {
    expect(mapToolsToGrok(['Write', 'custom_tool'])).toEqual(['write', 'custom_tool']);
  });

  test('hooks and tool lists reach the hook dispatcher spec', async () => {
    const { spawner, calls } = fakeSpawner([{ lines: [END] }]);
    const hooks = {
      PreToolUse: [
        {
          matcher: 'Bash',
          response: { hookSpecificOutput: { permissionDecision: 'deny' } },
        },
      ],
    };
    await collect(new GrokProvider({ spawner }), {
      nodeConfig: { nodeId: 'hooks', denied_tools: ['Bash'], hooks },
    });
    expect(calls[0].env.ARCHON_HOOK_EVENTS).toBe('PreToolUse');
    expect(calls[0].spec).toMatchObject({
      provider: 'grok',
      cwd: workdir,
      pathGuard: true,
      deniedTools: ['Bash'],
      hooks,
    });
    expect(existsSync(join(grokHome, 'hooks', 'archon-dispatcher.json'))).toBe(true);
    // spec removed after the run
    expect(existsSync(calls[0].env.ARCHON_HOOK_SPEC)).toBe(false);
  });

  test('refuses betas and hook events Grok never fires, before spawning', async () => {
    const { spawner, calls } = fakeSpawner([{ lines: [END] }]);
    const p = new GrokProvider({ spawner });
    await expect(collect(p, { nodeConfig: { betas: ['b'] } })).rejects.toThrow('betas');
    await expect(
      collect(p, { nodeConfig: { hooks: { PermissionRequest: [{ response: {} }] } } })
    ).rejects.toThrow('hook events Grok never fires: PermissionRequest');
    expect(calls).toHaveLength(0);
  });

  test('skills are preloaded through --rules', async () => {
    const dir = join(workdir, '.claude', 'skills', 'bro');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '# Bro Heading\nSay it plainly.');
    const { spawner, calls } = fakeSpawner([{ lines: [END] }]);
    await collect(new GrokProvider({ spawner }), { nodeConfig: { nodeId: 'n', skills: ['bro'] } });
    const args = calls[0].args;
    expect(args[args.indexOf('--rules') + 1]).toContain('# Bro Heading');
  });

  test('mcp servers go into a per-run agent definition that is removed afterwards', async () => {
    writeFileSync(
      join(workdir, 'mcp.json'),
      JSON.stringify({ parity: { command: 'bun', args: ['srv.ts'], env: { TOKEN: 'X' } } })
    );
    let agentText = '';
    const base = fakeSpawner([{ lines: [END] }]);
    const spawner: GrokSpawner = (bin, args, cwd, env) => {
      agentText = readFileSync(args[args.indexOf('--agent') + 1], 'utf8');
      return base.spawner(bin, args, cwd, env);
    };
    await collect(new GrokProvider({ spawner }), { nodeConfig: { nodeId: 'n', mcp: 'mcp.json' } });
    expect(agentText).toContain('  - name: "parity"');
    expect(agentText).toContain('    command: "bun"');
    expect(agentText).toContain('      "TOKEN": "X"');
    const agentFile = base.calls[0].args[base.calls[0].args.indexOf('--agent') + 1];
    expect(existsSync(agentFile)).toBe(false);
  });

  test('buildGrokAgentFile writes http servers with headers', () => {
    const text = buildGrokAgentFile({
      gh: { type: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer t' } },
    });
    expect(text).toContain('    type: "http"');
    expect(text).toContain('    url: "https://x/mcp"');
    expect(text).toContain('      "Authorization": "Bearer t"');
  });

  test('sandbox becomes a custom profile in $GROK_HOME/sandbox.toml', async () => {
    const { spawner, calls } = fakeSpawner([{ lines: [END] }]);
    await collect(new GrokProvider({ spawner }), {
      nodeConfig: { nodeId: 'n', sandbox: { enabled: true } },
    });
    const args = calls[0].args;
    const profile = args[args.indexOf('--sandbox') + 1];
    expect(profile).toMatch(/^archon-[0-9a-f]{12}$/);
    expect(readFileSync(join(grokHome, 'sandbox.toml'), 'utf8')).toContain(`[profiles.${profile}]`);
  });

  test('an unenforceable sandbox fails the node with a clear error', async () => {
    const { spawner } = fakeSpawner([
      { lines: [], code: 1, stderr: "could not apply the 'archon-x' sandbox profile" },
    ]);
    await expect(
      collect(new GrokProvider({ spawner }), { nodeConfig: { sandbox: { enabled: true } } })
    ).rejects.toThrow("could not enforce this node's sandbox");
  });
});

describe('GrokProvider: maxBudgetUsd and fallbackModel', () => {
  test('stops the CLI once the per-call usage passes the cap', async () => {
    const { spawner, kills } = fakeSpawner([
      {
        lines: [
          { type: 'text', data: 'working' },
          {
            type: 'usage',
            sessionId: 'sess-b',
            usage: { input_tokens: 5000, cache_read_input_tokens: 0, output_tokens: 100 },
          },
          END,
        ],
      },
    ]);
    const chunks = await collect(new GrokProvider({ spawner }), {
      model: 'grok-4.7',
      maxBudgetUsd: 0.001,
    });
    expect(kills).toEqual([0]);
    // 5000 * 0.68 / 1e6 + 100 * 2.04 / 1e6 = 0.003604
    const result = chunks.at(-1) as Record<string, unknown>;
    expect(result).toMatchObject({
      type: 'result',
      sessionId: 'sess-b',
      isError: true,
      errorSubtype: 'error_max_budget_usd',
    });
    expect(result.cost).toBeCloseTo(0.003604, 6);
  });

  test('flags the end result when Grok reports a cost over the cap', async () => {
    const { spawner } = fakeSpawner([{ lines: [END] }]);
    const chunks = await collect(new GrokProvider({ spawner }), { maxBudgetUsd: 0.001 });
    expect(chunks.at(-1)).toMatchObject({ isError: true, errorSubtype: 'error_max_budget_usd' });
  });

  test('refuses a budget for a model Archon cannot price', async () => {
    const { spawner } = fakeSpawner([{ lines: [END] }]);
    await expect(
      collect(new GrokProvider({ spawner }), { model: 'grok-unpriced', maxBudgetUsd: 1 })
    ).rejects.toThrow('ARCHON_MODEL_RATES');
  });

  test('retries once on the fallback model after a model error', async () => {
    const { spawner, calls } = fakeSpawner([
      { lines: [{ type: 'error', message: 'model grok-parity-nonexistent not found' }], code: 1 },
      { lines: [END] },
    ]);
    const chunks = await collect(new GrokProvider({ spawner }), {
      model: 'grok-parity-nonexistent',
      fallbackModel: 'grok-4.7',
    });
    expect(calls).toHaveLength(2);
    expect(calls[1].args[calls[1].args.indexOf('--model') + 1]).toBe('grok-4.7');
    expect(chunks.some(c => c.type === 'system' && c.content.includes('fallback model'))).toBe(
      true
    );
    expect(chunks.at(-1)).toMatchObject({ type: 'result', sessionId: 'sess-1' });
  });
});

describe('Grok helpers', () => {
  test('readTurnCostFromUsageFile reads the last turn ticks', () => {
    const dir = join(grokHome, 'sessions', encodeURIComponent('/w'), 's1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'usage.json'),
      JSON.stringify({ turns: [{ costUsdTicks: 1 }, { costUsdTicks: 110119200 }] })
    );
    expect(readTurnCostFromUsageFile('s1', '/w', grokHome)).toBeCloseTo(0.01101192, 8);
    expect(readTurnCostFromUsageFile('missing', '/w', grokHome)).toBeUndefined();
  });

  test('strict config parser accepts known keys only', () => {
    expect(parseGrokConfigStrict({ model: ' grok-4.7 ', modelReasoningEffort: 'high' })).toEqual({
      model: 'grok-4.7',
      modelReasoningEffort: 'high',
    });
    expect(() => parseGrokConfigStrict({ apiKey: 'x' })).toThrow();
  });
});
