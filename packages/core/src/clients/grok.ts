/**
 * Grok CLI client ("Grok Build", xAI's coding agent)
 *
 * Drives the `grok` binary headless on the user's SuperGrok subscription (the
 * OAuth login in ~/.grok/auth.json, made once with `grok login --device-auth`).
 * It never uses an API key and never goes through the LLM gateway: a subscription
 * login is only valid against xAI's own servers.
 *
 *   grok -p <prompt> --cwd <dir> --output-format streaming-json
 *        --permission-mode bypassPermissions --no-auto-update [options]
 *
 * streaming-json is NDJSON, one `type`-tagged object per line (text, thought,
 * tool_call, tool_call_update, usage, available_commands, end, error); `end` is
 * always last and carries sessionId, usage and, when the server stamped it,
 * total_cost_usd. On OAuth the cost can be missing (cost_is_partial); then it is
 * read from the session's usage.json, which records costUsdTicks per turn.
 * With an output_format the run uses --json-schema, which forces the single
 * `json` result object instead of the stream.
 *
 * Grok is Claude Code-compatible, so most node options map onto its own flags
 * (each verified by a live run in the archon sandbox, grok 1.0.41):
 *   systemPrompt  -> --system-prompt-override (replaces, like Claude's string form:
 *                    the session's system_prompt.txt holds only the override)
 *   allowed/denied tools -> --tools / --disallowed-tools (Claude names mapped to
 *                    Grok's tool ids), and again in the hook dispatcher
 *   effort        -> --effort; thinking: disabled -> --effort none
 *   skills        -> preloaded through --rules (as Claude preloads them)
 *   mcp           -> `mcpServers` in a per-run agent definition (--agent <file>)
 *   hooks, path guard -> Archon's CLI hook dispatcher (hook-dispatcher.ts)
 *   sandbox       -> a custom profile in $GROK_HOME/sandbox.toml (--sandbox); Grok
 *                    refuses to start when it cannot enforce a custom profile
 *   maxBudgetUsd  -> Archon prices the stream's per-call `usage` lines and stops
 *   fallbackModel -> Archon retries once on a model error
 *   betas         -> refused (Anthropic-only)
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  accessSync,
  constants as fsConstants,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createLogger } from '@archon/paths';
import { formatUsd } from '@archon/workflows/utils/format-usd';
import type { AssistantRequestOptions, IAssistantClient, MessageChunk, TokenUsage } from '../types';
import { ensureGrokDispatcher, prepareHookRun, unsupportedHookEvents } from './cli-hooks';
import { loadSkills } from './skill-loader';
import {
  mapSandboxForGrok,
  modelRates,
  noRatesError,
  priceTokens,
  readTextOr,
  refusedClaudeOnlyOptions,
  withGrokProfile,
  type PricedTokens,
} from './subscription-options';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('client.grok');
  return cachedLog;
}

/** One running grok process, as the client needs it (injectable for tests). */
export interface GrokProcess {
  lines: AsyncIterable<string>;
  stderr: Promise<string>;
  exitCode: Promise<number | null>;
  kill(): void;
}
export type GrokSpawner = (
  bin: string,
  args: string[],
  cwd: string,
  env?: Record<string, string>
) => GrokProcess;

const defaultSpawner: GrokSpawner = (bin, args, cwd, env) => {
  // Subscription only: never let an API key reach the CLI.
  const merged = Object.fromEntries(
    Object.entries({ ...process.env, ...(env ?? {}) }).filter(([k]) => !API_KEY_ENV.includes(k))
  );
  const child = spawn(bin, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: merged,
  });
  let err = '';
  child.stderr.on('data', (d: Buffer) => {
    if (err.length < 20_000) err += d.toString();
  });
  const exitCode = new Promise<number | null>(resolve => {
    child.on('close', code => {
      resolve(code);
    });
    child.on('error', () => {
      resolve(null);
    });
  });
  return {
    lines: createInterface({ input: child.stdout }),
    stderr: exitCode.then(() => err),
    exitCode,
    kill: () => child.kill('SIGTERM'),
  };
};

/**
 * The grok binary: ARCHON_GROK_EXECUTABLE, else ~/.local/bin/grok (where the
 * installer and the sandbox provisioning put it; the broker's exec PATH does not
 * include it), else `grok` from PATH.
 */
export function resolveGrokExecutable(): string {
  const candidates = [process.env.ARCHON_GROK_EXECUTABLE, join(homedir(), '.local', 'bin', 'grok')];
  for (const c of candidates) {
    if (!c) continue;
    try {
      accessSync(c, fsConstants.X_OK);
      return c;
    } catch {
      // next
    }
  }
  return 'grok';
}

/**
 * Claude tool names (what workflow YAML uses) -> Grok tool ids, checked against a
 * live run's available_commands (grok 1.0.41). Unknown names pass through, so a
 * workflow can also name Grok ids directly.
 */
const CLAUDE_TO_GROK_TOOLS: Record<string, string[]> = {
  Bash: ['run_terminal_command', 'kill_command_or_subagent', 'get_command_or_subagent_output'],
  Read: ['read_file'],
  Edit: ['search_replace'],
  MultiEdit: ['search_replace'],
  NotebookEdit: ['search_replace'],
  Write: ['write'],
  Glob: ['list_dir'],
  LS: ['list_dir'],
  Grep: ['grep'],
  WebSearch: ['web_search'],
  WebFetch: ['web_fetch'],
  Task: ['spawn_subagent'],
  Agent: ['spawn_subagent'],
  TodoWrite: ['todo_write'],
};

export function mapToolsToGrok(tools: string[]): string[] {
  const out = new Set<string>();
  for (const t of tools) {
    for (const g of CLAUDE_TO_GROK_TOOLS[t] ?? [t]) out.add(g);
  }
  return [...out];
}

/** Claude effort levels map 1:1 onto Grok's canonical levels. */
const GROK_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/** API-key variables a subscription run must never see. */
const API_KEY_ENV = ['XAI_API_KEY', 'GROK_API_KEY'];

/**
 * Options Grok cannot honour. They are REFUSED, never quietly dropped and never
 * sent to an API: a node that asked for something must not run without it.
 */
function unsupportedOptions(options?: AssistantRequestOptions): string[] {
  const out = refusedClaudeOnlyOptions(options);
  if (options?.hooks && Object.keys(options.hooks).length > 0) {
    out.push('in-process hooks (pass the YAML hooks as hookSpecs)');
  }
  const badEvents = unsupportedHookEvents('grok', options?.hookSpecs);
  if (badEvents.length > 0) out.push(`hook events Grok never fires: ${badEvents.join(', ')}`);
  return out;
}

/** Per-run files handed to grok (agent definition for MCP). */
export interface GrokRunFiles {
  /** Path of the per-run agent definition, when the node has MCP servers. */
  agentFile?: string;
  /** Custom sandbox profile name, when the node has a sandbox. */
  sandboxProfile?: string;
  /** Preloaded skill text for --rules. */
  rules?: string;
}

type McpConfigs = NonNullable<AssistantRequestOptions['mcpConfigs']>;

/**
 * A Grok agent definition that is the default agent plus the node's MCP servers.
 * `prompt_mode: full` keeps Grok's whole system prompt; the empty body adds no
 * role text. Grok takes `mcpServers` as a LIST of named servers (a map fails to
 * parse). Verified live: a stdio server's tool was called with its env.
 */
export function buildGrokAgentFile(mcp: McpConfigs): string {
  const lines = [
    '---',
    'name: archon-node',
    'description: Archon workflow node (default agent plus the node MCP servers)',
    'prompt_mode: full',
    'mcpServers:',
  ];
  for (const [name, server] of Object.entries(mcp)) {
    lines.push(`  - name: ${JSON.stringify(name)}`);
    if ('url' in server) {
      if (server.type) lines.push(`    type: ${JSON.stringify(server.type)}`);
      lines.push(`    url: ${JSON.stringify(server.url)}`);
      if (server.headers && Object.keys(server.headers).length > 0) {
        lines.push('    headers:');
        for (const [k, v] of Object.entries(server.headers)) {
          lines.push(`      ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
        }
      }
    } else {
      lines.push(`    command: ${JSON.stringify(server.command)}`);
      if (server.args) lines.push(`    args: ${JSON.stringify(server.args)}`);
      if (server.env && Object.keys(server.env).length > 0) {
        lines.push('    env:');
        for (const [k, v] of Object.entries(server.env)) {
          lines.push(`      ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
        }
      }
    }
  }
  lines.push('---', '');
  return lines.join('\n');
}

export function buildGrokArgs(
  prompt: string,
  cwd: string,
  resumeSessionId: string | undefined,
  options: AssistantRequestOptions | undefined,
  files: GrokRunFiles = {}
): string[] {
  const args = ['-p', prompt, '--cwd', cwd, '--no-auto-update'];
  args.push('--permission-mode', 'bypassPermissions');
  if (files.agentFile) args.push('--agent', files.agentFile);
  if (files.sandboxProfile) args.push('--sandbox', files.sandboxProfile);
  if (files.rules) args.push('--rules', files.rules);
  if (options?.outputFormat) {
    args.push('--json-schema', JSON.stringify(options.outputFormat.schema));
  } else {
    args.push('--output-format', 'streaming-json');
  }
  if (resumeSessionId) args.push('--resume', resumeSessionId);
  if (options?.model) args.push('--model', options.model);
  if (options?.systemPrompt) args.push('--system-prompt-override', options.systemPrompt);
  const effort = options?.effort ?? options?.modelReasoningEffort;
  if (effort && GROK_EFFORTS.has(effort)) args.push('--effort', effort);
  if (options?.thinking?.type === 'disabled' && !effort) args.push('--effort', 'none');
  const denied = new Set<string>();
  if (options?.tools !== undefined) {
    // [] means "no tools": Grok's --tools needs a list, so deny every mapped tool instead
    if (options.tools.length === 0) {
      for (const t of mapToolsToGrok(Object.keys(CLAUDE_TO_GROK_TOOLS))) denied.add(t);
    } else {
      args.push('--tools', mapToolsToGrok(options.tools).join(','));
    }
  }
  for (const t of mapToolsToGrok(options?.disallowedTools ?? [])) denied.add(t);
  if (options?.webSearchMode === 'disabled') {
    denied.add('web_search');
    denied.add('web_fetch');
  }
  if (denied.size > 0) args.push('--disallowed-tools', [...denied].join(','));
  return args;
}

interface GrokSpend {
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    total_tokens?: number;
  };
  modelUsage?: Record<string, { outputTokens?: number }>;
  total_cost_usd?: number;
  total_cost_usd_ticks?: number;
  sessionId?: string;
}

/**
 * Cost of the session's LAST turn from usage.json (costUsdTicks, 1e10 = $1), for
 * when the stream carried no cost. Sessions live under
 * $GROK_HOME/sessions/<url-encoded cwd>/<session id>/. Never throws.
 */
export function readTurnCostFromUsageFile(
  sessionId: string,
  cwd: string,
  grokHome?: string
): number | undefined {
  const home = grokHome ?? process.env.GROK_HOME ?? join(homedir(), '.grok');
  try {
    const raw = readFileSync(
      join(home, 'sessions', encodeURIComponent(cwd), sessionId, 'usage.json'),
      'utf8'
    );
    const parsed = JSON.parse(raw) as { turns?: { costUsdTicks?: number }[] };
    const last = parsed.turns?.[parsed.turns.length - 1];
    return typeof last?.costUsdTicks === 'number' ? last.costUsdTicks / 1e10 : undefined;
  } catch (err) {
    getLog().debug({ err, sessionId }, 'grok.usage_file_read_failed');
    return undefined;
  }
}

function tokensFromSpend(spend: GrokSpend): TokenUsage {
  const u = spend.usage ?? {};
  const input = u.input_tokens ?? 0; // uncached only (Grok's headless projector)
  const output = u.output_tokens ?? 0;
  const models = Object.entries(spend.modelUsage ?? {});
  const model = models.sort((a, b) => (b[1].outputTokens ?? 0) - (a[1].outputTokens ?? 0))[0]?.[0];
  return {
    input,
    output,
    // everything, cache included: total - input - output = cached input
    total: u.total_tokens ?? input + output + (u.cache_read_input_tokens ?? 0),
    ...(model ? { model } : {}),
  };
}

function costFromSpend(spend: GrokSpend, cwd: string): number | undefined {
  if (typeof spend.total_cost_usd_ticks === 'number') return spend.total_cost_usd_ticks / 1e10;
  if (typeof spend.total_cost_usd === 'number') return spend.total_cost_usd;
  return spend.sessionId ? readTurnCostFromUsageFile(spend.sessionId, cwd) : undefined;
}

function grokHomeDir(): string {
  return process.env.GROK_HOME ?? join(homedir(), '.grok');
}

/** A failure that names the model, so fallbackModel can retry on it. */
class GrokModelError extends Error {}

function isGrokModelError(reason: string): boolean {
  const m = reason.toLowerCase();
  return (
    m.includes('model') &&
    ['not found', 'not available', 'unknown', 'unsupported', 'invalid', 'does not exist'].some(s =>
      m.includes(s)
    )
  );
}

/**
 * Rates for enforcing maxBudgetUsd. With no model named, Grok runs its own default,
 * which the stream only names at the end; price at the highest known Grok rate
 * then, so the cap stops early rather than late.
 */
function budgetRates(
  options?: AssistantRequestOptions
): { rates: NonNullable<ReturnType<typeof modelRates>>; model?: string; note: string } | undefined {
  if (options?.maxBudgetUsd === undefined) return undefined;
  if (options.model) {
    const rates = modelRates(options.model);
    if (!rates) throw noRatesError('Grok', options.model);
    return { rates, model: options.model, note: '' };
  }
  const known = ['grok-4.7-build']
    .map(m => modelRates(m))
    .filter((r): r is NonNullable<typeof r> => !!r);
  if (known.length === 0) throw noRatesError('Grok', undefined);
  const rates = {
    input: Math.max(...known.map(r => r.input)),
    cachedInput: Math.max(...known.map(r => r.cachedInput)),
    output: Math.max(...known.map(r => r.output)),
  };
  return { rates, note: ', priced at the highest known Grok rate' };
}

export class GrokClient implements IAssistantClient {
  private readonly spawner: GrokSpawner;
  private readonly bin: string;

  constructor(options?: { spawner?: GrokSpawner; executable?: string }) {
    this.spawner = options?.spawner ?? defaultSpawner;
    this.bin = options?.executable ?? resolveGrokExecutable();
  }

  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    options?: AssistantRequestOptions
  ): AsyncGenerator<MessageChunk> {
    const unsupported = unsupportedOptions(options);
    if (unsupported.length > 0) {
      throw new Error(
        `Grok provider cannot honour ${unsupported.join('; ')}. Remove them from this node or run it on Claude; Archon never falls back to an API key for a subscription provider.`
      );
    }
    if (options?.abortSignal?.aborted) throw new Error('Query aborted');
    const rates = budgetRates(options);

    const files: GrokRunFiles = {};
    const cleanups: (() => void)[] = [];
    try {
      const sandbox = mapSandboxForGrok(options?.sandbox, cwd);
      if (sandbox) {
        const path = join(grokHomeDir(), 'sandbox.toml');
        const before = readTextOr(path, '');
        const after = withGrokProfile(before, sandbox);
        if (after !== before) writeFileSync(path, after);
        files.sandboxProfile = sandbox.name;
      }
      if (options?.mcpConfigs && Object.keys(options.mcpConfigs).length > 0) {
        const dir = join(tmpdir(), 'archon-grok-agents');
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const agentFile = join(dir, `${randomUUID()}.md`);
        writeFileSync(agentFile, buildGrokAgentFile(options.mcpConfigs), { mode: 0o600 });
        cleanups.push(() => {
          rmSync(agentFile, { force: true });
        });
        files.agentFile = agentFile;
      }
      if (options?.skills && options.skills.length > 0) {
        const skills = await loadSkills(options.skills, cwd);
        if (skills.systemPromptAdditions.length > 0) {
          files.rules =
            `Skills preloaded for this task (${options.skills.join(', ')}). Follow them when relevant.\n\n` +
            skills.systemPromptAdditions.join('\n\n---\n\n');
        }
      }
      ensureGrokDispatcher();
      const hookRun = prepareHookRun({
        version: 1,
        provider: 'grok',
        cwd,
        pathGuard: true,
        ...(options?.tools !== undefined ? { allowedTools: options.tools } : {}),
        ...(options?.disallowedTools !== undefined ? { deniedTools: options.disallowedTools } : {}),
        ...(options?.hookSpecs ? { hooks: options.hookSpecs } : {}),
      });
      cleanups.push(hookRun.cleanup);
      const env = { ...(options?.env ?? {}), ...hookRun.env };

      try {
        yield* this.runOnce(
          prompt,
          cwd,
          resumeSessionId,
          options,
          options?.model,
          files,
          env,
          rates
        );
      } catch (error) {
        const fallback = options?.fallbackModel;
        if (!(error instanceof GrokModelError) || !fallback || fallback === options?.model) {
          throw error;
        }
        getLog().info({ model: options?.model, fallback }, 'grok.fallback_model');
        yield {
          type: 'system',
          content: `⚠️ Model "${options?.model ?? 'default'}" failed (${error.message}); retrying with fallback model "${fallback}".`,
        };
        yield* this.runOnce(
          prompt,
          cwd,
          resumeSessionId,
          options,
          fallback,
          files,
          env,
          budgetRates({ ...options, model: fallback })
        );
      }
    } finally {
      for (const c of cleanups) c();
    }
  }

  private async *runOnce(
    prompt: string,
    cwd: string,
    resumeSessionId: string | undefined,
    options: AssistantRequestOptions | undefined,
    model: string | undefined,
    files: GrokRunFiles,
    env: Record<string, string>,
    rates: ReturnType<typeof budgetRates>
  ): AsyncGenerator<MessageChunk> {
    const args = buildGrokArgs(prompt, cwd, resumeSessionId, { ...options, model }, files);
    getLog().debug({ cwd, model, resume: !!resumeSessionId }, 'grok.spawn');
    const proc = this.spawner(this.bin, args, cwd, env);
    const onAbort = (): void => {
      proc.kill();
    };
    options?.abortSignal?.addEventListener('abort', onAbort, { once: true });

    let ended = false;
    let failure: string | undefined;
    const toolNames = new Map<string, string>(); // toolCallId -> name, to pair results
    const spent: PricedTokens = { uncached: 0, cached: 0, output: 0 };
    let sessionId: string | undefined;
    try {
      for await (const line of proc.lines) {
        if (!line.trim()) continue;
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(line) as Record<string, unknown>;
        } catch {
          getLog().debug({ line: line.slice(0, 200) }, 'grok.non_json_line');
          continue;
        }

        // --json-schema: one result object, no `type`
        if (options?.outputFormat && ev.type === undefined) {
          const text = typeof ev.text === 'string' ? ev.text : '';
          let structuredOutput: unknown;
          try {
            structuredOutput = JSON.parse(text);
          } catch {
            structuredOutput = undefined;
          }
          if (text) yield { type: 'assistant', content: text };
          const spend = ev as GrokSpend;
          yield {
            type: 'result',
            sessionId: spend.sessionId,
            tokens: tokensFromSpend(spend),
            cost: costFromSpend(spend, cwd),
            ...(structuredOutput !== undefined ? { structuredOutput } : {}),
            ...(typeof ev.stopReason === 'string' ? { stopReason: ev.stopReason } : {}),
            ...(typeof ev.num_turns === 'number' ? { numTurns: ev.num_turns } : {}),
          };
          ended = true;
          continue;
        }

        switch (ev.type) {
          case 'text':
            if (typeof ev.data === 'string' && ev.data) {
              yield { type: 'assistant', content: ev.data };
            }
            break;
          case 'thought':
            if (typeof ev.data === 'string' && ev.data) {
              yield { type: 'thinking', content: ev.data };
            }
            break;
          case 'tool_call': {
            const name =
              typeof ev.toolName === 'string'
                ? ev.toolName
                : typeof ev.title === 'string'
                  ? ev.title
                  : 'tool';
            if (typeof ev.toolCallId === 'string') toolNames.set(ev.toolCallId, name);
            yield {
              type: 'tool',
              toolName: name,
              ...(ev.rawInput && typeof ev.rawInput === 'object'
                ? { toolInput: ev.rawInput as Record<string, unknown> }
                : {}),
            };
            break;
          }
          case 'tool_call_update':
            if (ev.status === 'completed' || ev.status === 'failed') {
              const out = ev.rawOutput as { output_for_prompt?: unknown } | null | undefined;
              yield {
                type: 'tool_result',
                toolName:
                  (typeof ev.toolCallId === 'string' ? toolNames.get(ev.toolCallId) : undefined) ??
                  'tool',
                toolOutput:
                  typeof out?.output_for_prompt === 'string'
                    ? out.output_for_prompt
                    : JSON.stringify(ev.content ?? ''),
              };
            }
            break;
          case 'error':
            failure = typeof ev.message === 'string' ? ev.message : 'Unknown Grok error';
            getLog().error({ message: failure }, 'grok.stream_error');
            yield { type: 'system', content: `❌ Grok error: ${failure}` };
            break;
          case 'end': {
            const spend = ev as GrokSpend;
            const cost = costFromSpend(spend, cwd);
            const over =
              options?.maxBudgetUsd !== undefined &&
              cost !== undefined &&
              cost > options.maxBudgetUsd;
            yield {
              type: 'result',
              sessionId: spend.sessionId,
              tokens: tokensFromSpend(spend),
              cost,
              ...(typeof ev.stopReason === 'string' ? { stopReason: ev.stopReason } : {}),
              ...(typeof ev.num_turns === 'number' ? { numTurns: ev.num_turns } : {}),
              ...(over ? { isError: true, errorSubtype: 'error_max_budget_usd' } : {}),
            };
            ended = true;
            break;
          }
          case 'usage': {
            // one line per model call; enforce maxBudgetUsd between calls
            const u = (ev.usage ?? {}) as GrokSpend['usage'] & object;
            spent.uncached += u.input_tokens ?? 0;
            spent.cached += u.cache_read_input_tokens ?? 0;
            spent.output += u.output_tokens ?? 0;
            if (typeof ev.sessionId === 'string') sessionId = ev.sessionId;
            if (rates && options?.maxBudgetUsd !== undefined) {
              const cost = priceTokens(rates.rates, spent);
              if (cost > options.maxBudgetUsd) {
                proc.kill();
                getLog().warn(
                  { cost, budget: options.maxBudgetUsd, model: rates.model },
                  'grok.max_budget_exceeded'
                );
                yield {
                  type: 'system',
                  content: `❌ Stopped: this node's usage reached $${cost.toFixed(4)} (API-equivalent${rates.note}), over its maxBudgetUsd of $${formatUsd(options.maxBudgetUsd)}.`,
                };
                yield {
                  type: 'result',
                  sessionId,
                  tokens: {
                    input: spent.uncached,
                    output: spent.output,
                    total: spent.uncached + spent.cached + spent.output,
                    ...(model ? { model } : {}),
                  },
                  cost,
                  isError: true,
                  errorSubtype: 'error_max_budget_usd',
                };
                return;
              }
            }
            break;
          }
          default:
            // plan, available_commands, max_turns_reached, auto_compact_*
            break;
        }
      }
    } finally {
      options?.abortSignal?.removeEventListener('abort', onAbort);
    }

    const code = await proc.exitCode;
    if (options?.abortSignal?.aborted) throw new Error('Query aborted');
    if (failure || !ended || (code !== 0 && code !== null)) {
      const stderr = (await proc.stderr).trim().slice(-2000);
      const reason = failure ?? (stderr || `grok exited with code ${String(code)}`);
      if (isGrokModelError(reason)) throw new GrokModelError(reason);
      // Seen live in the archon microVM: "could not apply the '<p>' sandbox profile"
      // and "sandbox reports bwrap but required hook write-deny mounts are missing".
      if (files.sandboxProfile && /sandbox/i.test(reason)) {
        throw new Error(
          `Grok could not enforce this node's sandbox (profile ${files.sandboxProfile}) and refused to start: ${reason}`
        );
      }
      throw new Error(`Grok query failed: ${reason}`);
    }
  }

  getType(): string {
    return 'grok';
  }
}
