/**
 * Grok CLI provider ("Grok Build", xAI's coding agent).
 *
 * Drives the `grok` binary headless on the user's SuperGrok subscription (the
 * OAuth login in ~/.grok/auth.json, made once with `grok login --device-auth`).
 * It never uses an API key and never goes through an LLM gateway: a subscription
 * login is only valid against xAI's own servers, and every API-key variable is
 * stripped from the CLI's env (shared/subscription-env.ts).
 *
 *   grok -p <prompt> --cwd <dir> --output-format streaming-json
 *        --permission-mode bypassPermissions --no-auto-update [options]
 *
 * streaming-json is NDJSON, one `type`-tagged object per line (text, thought,
 * tool_call, tool_call_update, usage, available_commands, end, error); `end` is
 * always last and carries sessionId, usage and, when the server stamped it,
 * total_cost_usd. On OAuth the cost can be missing; then it is read from the
 * session's usage.json, which records costUsdTicks per turn. With an output
 * format the run uses --json-schema, which forces the single `json` result
 * object instead of the stream.
 *
 * Grok is Claude Code-compatible, so most node options map onto its own flags
 * (each verified by a live run in the archon sandbox, grok 1.0.41):
 *   systemPrompt  -> --system-prompt-override
 *   allowed/denied tools -> --tools / --disallowed-tools (Claude names mapped to
 *                    Grok's tool ids), and again in the hook dispatcher
 *   effort        -> --effort
 *   skills        -> preloaded through --rules (as Claude preloads them)
 *   mcp           -> `mcpServers` in a per-run agent definition (--agent <file>)
 *   hooks, path guard -> Archon's CLI hook dispatcher (shared/cli-hooks)
 *   sandbox       -> a custom profile in $GROK_HOME/sandbox.toml (--sandbox); Grok
 *                    refuses to start when it cannot enforce a custom profile
 *   maxBudgetUsd  -> Archon prices the stream's per-call `usage` lines and stops
 *   fallbackModel -> Archon retries once on a model error
 *   betas         -> refused (Anthropic-only)
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants as fsConstants, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createLogger } from '@archon/paths';
import { clampEffort } from '@archon/paths/effort';
import type {
  IAgentProvider,
  MessageChunk,
  ProviderCapabilities,
  SendQueryOptions,
  TokenUsage,
} from '../../types';
import { loadMcpConfig } from '../../mcp/config';
import { buildSubscriptionEnv } from '../../shared/subscription-env';
import {
  ensureGrokDispatcher,
  grokHome,
  prepareHookRun,
  unsupportedHookEvents,
} from '../../shared/cli-hooks/install';
import {
  formatBudget,
  loadSkillText,
  mapSandboxForGrok,
  modelRates,
  nodeHookSpecs,
  noRatesError,
  priceTokens,
  readTextOr,
  refusedClaudeOnlyOptions,
  withGrokProfile,
  type ModelRates,
  type PricedTokens,
} from '../../shared/subscription-options';
import { GROK_CAPABILITIES } from './capabilities';
import { GROK_EFFORTS, parseGrokConfig } from './config';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.grok');
  return cachedLog;
}

/** One running grok process, as the provider needs it (injectable for tests). */
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
  env: Record<string, string>
) => GrokProcess;

const defaultSpawner: GrokSpawner = (bin, args, cwd, env) => {
  const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env });
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
    kill: (): void => {
      child.kill('SIGTERM');
    },
  };
};

/**
 * The grok binary: `assistants.grok.grokBinaryPath`, else ARCHON_GROK_EXECUTABLE,
 * else ~/.local/bin/grok (where the installer puts it; a service PATH often does
 * not include it), else `grok` from PATH.
 */
export function resolveGrokExecutable(configured?: string): string {
  if (configured) return configured;
  const home = process.env.HOME ?? homedir();
  const candidates = [process.env.ARCHON_GROK_EXECUTABLE, join(home, '.local', 'bin', 'grok')];
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

/** Per-run inputs for the grok command line. */
export interface GrokRunArgs {
  model?: string;
  systemPrompt?: string;
  effort?: string;
  outputSchema?: Record<string, unknown>;
  allowedTools?: string[];
  deniedTools?: string[];
  /** Path of the per-run agent definition, when the node has MCP servers. */
  agentFile?: string;
  /** Custom sandbox profile name, when the node has a sandbox. */
  sandboxProfile?: string;
  /** Preloaded skill text for --rules. */
  rules?: string;
}

export function buildGrokArgs(
  prompt: string,
  cwd: string,
  resumeSessionId: string | undefined,
  run: GrokRunArgs
): string[] {
  const args = ['-p', prompt, '--cwd', cwd, '--no-auto-update'];
  args.push('--permission-mode', 'bypassPermissions');
  if (run.agentFile) args.push('--agent', run.agentFile);
  if (run.sandboxProfile) args.push('--sandbox', run.sandboxProfile);
  if (run.rules) args.push('--rules', run.rules);
  if (run.outputSchema) {
    args.push('--json-schema', JSON.stringify(run.outputSchema));
  } else {
    args.push('--output-format', 'streaming-json');
  }
  if (resumeSessionId) args.push('--resume', resumeSessionId);
  if (run.model) args.push('--model', run.model);
  if (run.systemPrompt) args.push('--system-prompt-override', run.systemPrompt);
  if (run.effort) args.push('--effort', run.effort);
  const denied = new Set<string>();
  if (run.allowedTools !== undefined) {
    // [] means "no tools": Grok's --tools needs a list, so deny every mapped tool instead
    if (run.allowedTools.length === 0) {
      for (const t of mapToolsToGrok(Object.keys(CLAUDE_TO_GROK_TOOLS))) denied.add(t);
    } else {
      args.push('--tools', mapToolsToGrok(run.allowedTools).join(','));
    }
  }
  for (const t of mapToolsToGrok(run.deniedTools ?? [])) denied.add(t);
  if (denied.size > 0) args.push('--disallowed-tools', [...denied].join(','));
  return args;
}

type McpServers = Record<string, unknown>;

function quote(v: unknown): string {
  return JSON.stringify(v);
}

/**
 * A Grok agent definition that is the default agent plus the node's MCP servers.
 * `prompt_mode: full` keeps Grok's whole system prompt; the empty body adds no
 * role text. Grok takes `mcpServers` as a LIST of named servers (a map fails to
 * parse). Verified live: a stdio server's tool was called with its env.
 */
export function buildGrokAgentFile(mcp: McpServers): string {
  const lines = [
    '---',
    'name: archon-node',
    'description: Archon workflow node (default agent plus the node MCP servers)',
    'prompt_mode: full',
    'mcpServers:',
  ];
  for (const [name, raw] of Object.entries(mcp)) {
    const server = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    lines.push(`  - name: ${quote(name)}`);
    const record = (key: string): void => {
      const value = server[key];
      if (!value || typeof value !== 'object' || Object.keys(value).length === 0) return;
      lines.push(`    ${key}:`);
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        lines.push(`      ${quote(k)}: ${quote(v)}`);
      }
    };
    if (typeof server.url === 'string') {
      if (typeof server.type === 'string') lines.push(`    type: ${quote(server.type)}`);
      lines.push(`    url: ${quote(server.url)}`);
      record('headers');
    } else {
      lines.push(`    command: ${quote(server.command)}`);
      if (Array.isArray(server.args)) lines.push(`    args: ${quote(server.args)}`);
      record('env');
    }
  }
  lines.push('---', '');
  return lines.join('\n');
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
  home: string = grokHome()
): number | undefined {
  try {
    const raw = readTextOr(
      join(home, 'sessions', encodeURIComponent(cwd), sessionId, 'usage.json'),
      ''
    );
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { turns?: { costUsdTicks?: number }[] };
    const last = parsed.turns?.[parsed.turns.length - 1];
    return typeof last?.costUsdTicks === 'number' ? last.costUsdTicks / 1e10 : undefined;
  } catch {
    return undefined;
  }
}

/** Grok reports uncached input; Archon's `input` is gross (cache reads included). */
function tokensFromSpend(spend: GrokSpend): TokenUsage {
  const u = spend.usage ?? {};
  const uncached = u.input_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens;
  const cacheWrite = u.cache_creation_input_tokens;
  const output = u.output_tokens ?? 0;
  const input = uncached + (cacheRead ?? 0) + (cacheWrite ?? 0);
  return {
    input,
    output,
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    total: u.total_tokens ?? input + output,
  };
}

function resolvedModelOf(spend: GrokSpend): string | undefined {
  const models = Object.entries(spend.modelUsage ?? {});
  return models.sort((a, b) => (b[1].outputTokens ?? 0) - (a[1].outputTokens ?? 0))[0]?.[0];
}

function costFromSpend(spend: GrokSpend, cwd: string): number | undefined {
  if (typeof spend.total_cost_usd_ticks === 'number') return spend.total_cost_usd_ticks / 1e10;
  if (typeof spend.total_cost_usd === 'number') return spend.total_cost_usd;
  return spend.sessionId ? readTurnCostFromUsageFile(spend.sessionId, cwd) : undefined;
}

/** A failure that names the model, so fallbackModel can retry on it. */
export class GrokModelError extends Error {}

function isGrokModelError(reason: string): boolean {
  const m = reason.toLowerCase();
  return (
    m.includes('model') &&
    ['not found', 'not available', 'unknown', 'unsupported', 'invalid', 'does not exist'].some(s =>
      m.includes(s)
    )
  );
}

interface BudgetRates {
  rates: ModelRates;
  model?: string;
  note: string;
}

/**
 * Rates for enforcing maxBudgetUsd. With no model named, Grok runs its own
 * default, which the stream only names at the end; price at the highest known
 * Grok rate then, so the cap stops early rather than late.
 */
function budgetRates(
  budget: number | undefined,
  model: string | undefined
): BudgetRates | undefined {
  if (budget === undefined) return undefined;
  if (model) {
    const rates = modelRates(model);
    if (!rates) throw noRatesError('Grok', model);
    return { rates, model, note: '' };
  }
  const known = ['grok-4.7-build'].map(m => modelRates(m)).filter((r): r is ModelRates => !!r);
  if (known.length === 0) throw noRatesError('Grok', undefined);
  return {
    rates: {
      input: Math.max(...known.map(r => r.input)),
      cachedInput: Math.max(...known.map(r => r.cachedInput)),
      output: Math.max(...known.map(r => r.output)),
    },
    note: ', priced at the highest known Grok rate',
  };
}

function systemPromptText(options?: SendQueryOptions): string | undefined {
  const raw = options?.systemPrompt ?? options?.nodeConfig?.systemPrompt;
  if (typeof raw === 'string') return raw.trim() ? raw : undefined;
  if (Array.isArray(raw)) return raw.join('\n\n');
  if (raw !== undefined) getLog().warn('grok.system_prompt_preset_dropped');
  return undefined;
}

function isWorkflowNode(options?: SendQueryOptions): boolean {
  const nodeId = options?.nodeConfig?.nodeId;
  return typeof nodeId === 'string' && nodeId.trim().length > 0;
}

export class GrokProvider implements IAgentProvider {
  private readonly spawner: GrokSpawner;
  private readonly executable: string | undefined;

  constructor(options?: { spawner?: GrokSpawner; executable?: string }) {
    this.spawner = options?.spawner ?? defaultSpawner;
    this.executable = options?.executable;
  }

  getType(): string {
    return 'grok';
  }

  getCapabilities(): ProviderCapabilities {
    return GROK_CAPABILITIES;
  }

  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    options?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    const nodeConfig = options?.nodeConfig;
    const config = parseGrokConfig(options?.assistantConfig ?? {});
    const hooks = nodeHookSpecs(nodeConfig);
    const refused = refusedClaudeOnlyOptions(nodeConfig);
    const badEvents = unsupportedHookEvents('grok', hooks);
    if (badEvents.length > 0) refused.push(`hook events Grok never fires: ${badEvents.join(', ')}`);
    if (refused.length > 0) {
      throw new Error(
        `Grok provider cannot honour ${refused.join('; ')}. Remove them from this node or run it on Claude; Archon never falls back to an API key for a subscription provider.`
      );
    }
    if (options?.abortSignal?.aborted) throw new Error('Query aborted');

    const model = options?.model ?? config.model;
    const budget = options?.maxBudgetUsd ?? nodeConfig?.maxBudgetUsd;
    const rates = budgetRates(budget, model);
    const effort =
      nodeConfig?.effort !== undefined
        ? clampEffort(nodeConfig.effort, GROK_EFFORTS)
        : config.modelReasoningEffort;
    const run: GrokRunArgs = {
      ...(systemPromptText(options) ? { systemPrompt: systemPromptText(options) } : {}),
      ...(effort ? { effort } : {}),
      ...(nodeConfig?.allowed_tools !== undefined
        ? { allowedTools: nodeConfig.allowed_tools }
        : {}),
      ...(nodeConfig?.denied_tools !== undefined ? { deniedTools: nodeConfig.denied_tools } : {}),
    };
    const schema = options?.outputFormat?.schema ?? nodeConfig?.output_format;
    if (schema) run.outputSchema = schema;

    const cleanups: (() => void)[] = [];
    try {
      const sandbox = mapSandboxForGrok(nodeConfig?.sandbox, cwd);
      if (sandbox) {
        const path = join(grokHome(), 'sandbox.toml');
        const before = readTextOr(path, '');
        const after = withGrokProfile(before, sandbox);
        if (after !== before) {
          mkdirSync(grokHome(), { recursive: true });
          writeFileSync(path, after);
        }
        run.sandboxProfile = sandbox.name;
      }
      if (nodeConfig?.mcp) {
        const { servers, serverNames, missingVars } = await loadMcpConfig(nodeConfig.mcp, cwd, {
          ...process.env,
          ...(options?.env ?? {}),
        });
        if (missingVars.length > 0) {
          yield {
            type: 'system',
            content: `⚠️ MCP config references undefined env vars: ${[...new Set(missingVars)].join(', ')}. These will be empty strings - MCP servers may fail to authenticate.`,
          };
        }
        if (serverNames.length > 0) {
          const dir = join(tmpdir(), 'archon-grok-agents');
          mkdirSync(dir, { recursive: true, mode: 0o700 });
          const agentFile = join(dir, `${randomUUID()}.md`);
          writeFileSync(agentFile, buildGrokAgentFile(servers), { mode: 0o600 });
          cleanups.push(() => {
            rmSync(agentFile, { force: true });
          });
          run.agentFile = agentFile;
        }
      }
      const skills = loadSkillText(cwd, nodeConfig?.skills);
      if (skills.text) run.rules = skills.text;
      if (skills.missing.length > 0) {
        yield {
          type: 'system',
          content: `⚠️ Grok could not preload missing skills: ${skills.missing.join(', ')}. Expected a directory with SKILL.md under .agents/skills/ or .claude/skills/ (project or home).`,
        };
      }
      const hooksHome = grokHome();
      ensureGrokDispatcher(hooksHome);
      const hookRun = prepareHookRun({
        version: 1,
        provider: 'grok',
        cwd,
        pathGuard: isWorkflowNode(options),
        ...(run.allowedTools !== undefined ? { allowedTools: run.allowedTools } : {}),
        ...(run.deniedTools !== undefined ? { deniedTools: run.deniedTools } : {}),
        ...(hooks ? { hooks } : {}),
      });
      cleanups.push(hookRun.cleanup);
      // Subscription only: no API key or base URL ever reaches the CLI.
      // GROK_HOME is forced to the home the dispatcher was installed in, so a
      // HOME or GROK_HOME in the project env cannot hand the CLI a home without
      // Archon's hooks.
      const env = buildSubscriptionEnv(process.env, options?.env, hookRun.env, {
        GROK_HOME: hooksHome,
      });

      const fallback = options?.fallbackModel ?? nodeConfig?.fallbackModel;
      try {
        yield* this.runOnce(
          prompt,
          cwd,
          resumeSessionId,
          options,
          { ...run, model },
          env,
          rates,
          budget
        );
      } catch (error) {
        if (!(error instanceof GrokModelError) || !fallback || fallback === model) throw error;
        getLog().info({ model, fallback }, 'grok.fallback_model');
        yield {
          type: 'system',
          content: `⚠️ Model "${model ?? 'default'}" failed (${error.message}); retrying with fallback model "${fallback}".`,
        };
        yield* this.runOnce(
          prompt,
          cwd,
          resumeSessionId,
          options,
          { ...run, model: fallback },
          env,
          budgetRates(budget, fallback),
          budget
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
    options: SendQueryOptions | undefined,
    run: GrokRunArgs,
    env: Record<string, string>,
    rates: BudgetRates | undefined,
    budget: number | undefined
  ): AsyncGenerator<MessageChunk> {
    const args = buildGrokArgs(prompt, cwd, resumeSessionId, run);
    const config = parseGrokConfig(options?.assistantConfig ?? {});
    const bin = this.executable ?? resolveGrokExecutable(config.grokBinaryPath);
    getLog().debug({ cwd, model: run.model, resume: !!resumeSessionId }, 'grok.spawn');
    const proc = this.spawner(bin, args, cwd, env);
    const onAbort = (): void => {
      proc.kill();
    };
    options?.abortSignal?.addEventListener('abort', onAbort, { once: true });

    const resultOf = (spend: GrokSpend, extra: Record<string, unknown>): MessageChunk => {
      const resolved = resolvedModelOf(spend);
      const cost = costFromSpend(spend, cwd);
      const over = budget !== undefined && cost !== undefined && cost > budget;
      return {
        type: 'result',
        ...(spend.sessionId ? { sessionId: spend.sessionId } : {}),
        tokens: tokensFromSpend(spend),
        ...(cost !== undefined ? { cost } : {}),
        ...(resolved ? { resolvedModel: { id: resolved } } : {}),
        ...(resumeSessionId !== undefined ? { resumed: spend.sessionId === resumeSessionId } : {}),
        ...extra,
        ...(over
          ? {
              isError: true,
              errorSubtype: 'error_max_budget_usd',
              errors: [`maxBudgetUsd of $${formatBudget(budget)} exceeded`],
            }
          : {}),
      } as MessageChunk;
    };

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
        if (run.outputSchema && ev.type === undefined) {
          const text = typeof ev.text === 'string' ? ev.text : '';
          let structuredOutput: unknown;
          try {
            structuredOutput = JSON.parse(text);
          } catch {
            structuredOutput = undefined;
          }
          if (text) yield { type: 'assistant', content: text };
          yield resultOf(ev as GrokSpend, {
            ...(structuredOutput !== undefined ? { structuredOutput } : {}),
            ...(typeof ev.stopReason === 'string' ? { stopReason: ev.stopReason } : {}),
            ...(typeof ev.num_turns === 'number' ? { numTurns: ev.num_turns } : {}),
          });
          ended = true;
          continue;
        }

        switch (ev.type) {
          case 'text':
            if (typeof ev.data === 'string' && ev.data)
              yield { type: 'assistant', content: ev.data };
            break;
          case 'thought':
            if (typeof ev.data === 'string' && ev.data)
              yield { type: 'thinking', content: ev.data };
            break;
          case 'tool_call': {
            const name =
              typeof ev.toolName === 'string'
                ? ev.toolName
                : typeof ev.title === 'string'
                  ? ev.title
                  : 'tool';
            const id = typeof ev.toolCallId === 'string' ? ev.toolCallId : undefined;
            if (id) toolNames.set(id, name);
            yield {
              type: 'tool',
              toolName: name,
              ...(ev.rawInput && typeof ev.rawInput === 'object'
                ? { toolInput: ev.rawInput as Record<string, unknown> }
                : {}),
              ...(id ? { toolCallId: id } : {}),
            };
            break;
          }
          case 'tool_call_update':
            if (ev.status === 'completed' || ev.status === 'failed') {
              const id = typeof ev.toolCallId === 'string' ? ev.toolCallId : undefined;
              const out = ev.rawOutput as { output_for_prompt?: unknown } | null | undefined;
              yield {
                type: 'tool_result',
                toolName: (id ? toolNames.get(id) : undefined) ?? 'tool',
                toolOutput:
                  typeof out?.output_for_prompt === 'string'
                    ? out.output_for_prompt
                    : JSON.stringify(ev.content ?? ''),
                ...(id ? { toolCallId: id } : {}),
                toolOutcome: ev.status === 'completed' ? 'success' : 'error',
              };
            }
            break;
          case 'error':
            failure = typeof ev.message === 'string' ? ev.message : 'Unknown Grok error';
            getLog().error({ message: failure }, 'grok.stream_error');
            yield { type: 'system', content: `❌ Grok error: ${failure}` };
            break;
          case 'end':
            yield resultOf(ev as GrokSpend, {
              ...(typeof ev.stopReason === 'string' ? { stopReason: ev.stopReason } : {}),
              ...(typeof ev.num_turns === 'number' ? { numTurns: ev.num_turns } : {}),
            });
            ended = true;
            break;
          case 'usage': {
            // one line per model call; enforce maxBudgetUsd between calls
            const u = (ev.usage ?? {}) as NonNullable<GrokSpend['usage']>;
            spent.uncached += u.input_tokens ?? 0;
            spent.cached += u.cache_read_input_tokens ?? 0;
            spent.output += u.output_tokens ?? 0;
            if (typeof ev.sessionId === 'string') sessionId = ev.sessionId;
            if (rates && budget !== undefined) {
              const cost = priceTokens(rates.rates, spent);
              if (cost > budget) {
                proc.kill();
                getLog().warn({ cost, budget, model: rates.model }, 'grok.max_budget_exceeded');
                yield {
                  type: 'system',
                  content: `❌ Stopped: this node's usage reached $${cost.toFixed(4)} (API-equivalent${rates.note}), over its maxBudgetUsd of $${formatBudget(budget)}.`,
                };
                yield {
                  type: 'result',
                  ...(sessionId ? { sessionId } : {}),
                  tokens: {
                    input: spent.uncached + spent.cached,
                    output: spent.output,
                    cacheRead: spent.cached,
                  },
                  cost,
                  isError: true,
                  errorSubtype: 'error_max_budget_usd',
                  errors: [`maxBudgetUsd of $${formatBudget(budget)} exceeded`],
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
      if (run.sandboxProfile && /sandbox/i.test(reason)) {
        throw new Error(
          `Grok could not enforce this node's sandbox (profile ${run.sandboxProfile}) and refused to start: ${reason}`
        );
      }
      throw new Error(`Grok query failed: ${reason}`);
    }
  }
}
