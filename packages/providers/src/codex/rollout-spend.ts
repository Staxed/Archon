/**
 * maxBudgetUsd for Codex: the CLI has no spend cap and the SDK's events carry no
 * per-call usage, but Codex appends a `token_count` record to the thread's
 * rollout file after every model call, plus a `turn_context` record naming the
 * model. Archon prices those mid-turn (API-equivalent rates) and stops the turn
 * once the cap is passed.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { TokenUsage } from '../types';
import {
  modelRates,
  noRatesError,
  priceTokens,
  type PricedTokens,
} from '../shared/subscription-options';

/**
 * The thread's rollout file: $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<thread id>.jsonl
 * (dated by local time when the thread started). Only the two most recent day
 * folders are searched. Never throws.
 */
export function findRolloutFile(threadId: string, codexHome: string): string | undefined {
  const sessions = join(codexHome, 'sessions');
  try {
    const days: string[] = [];
    const newest = (dir: string): string[] =>
      readdirSync(dir)
        .filter(n => /^\d+$/.test(n))
        .sort()
        .reverse();
    outer: for (const y of newest(sessions)) {
      for (const m of newest(join(sessions, y))) {
        for (const d of newest(join(sessions, y, m))) {
          days.push(join(sessions, y, m, d));
          if (days.length >= 2) break outer;
        }
      }
    }
    for (const day of days) {
      const file = readdirSync(day).find(n => n.endsWith(`-${threadId}.jsonl`));
      if (file) return join(day, file);
    }
  } catch {
    // no sessions folder yet
  }
  return undefined;
}

/**
 * Spend of one Codex turn so far, read from the rollout. Only the bytes appended
 * since the turn started are read, so a resumed thread's earlier turns are not
 * counted again. `last_token_usage` is OpenAI-shaped: cached tokens are inside
 * input_tokens.
 */
export class RolloutSpend {
  readonly tokens: PricedTokens = { uncached: 0, cached: 0, output: 0 };
  model: string | undefined;
  private file: string | undefined;
  private offset: number | undefined;
  private partial = '';

  constructor(
    private readonly configuredModel: string | undefined,
    private readonly codexHome: string
  ) {
    this.model = configuredModel;
  }

  /** Remember where the thread's rollout ends before the turn (resumed threads). */
  markStart(threadId: string | null | undefined): void {
    if (!threadId || this.offset !== undefined) return;
    const file = findRolloutFile(threadId, this.codexHome);
    if (!file) return;
    try {
      this.offset = statSync(file).size;
      this.file = file;
    } catch {
      // not there yet: a new thread, read from the start
    }
  }

  /** Read what the rollout gained since the last poll. Never throws. */
  poll(threadId: string | null | undefined): void {
    if (!threadId) return;
    this.file ??= findRolloutFile(threadId, this.codexHome);
    if (!this.file) return;
    let text: string;
    try {
      const buf = readFileSync(this.file);
      const from = this.offset ?? 0;
      if (buf.length <= from) return;
      text = this.partial + buf.subarray(from).toString('utf8');
      this.offset = buf.length;
    } catch {
      return;
    }
    const lines = text.split('\n');
    this.partial = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.includes('"token_count"') && !line.includes('"turn_context"')) continue;
      try {
        const rec = JSON.parse(line) as {
          type?: string;
          payload?: {
            type?: string;
            model?: unknown;
            info?: {
              last_token_usage?: {
                input_tokens?: number;
                cached_input_tokens?: number;
                output_tokens?: number;
              };
            } | null;
          };
        };
        if (rec.type === 'turn_context' && typeof rec.payload?.model === 'string') {
          this.model = rec.payload.model;
        } else if (rec.payload?.type === 'token_count' && rec.payload.info?.last_token_usage) {
          const u = rec.payload.info.last_token_usage;
          const cached = u.cached_input_tokens ?? 0;
          this.tokens.uncached += Math.max((u.input_tokens ?? 0) - cached, 0);
          this.tokens.cached += cached;
          this.tokens.output += u.output_tokens ?? 0;
        }
      } catch {
        // skip a malformed line
      }
    }
  }

  /**
   * Whether the spend so far passes `budget`. Nothing is priced before the first
   * model call lands (the rollout names the model in the same turn), so an unset
   * `model` resolves to Codex's real default before it matters.
   */
  exceeds(budget: number): boolean {
    const t = this.tokens;
    if (t.uncached + t.cached + t.output === 0) return false;
    return this.cost() > budget;
  }

  /** Cost so far; throws when the model has no price. */
  cost(): number {
    const model = this.model ?? this.configuredModel;
    const rates = modelRates(model);
    if (!rates) throw noRatesError('Codex', model);
    return priceTokens(rates, this.tokens);
  }

  /** Usage so far in Archon's shape (gross input, cache reads reported separately). */
  usage(): TokenUsage {
    return {
      input: this.tokens.uncached + this.tokens.cached,
      output: this.tokens.output,
      cacheRead: this.tokens.cached,
    };
  }
}
