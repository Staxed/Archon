import { mock, describe, test, expect, beforeEach } from 'bun:test';
import { createQueryResult, mockPostgresDialect } from '../test/mocks/database';
import type { TokenUsageRow, TokenUsageSummaryRow } from './token-usage';

const mockQuery = mock(() => Promise.resolve(createQueryResult([])));

// Mock the connection module before importing the module under test
mock.module('./connection', () => ({
  pool: {
    query: mockQuery,
  },
  getDialect: () => mockPostgresDialect,
}));

import { recordTokenUsage, getTokenUsageByRun, getTokenUsageSummary } from './token-usage';

describe('token-usage', () => {
  beforeEach(() => {
    mockQuery.mockClear();
  });

  const mockRow: TokenUsageRow = {
    id: 'tu-123',
    workflow_run_id: 'run-456',
    conversation_id: 'conv-789',
    node_id: 'classify',
    provider: 'openrouter',
    model: 'anthropic/claude-3-haiku',
    input_tokens: 500,
    output_tokens: 200,
    total_tokens: 700,
    cost_usd: 0.001,
    created_at: '2026-04-12T00:00:00.000Z',
  };

  describe('recordTokenUsage', () => {
    test('inserts a row with all fields', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([mockRow]));

      const result = await recordTokenUsage({
        workflow_run_id: 'run-456',
        conversation_id: 'conv-789',
        node_id: 'classify',
        provider: 'openrouter',
        model: 'anthropic/claude-3-haiku',
        input_tokens: 500,
        output_tokens: 200,
        total_tokens: 700,
        cost_usd: 0.001,
      });

      expect(result).toEqual(mockRow);
      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('INSERT INTO remote_agent_token_usage');
      expect(params[3]).toBe('classify'); // node_id
      expect(params[4]).toBe('openrouter'); // provider
      expect(params[5]).toBe('anthropic/claude-3-haiku'); // model
      expect(params[6]).toBe(500); // input_tokens
      expect(params[7]).toBe(200); // output_tokens
      expect(params[8]).toBe(700); // total_tokens
      expect(params[9]).toBe(0.001); // cost_usd
    });

    test('defaults nullable fields to null', async () => {
      const minRow: TokenUsageRow = {
        ...mockRow,
        workflow_run_id: null,
        conversation_id: null,
        node_id: null,
        cost_usd: null,
      };
      mockQuery.mockResolvedValueOnce(createQueryResult([minRow]));

      await recordTokenUsage({
        provider: 'llamacpp',
        model: 'local',
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
      });

      const params = mockQuery.mock.calls[0]?.[1] as unknown[];
      expect(params[1]).toBeNull(); // workflow_run_id
      expect(params[2]).toBeNull(); // conversation_id
      expect(params[3]).toBeNull(); // node_id
      expect(params[9]).toBeNull(); // cost_usd
    });

    test('throws when INSERT returns no rows', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await expect(
        recordTokenUsage({
          provider: 'claude',
          model: 'sonnet',
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
        })
      ).rejects.toThrow('Failed to persist token usage: INSERT returned no rows');
    });
  });

  describe('getTokenUsageByRun', () => {
    test('returns all records for a workflow run', async () => {
      const rows = [mockRow, { ...mockRow, id: 'tu-124', node_id: 'implement' }];
      mockQuery.mockResolvedValueOnce(createQueryResult(rows));

      const result = await getTokenUsageByRun('run-456');

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(mockRow);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('WHERE workflow_run_id = $1'),
        ['run-456']
      );
    });

    test('returns empty array when no records found', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      const result = await getTokenUsageByRun('run-nonexistent');

      expect(result).toHaveLength(0);
    });
  });

  describe('getTokenUsageSummary', () => {
    const summaryRow: TokenUsageSummaryRow = {
      provider: 'openrouter',
      model: 'anthropic/claude-3-haiku',
      total_input_tokens: 1000,
      total_output_tokens: 400,
      total_tokens: 1400,
      total_cost_usd: 0.002,
      record_count: 2,
    };

    test('returns summary without filters', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([summaryRow]));

      const result = await getTokenUsageSummary();

      expect(result).toEqual([summaryRow]);
      const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('GROUP BY provider, model');
      expect(sql).not.toContain('WHERE');
      expect(params).toEqual([]);
    });

    test('filters by provider', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([summaryRow]));

      await getTokenUsageSummary({ provider: 'openrouter' });

      const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('WHERE provider = $1');
      expect(params).toEqual(['openrouter']);
    });

    test('filters by model', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([summaryRow]));

      await getTokenUsageSummary({ model: 'anthropic/claude-3-haiku' });

      const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('WHERE model = $1');
      expect(params).toEqual(['anthropic/claude-3-haiku']);
    });

    test('filters by date range', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await getTokenUsageSummary({
        from: '2026-04-01T00:00:00Z',
        to: '2026-04-30T00:00:00Z',
      });

      const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('WHERE created_at >= $1 AND created_at < $2');
      expect(params).toEqual(['2026-04-01T00:00:00Z', '2026-04-30T00:00:00Z']);
    });

    test('combines multiple filters', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await getTokenUsageSummary({
        provider: 'llamacpp',
        model: 'local',
        from: '2026-04-01T00:00:00Z',
      });

      const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('WHERE provider = $1 AND model = $2 AND created_at >= $3');
      expect(params).toEqual(['llamacpp', 'local', '2026-04-01T00:00:00Z']);
    });
  });
});
