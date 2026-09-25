/**
 * Node options that the subscription CLIs (Codex, Grok) cannot take as-is from a
 * Claude-shaped workflow node, translated here once for both clients:
 *
 * - maxBudgetUsd: neither CLI has a spend cap, so Archon prices the usage the CLI
 *   reports mid-run and stops the run when it passes the cap. Prices are the
 *   API-equivalent rates (what the run would cost on the API), the same figure
 *   Dashed shows; a subscription run is not billed per token.
 * - sandbox: Claude's SandboxSettings mapped onto Codex's sandbox_mode and Grok's
 *   sandbox profiles. A setting that would be LOOSER than asked for when mapped
 *   (a per-domain network allowlist, a read deny Codex has no switch for) is
 *   refused; settings that only relax Claude's sandbox are ignored, which leaves
 *   the CLI's sandbox stricter than requested, never looser.
 * - betas: Anthropic API flags; refused.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { AssistantRequestOptions } from '../types';

/** USD per million tokens. */
export interface ModelRates {
  input: number;
  cachedInput: number;
  output: number;
}

/**
 * gpt-6-astra: Dashed api/model_rates.json (2026-09-25). grok-4.7-build: fitted
 * exactly (zero residual over 5 turns) to the costUsdTicks Grok records in its
 * own session usage.json; `grok-4.7` is the CLI's id for the same model (what
 * `--model` takes; usage reports it as grok-4.7-build). Extend or override with
 * ARCHON_MODEL_RATES, a JSON object of the same shape keyed by model id.
 */
const GROK_47: ModelRates = { input: 0.68, cachedInput: 0.17, output: 2.04 };
const BUILTIN_RATES: Record<string, ModelRates> = {
  'gpt-6-astra': { input: 10, cachedInput: 1, output: 50 },
  'grok-4.7-build': GROK_47,
  'grok-4.7': GROK_47,
};

export function modelRates(model: string | undefined): ModelRates | undefined {
  if (!model) return undefined;
  let extra: Record<string, ModelRates> = {};
  const raw = process.env.ARCHON_MODEL_RATES;
  if (raw) {
    try {
      extra = JSON.parse(raw) as Record<string, ModelRates>;
    } catch {
      extra = {};
    }
  }
  return extra[model] ?? BUILTIN_RATES[model];
}

/** Token counts in Archon's shape: `uncached` excludes the cached part. */
export interface PricedTokens {
  uncached: number;
  cached: number;
  output: number;
}

export function priceTokens(rates: ModelRates, t: PricedTokens): number {
  return (t.uncached * rates.input + t.cached * rates.cachedInput + t.output * rates.output) / 1e6;
}

export function noRatesError(provider: string, model: string | undefined): Error {
  return new Error(
    `${provider}: maxBudgetUsd needs a price for model "${model ?? 'default'}" and Archon has none. ` +
      'Set ARCHON_MODEL_RATES (JSON: {"<model>": {"input": <$/M>, "cachedInput": <$/M>, "output": <$/M>}}) or remove maxBudgetUsd from the node.'
  );
}

/** Options a subscription CLI refuses outright. */
export function refusedClaudeOnlyOptions(options?: AssistantRequestOptions): string[] {
  const out: string[] = [];
  if (options?.betas && options.betas.length > 0) {
    out.push('betas (Anthropic API beta flags; Claude only)');
  }
  return out;
}

type Sandbox = NonNullable<AssistantRequestOptions['sandbox']>;

function sandboxOn(sandbox: Sandbox | undefined): sandbox is Sandbox {
  return !!sandbox && sandbox.enabled === true;
}

/** true = full network, false = none; throws on a per-domain allowlist. */
function sandboxNetwork(provider: string, sandbox: Sandbox): boolean {
  const domains = sandbox.network?.allowedDomains;
  if (!domains || domains.length === 0) return false;
  if (domains.includes('*')) return true;
  throw new Error(
    `${provider} sandbox cannot limit network to specific domains (${domains.join(', ')}); ` +
      'use allowedDomains: ["*"] for full network or omit it for none.'
  );
}

function absPaths(paths: string[] | undefined, cwd: string): string[] {
  return (paths ?? []).map(p =>
    p.startsWith('~/') ? join(homedir(), p.slice(2)) : isAbsolute(p) ? p : resolve(cwd, p)
  );
}

export interface CodexSandbox {
  sandboxMode: 'workspace-write' | 'danger-full-access';
  networkAccessEnabled: boolean;
  /** Extra `--config` values (writable roots). */
  config: Record<string, unknown>;
}

/**
 * Codex: workspace-write lets commands write only the working directory (plus
 * writable roots) and blocks their network unless allowed. Verified live in the
 * archon sandbox (write outside cwd: read-only file system; curl: no network).
 */
export function mapSandboxForCodex(sandbox: Sandbox | undefined, cwd: string): CodexSandbox {
  if (!sandboxOn(sandbox)) {
    return { sandboxMode: 'danger-full-access', networkAccessEnabled: true, config: {} };
  }
  const refused: string[] = [];
  if (sandbox.filesystem?.denyRead?.length) refused.push('filesystem.denyRead');
  if (sandbox.filesystem?.denyWrite?.length) refused.push('filesystem.denyWrite');
  if (refused.length > 0) {
    throw new Error(
      `Codex sandbox cannot enforce ${refused.join(', ')} (it can only confine writes to the working directory and writable roots). Remove them or run the node on Claude or Grok.`
    );
  }
  const network = sandboxNetwork('Codex', sandbox);
  const roots = absPaths(sandbox.filesystem?.allowWrite, cwd);
  return {
    sandboxMode: 'workspace-write',
    networkAccessEnabled: network,
    config: roots.length > 0 ? { sandbox_workspace_write: { writable_roots: roots } } : {},
  };
}

export interface GrokSandboxProfile {
  name: string;
  /** The `[profiles.<name>]` TOML section to add to $GROK_HOME/sandbox.toml. */
  toml: string;
}

/**
 * Grok: a custom profile extending `workspace` (write CWD + temp only). Grok
 * refuses to START when an explicitly requested custom profile cannot be applied,
 * so an unenforceable sandbox fails the node rather than running unguarded.
 */
export function mapSandboxForGrok(
  sandbox: Sandbox | undefined,
  cwd: string
): GrokSandboxProfile | undefined {
  if (!sandboxOn(sandbox)) return undefined;
  const network = sandboxNetwork('Grok', sandbox);
  const lines = ['extends = "workspace"', `restrict_network = ${String(!network)}`];
  const rw = absPaths(sandbox.filesystem?.allowWrite, cwd);
  const ro = absPaths(sandbox.filesystem?.denyWrite, cwd);
  const deny = absPaths(sandbox.filesystem?.denyRead, cwd);
  const list = (xs: string[]): string => `[${xs.map(x => JSON.stringify(x)).join(', ')}]`;
  if (rw.length) lines.push(`read_write = ${list(rw)}`);
  if (ro.length) lines.push(`read_only = ${list(ro)}`);
  if (deny.length) lines.push(`deny = ${list(deny)}`);
  const body = lines.join('\n');
  const name = `archon-${createHash('sha256').update(body).digest('hex').slice(0, 12)}`;
  return { name, toml: `[profiles.${name}]\n${body}\n` };
}

/** Add a profile section to sandbox.toml text unless it is already there. */
export function withGrokProfile(existing: string, profile: GrokSandboxProfile): string {
  if (existing.includes(`[profiles.${profile.name}]`)) return existing;
  const sep =
    existing.length === 0 || existing.endsWith('\n\n')
      ? ''
      : existing.endsWith('\n')
        ? '\n'
        : '\n\n';
  return `${existing}${sep}# Added by Archon for a workflow node's sandbox settings.\n${profile.toml}`;
}

export function readTextOr(path: string, fallback: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return fallback;
  }
}
