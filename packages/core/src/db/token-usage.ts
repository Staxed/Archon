/**
 * Database operations for token usage tracking.
 *
 * Records per-node token consumption and cost across all providers.
 * Uses the `remote_agent_token_usage` table created in migration 021.
 */
import { pool, getDialect } from './connection';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.token-usage');
  return cachedLog;
}

export interface TokenUsageRow {
  id: string;
  workflow_run_id: string | null;
  conversation_id: string | null;
  node_id: string | null;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number | null;
  created_at: string;
}

export interface TokenUsageInput {
  workflow_run_id?: string | null;
  conversation_id?: string | null;
  node_id?: string | null;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd?: number | null;
}

export interface TokenUsageSummaryRow {
  provider: string;
  model: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
  total_cost_usd: number | null;
  record_count: number;
}

export interface TokenUsageSummaryFilters {
  provider?: string;
  model?: string;
  /** ISO date string — only include records created on or after this date */
  from?: string;
  /** ISO date string — only include records created before this date */
  to?: string;
}

/**
 * Insert a token usage record.
 */
export async function recordTokenUsage(data: TokenUsageInput): Promise<TokenUsageRow> {
  const dialect = getDialect();
  const id = dialect.generateUuid();

  const result = await pool.query<TokenUsageRow>(
    `INSERT INTO remote_agent_token_usage
       (id, workflow_run_id, conversation_id, node_id, provider, model,
        input_tokens, output_tokens, total_tokens, cost_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      id,
      data.workflow_run_id ?? null,
      data.conversation_id ?? null,
      data.node_id ?? null,
      data.provider,
      data.model,
      data.input_tokens,
      data.output_tokens,
      data.total_tokens,
      data.cost_usd ?? null,
    ]
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error('Failed to persist token usage: INSERT returned no rows');
  }

  getLog().debug(
    {
      id,
      provider: data.provider,
      model: data.model,
      totalTokens: data.total_tokens,
      costUsd: data.cost_usd,
    },
    'token_usage.record_completed'
  );

  return row;
}

/**
 * Get all token usage records for a specific workflow run.
 */
export async function getTokenUsageByRun(runId: string): Promise<TokenUsageRow[]> {
  const result = await pool.query<TokenUsageRow>(
    `SELECT * FROM remote_agent_token_usage
     WHERE workflow_run_id = $1
     ORDER BY created_at ASC`,
    [runId]
  );
  return [...result.rows];
}

/**
 * Get aggregated token usage summary with optional filters.
 */
export async function getTokenUsageSummary(
  filters?: TokenUsageSummaryFilters
): Promise<TokenUsageSummaryRow[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (filters?.provider) {
    conditions.push(`provider = $${String(paramIdx)}`);
    params.push(filters.provider);
    paramIdx++;
  }

  if (filters?.model) {
    conditions.push(`model = $${String(paramIdx)}`);
    params.push(filters.model);
    paramIdx++;
  }

  if (filters?.from) {
    conditions.push(`created_at >= $${String(paramIdx)}`);
    params.push(filters.from);
    paramIdx++;
  }

  if (filters?.to) {
    conditions.push(`created_at < $${String(paramIdx)}`);
    params.push(filters.to);
    paramIdx++;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await pool.query<TokenUsageSummaryRow>(
    `SELECT
       provider,
       model,
       SUM(input_tokens) AS total_input_tokens,
       SUM(output_tokens) AS total_output_tokens,
       SUM(total_tokens) AS total_tokens,
       SUM(cost_usd) AS total_cost_usd,
       COUNT(*) AS record_count
     FROM remote_agent_token_usage
     ${whereClause}
     GROUP BY provider, model
     ORDER BY provider, model`,
    params
  );

  return [...result.rows];
}
