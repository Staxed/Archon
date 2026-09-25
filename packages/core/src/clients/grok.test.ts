import { describe, test, expect, mock } from 'bun:test';
import { createMockLogger } from '../test/mocks/logger';

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GrokClient,
  buildGrokArgs,
  mapToolsToGrok,
  readTurnCostFromUsageFile,
  type GrokSpawner,
} from './grok';
import type { MessageChunk } from '../types';

// Keep the usage.json fallback off the real ~/.grok.
const grokHome = mkdtempSync(join(tmpdir(), 'grok-home-'));
process.env.GROK_HOME = grokHome;

/** A fake grok process that prints the given NDJSON lines and exits with `code`. */
function fakeSpawner(
  lines: unknown[],
  code = 0,
  stderr = ''
): {
  spawner: GrokSpawner;
  calls: { bin: string; args: string[]; cwd: string; env?: Record<string, string> }[];
} {
  const calls: { bin: string; args: string[]; cwd: string; env?: Record<string, string> }[] = [];
  const spawner: GrokSpawner = (bin, args, cwd, env) => {
    calls.push({ bin, args, cwd, env });
    return {
      lines: (async function* () {
        for (const l of lines) yield typeof l === 'string' ? l : JSON.stringify(l);
      })(),
      stderr: Promise.resolve(stderr),
      exitCode: Promise.resolve(code),
      kill: () => undefined,
    };
  };
  return { spawner, calls };
}

async function collect(gen: AsyncGenerator<MessageChunk>): Promise<MessageChunk[]> {
  const out: MessageChunk[] = [];
  for await (const c of gen) out.push(c);
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

describe('GrokClient', () => {
  test('getType returns grok', () => {
    expect(new GrokClient({ spawner: fakeSpawner([]).spawner, executable: 'grok' }).getType()).toBe(
      'grok'
    );
  });

  test('streams text, tools and a result with cost, cache split and model', async () => {
    const { spawner, calls } = fakeSpawner([
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
      { type: 'usage', usage: { input_tokens: 1 } },
      'not json',
      END,
    ]);
    const chunks = await collect(
      new GrokClient({ spawner, executable: '/bin/grok' }).sendQuery('hello', '/work')
    );

    expect(calls[0].bin).toBe('/bin/grok');
    expect(calls[0].cwd).toBe('/work');
    expect(chunks).toEqual([
      { type: 'thinking', content: 'thinking' },
      { type: 'assistant', content: 'I will' },
      { type: 'tool', toolName: 'run_terminal_command', toolInput: { command: 'echo hi' } },
      { type: 'tool_result', toolName: 'run_terminal_command', toolOutput: 'hi\n' },
      {
        type: 'result',
        sessionId: 'sess-1',
        tokens: { input: 4233, output: 31, total: 16296, model: 'grok-4.7-build' },
        cost: 0.00498712,
        stopReason: 'end_turn',
        numTurns: 1,
      },
    ]);
  });

  test('falls back to usage.json when the stream carries no cost', async () => {
    const cwd = '/mnt/volumes/projects/x';
    const dir = join(grokHome, 'sessions', encodeURIComponent(cwd), 'sess-2');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'usage.json'),
      JSON.stringify({ turns: [{ costUsdTicks: 10_000_000 }, { costUsdTicks: 25_000_000 }] })
    );
    const { total_cost_usd: _a, total_cost_usd_ticks: _b, ...noCost } = END;
    const { spawner } = fakeSpawner([{ ...noCost, sessionId: 'sess-2', cost_is_partial: true }]);
    const chunks = await collect(
      new GrokClient({ spawner, executable: 'grok' }).sendQuery('p', cwd)
    );
    expect((chunks[0] as { cost?: number }).cost).toBe(0.0025);
  });

  test('readTurnCostFromUsageFile is undefined for a missing session', () => {
    expect(readTurnCostFromUsageFile('nope', '/x')).toBeUndefined();
  });

  test('an error event fails the query', async () => {
    const { spawner } = fakeSpawner([{ type: 'error', message: 'Not signed in' }], 1);
    const gen = new GrokClient({ spawner, executable: 'grok' }).sendQuery('p', '/w');
    const seen: MessageChunk[] = [];
    const run = async () => {
      for await (const c of gen) seen.push(c);
    };
    await expect(run()).rejects.toThrow('Grok query failed: Not signed in');
    expect(seen[0]).toEqual({ type: 'system', content: '❌ Grok error: Not signed in' });
  });

  test('a process that exits without an end event fails with its stderr', async () => {
    const { spawner } = fakeSpawner([{ type: 'text', data: 'x' }], 2, 'boom');
    const run = collect(new GrokClient({ spawner, executable: 'grok' }).sendQuery('p', '/w'));
    await expect(run).rejects.toThrow('Grok query failed: boom');
  });

  test('refuses options it cannot honour instead of dropping them', async () => {
    const { spawner, calls } = fakeSpawner([END]);
    const client = new GrokClient({ spawner, executable: 'grok' });
    await expect(
      collect(client.sendQuery('p', '/w', undefined, { betas: ['context-1m-2025-08-07'] }))
    ).rejects.toThrow('betas');
    await expect(
      collect(
        client.sendQuery('p', '/w', undefined, {
          hookSpecs: { PermissionRequest: [{ response: {} }] },
        })
      )
    ).rejects.toThrow('hook events Grok never fires: PermissionRequest');
    await expect(
      collect(client.sendQuery('p', '/w', undefined, { model: 'grok-x', maxBudgetUsd: 1 }))
    ).rejects.toThrow('ARCHON_MODEL_RATES');
    expect(calls).toHaveLength(0);
  });

  test('hands the hook dispatcher a spec with the path guard, tool lists and node hooks', async () => {
    let spec: Record<string, unknown> | undefined;
    const calls: { args: string[]; env?: Record<string, string> }[] = [];
    const spawner: GrokSpawner = (bin, args, cwd, env) => {
      calls.push({ args, env });
      spec = JSON.parse(readFileSync(env?.ARCHON_HOOK_SPEC ?? '', 'utf8')) as Record<
        string,
        unknown
      >;
      return fakeSpawner([END]).spawner(bin, args, cwd, env);
    };
    const hookSpecs = { Stop: [{ response: { systemMessage: 'bye' } }] };
    await collect(
      new GrokClient({ spawner, executable: 'grok' }).sendQuery('p', '/w', undefined, {
        env: { FOO: '1' },
        disallowedTools: ['Bash'],
        hookSpecs,
      })
    );
    expect(spec).toEqual({
      version: 1,
      provider: 'grok',
      cwd: '/w',
      pathGuard: true,
      deniedTools: ['Bash'],
      hooks: hookSpecs,
    });
    expect(calls[0].env?.FOO).toBe('1');
    expect(calls[0].env?.ARCHON_HOOK_EVENTS).toBe('PreToolUse,Stop');
    expect(existsSync(join(grokHome, 'hooks', 'archon-dispatcher.json'))).toBe(true);
    expect(existsSync(calls[0].env?.ARCHON_HOOK_SPEC ?? '')).toBe(false);
  });

  test('MCP servers go into a per-run agent definition passed with --agent', async () => {
    let agent = '';
    const spawner: GrokSpawner = (bin, args, cwd, env) => {
      agent = readFileSync(args[args.indexOf('--agent') + 1], 'utf8');
      return fakeSpawner([END]).spawner(bin, args, cwd, env);
    };
    await collect(
      new GrokClient({ spawner, executable: 'grok' }).sendQuery('p', '/w', undefined, {
        mcpConfigs: { parity: { command: 'bun', args: ['srv.ts'], env: { T: 'x' } } },
      })
    );
    expect(agent).toContain('prompt_mode: full');
    expect(agent).toContain('mcpServers:\n  - name: "parity"\n    command: "bun"');
    expect(agent).toContain('args: ["srv.ts"]');
    expect(agent).toContain('"T": "x"');
  });

  test('skills are preloaded through --rules', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'grok-skills-'));
    mkdirSync(join(cwd, '.claude', 'skills', 'deploy'), { recursive: true });
    writeFileSync(
      join(cwd, '.claude', 'skills', 'deploy', 'SKILL.md'),
      '---\nname: deploy\ndescription: d\n---\nAlways run the smoke test.\n'
    );
    const { spawner, calls } = fakeSpawner([END]);
    await collect(
      new GrokClient({ spawner, executable: 'grok' }).sendQuery('p', cwd, undefined, {
        skills: ['deploy'],
      })
    );
    const rules = calls[0].args[calls[0].args.indexOf('--rules') + 1];
    expect(rules).toContain('(deploy)');
    expect(rules).toContain('Always run the smoke test.');
  });

  test('sandbox adds a custom profile to sandbox.toml and passes --sandbox', async () => {
    const { spawner, calls } = fakeSpawner([END]);
    await collect(
      new GrokClient({ spawner, executable: 'grok' }).sendQuery('p', '/w', undefined, {
        sandbox: { enabled: true, filesystem: { denyRead: ['/secret'] } },
      })
    );
    const profile = calls[0].args[calls[0].args.indexOf('--sandbox') + 1];
    expect(profile).toMatch(/^archon-/);
    const toml = readFileSync(join(grokHome, 'sandbox.toml'), 'utf8');
    expect(toml).toContain(`[profiles.${profile}]`);
    expect(toml).toContain('deny = ["/secret"]');
  });

  test('a refused sandbox profile fails with a clear error', async () => {
    const { spawner } = fakeSpawner(
      [],
      1,
      "error: could not apply the 'archon-x' sandbox profile; see the warning above for the cause. Refusing to start with its protections missing."
    );
    await expect(
      collect(
        new GrokClient({ spawner, executable: 'grok' }).sendQuery('p', '/w', undefined, {
          sandbox: { enabled: true },
        })
      )
    ).rejects.toThrow("could not enforce this node's sandbox");
  });

  test('maxBudgetUsd stops the run once the per-call usage passes the cap', async () => {
    let killed = false;
    const { spawner: base } = fakeSpawner([
      { type: 'text', data: 'working' },
      {
        type: 'usage',
        usage: { input_tokens: 10000, cache_read_input_tokens: 0, output_tokens: 1000 },
      },
      {
        type: 'usage',
        usage: { input_tokens: 100000, cache_read_input_tokens: 0, output_tokens: 0 },
      },
      END,
    ]);
    const spawner: GrokSpawner = (...a) => ({
      ...base(...a),
      kill: () => {
        killed = true;
      },
    });
    const chunks = await collect(
      new GrokClient({ spawner, executable: 'grok' }).sendQuery('p', '/w', undefined, {
        model: 'grok-4.7-build',
        maxBudgetUsd: 0.05,
      })
    );
    const result = chunks.find(c => c.type === 'result') as {
      isError?: boolean;
      errorSubtype?: string;
      cost?: number;
    };
    // (110000 * 0.68 + 1000 * 2.04) / 1e6 = 0.07684
    expect(killed).toBe(true);
    expect(result.isError).toBe(true);
    expect(result.errorSubtype).toBe('error_max_budget_usd');
    expect(result.cost).toBeCloseTo(0.07684, 6);
  });

  test('fallbackModel retries once on a model error', async () => {
    const calls: string[][] = [];
    const spawner: GrokSpawner = (bin, args, cwd, env) => {
      calls.push(args);
      return calls.length === 1
        ? fakeSpawner([{ type: 'error', message: 'model grok-x not found' }], 1).spawner(
            bin,
            args,
            cwd,
            env
          )
        : fakeSpawner([END]).spawner(bin, args, cwd, env);
    };
    const chunks = await collect(
      new GrokClient({ spawner, executable: 'grok' }).sendQuery('p', '/w', undefined, {
        model: 'grok-x',
        fallbackModel: 'grok-4.7-build',
      })
    );
    expect(calls[1][calls[1].indexOf('--model') + 1]).toBe('grok-4.7-build');
    expect(chunks.some(c => c.type === 'system' && c.content.includes('fallback model'))).toBe(
      true
    );
    expect(chunks[chunks.length - 1]).toMatchObject({ type: 'result' });
  });

  test('output_format uses --json-schema and yields structured output', async () => {
    const { spawner, calls } = fakeSpawner([
      { text: '{"ok":true}', stopReason: 'end_turn', sessionId: 's', usage: {} },
    ]);
    const chunks = await collect(
      new GrokClient({ spawner, executable: 'grok' }).sendQuery('p', '/w', undefined, {
        outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      })
    );
    expect(calls[0].args).toContain('--json-schema');
    expect(calls[0].args).not.toContain('streaming-json');
    expect(chunks[0]).toEqual({ type: 'assistant', content: '{"ok":true}' });
    expect((chunks[1] as { structuredOutput?: unknown }).structuredOutput).toEqual({ ok: true });
  });
});

describe('buildGrokArgs', () => {
  test('base flags: headless, bypass permissions, no auto-update', () => {
    const args = buildGrokArgs('hi', '/w', undefined, undefined);
    expect(args.slice(0, 4)).toEqual(['-p', 'hi', '--cwd', '/w']);
    expect(args).toContain('--no-auto-update');
    expect(args.join(' ')).toContain('--permission-mode bypassPermissions');
    expect(args.join(' ')).toContain('--output-format streaming-json');
  });

  test('resume, model, system prompt, effort', () => {
    const a = buildGrokArgs('hi', '/w', 'sess', {
      model: 'grok-4.7-build',
      systemPrompt: 'Be terse',
      effort: 'high',
    }).join(' ');
    expect(a).toContain('--resume sess');
    expect(a).toContain('--model grok-4.7-build');
    expect(a).toContain('--system-prompt-override Be terse');
    expect(a).toContain('--effort high');
  });

  test('tools map Claude names to Grok ids; [] denies everything', () => {
    expect(buildGrokArgs('p', '/w', undefined, { tools: ['Read', 'Grep'] }).join(' ')).toContain(
      '--tools read_file,grep'
    );
    const none = buildGrokArgs('p', '/w', undefined, { tools: [] });
    const denied = none[none.indexOf('--disallowed-tools') + 1];
    expect(denied).toContain('run_terminal_command');
    expect(denied).toContain('write');
    expect(none).not.toContain('--tools');
  });

  test('denied tools and disabled web search merge into one flag', () => {
    const a = buildGrokArgs('p', '/w', undefined, {
      disallowedTools: ['Bash'],
      webSearchMode: 'disabled',
    });
    expect(a.filter(x => x === '--disallowed-tools')).toHaveLength(1);
    expect(a[a.indexOf('--disallowed-tools') + 1]).toBe(
      'run_terminal_command,kill_command_or_subagent,get_command_or_subagent_output,web_search,web_fetch'
    );
  });

  test('mapToolsToGrok passes unknown names through', () => {
    expect(mapToolsToGrok(['Edit', 'Write', 'image_gen'])).toEqual([
      'search_replace',
      'write',
      'image_gen',
    ]);
  });
});
