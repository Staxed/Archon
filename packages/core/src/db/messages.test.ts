import { mock, describe, test, expect, beforeEach } from 'bun:test';
import { createQueryResult, mockPostgresDialect } from '../test/mocks/database';
import type { MessageRow } from './messages';

const mockQuery = mock(() => Promise.resolve(createQueryResult([])));

// Mock the connection module before importing the module under test
mock.module('./connection', () => ({
  pool: {
    query: mockQuery,
  },
  getDialect: () => mockPostgresDialect,
}));

import {
  addMessage,
  listMessages,
  listMessagesForReplay,
  markMessagesSummarized,
  buildReplayMessages,
} from './messages';

describe('messages', () => {
  beforeEach(() => {
    mockQuery.mockClear();
  });

  const mockMessage: MessageRow = {
    id: 'msg-123',
    conversation_id: 'conv-456',
    role: 'user',
    content: 'Hello, world!',
    metadata: '{}',
    kind: 'text',
    summarized: false,
    summary_of: null,
    created_at: '2025-01-01T00:00:00.000Z',
  };

  describe('addMessage', () => {
    test('calls pool.query with correct SQL and parameters', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([mockMessage]));

      const result = await addMessage('conv-456', 'user', 'Hello, world!');

      expect(result).toEqual(mockMessage);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO remote_agent_messages'),
        ['conv-456', 'user', 'Hello, world!', '{}', 'text', false, null]
      );
    });

    test('includes metadata as JSON string when provided', async () => {
      const messageWithMetadata: MessageRow = {
        ...mockMessage,
        metadata: '{"toolCalls":[{"name":"read"}],"error":null}',
      };
      mockQuery.mockResolvedValueOnce(createQueryResult([messageWithMetadata]));

      const metadata = { toolCalls: [{ name: 'read' }], error: null };
      const result = await addMessage('conv-456', 'assistant', 'Done.', metadata);

      expect(result).toEqual(messageWithMetadata);
    });

    test('defaults metadata to empty object when not provided', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([mockMessage]));

      await addMessage('conv-456', 'user', 'Hello, world!');

      const params = mockQuery.mock.calls[0]?.[1] as unknown[];
      expect(params[3]).toBe('{}');
    });

    test('throws wrapped error when INSERT returns no rows', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await expect(addMessage('conv-456', 'user', 'Hello')).rejects.toThrow(
        'Failed to persist message: INSERT returned no rows (conversation: conv-456)'
      );
    });

    test('propagates query errors', async () => {
      mockQuery.mockRejectedValueOnce(new Error('connection refused'));

      await expect(addMessage('conv-456', 'user', 'Hello')).rejects.toThrow('connection refused');
    });

    test('handles system role messages', async () => {
      const systemMsg: MessageRow = {
        ...mockMessage,
        role: 'system',
        content: 'You are a helpful assistant.',
        kind: 'text',
      };
      mockQuery.mockResolvedValueOnce(createQueryResult([systemMsg]));

      const result = await addMessage('conv-456', 'system', 'You are a helpful assistant.');

      expect(result.role).toBe('system');
      const params = mockQuery.mock.calls[0]?.[1] as unknown[];
      expect(params[1]).toBe('system');
      expect(params[4]).toBe('text'); // kind inferred as text for system
    });

    test('handles tool role messages with toolCallId', async () => {
      const toolMsg: MessageRow = {
        ...mockMessage,
        role: 'tool',
        content: 'File contents...',
        kind: 'tool_result',
        metadata: '{"toolCallId":"call_123","toolName":"Read"}',
      };
      mockQuery.mockResolvedValueOnce(createQueryResult([toolMsg]));

      const result = await addMessage('conv-456', 'tool', 'File contents...', undefined, {
        toolCallId: 'call_123',
        toolName: 'Read',
      });

      expect(result.role).toBe('tool');
      const params = mockQuery.mock.calls[0]?.[1] as unknown[];
      expect(params[4]).toBe('tool_result'); // kind inferred for tool role
      const meta = JSON.parse(params[3] as string) as Record<string, unknown>;
      expect(meta.toolCallId).toBe('call_123');
      expect(meta.toolName).toBe('Read');
    });

    test('infers tool_call kind for assistant with toolCalls', async () => {
      const toolCallMsg: MessageRow = {
        ...mockMessage,
        role: 'assistant',
        content: '',
        kind: 'tool_call',
      };
      mockQuery.mockResolvedValueOnce(createQueryResult([toolCallMsg]));

      await addMessage('conv-456', 'assistant', '', undefined, {
        toolCalls: [
          { id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{}' } },
        ],
      });

      const params = mockQuery.mock.calls[0]?.[1] as unknown[];
      expect(params[4]).toBe('tool_call');
    });

    test('handles summary messages with summaryOf', async () => {
      const summaryMsg: MessageRow = {
        ...mockMessage,
        role: 'system',
        content: 'Summary of previous conversation...',
        kind: 'summary',
        summary_of: '["msg-1","msg-2","msg-3"]',
      };
      mockQuery.mockResolvedValueOnce(createQueryResult([summaryMsg]));

      await addMessage('conv-456', 'system', 'Summary of previous conversation...', undefined, {
        summaryOf: ['msg-1', 'msg-2', 'msg-3'],
      });

      const params = mockQuery.mock.calls[0]?.[1] as unknown[];
      expect(params[4]).toBe('summary'); // kind inferred from summaryOf
      expect(params[6]).toBe('["msg-1","msg-2","msg-3"]'); // summary_of JSON
    });

    test('allows explicit kind override', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([mockMessage]));

      await addMessage('conv-456', 'assistant', 'result', undefined, { kind: 'tool_call' });

      const params = mockQuery.mock.calls[0]?.[1] as unknown[];
      expect(params[4]).toBe('tool_call');
    });
  });

  describe('markMessagesSummarized', () => {
    test('updates messages with IN clause', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 3));

      await markMessagesSummarized(['msg-1', 'msg-2', 'msg-3']);

      expect(mockQuery).toHaveBeenCalledWith(
        'UPDATE remote_agent_messages SET summarized = TRUE WHERE id IN ($1, $2, $3)',
        ['msg-1', 'msg-2', 'msg-3']
      );
    });

    test('no-ops for empty array', async () => {
      await markMessagesSummarized([]);
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe('listMessages', () => {
    test('returns rows from query result', async () => {
      const messages: MessageRow[] = [
        mockMessage,
        { ...mockMessage, id: 'msg-124', role: 'assistant', content: 'Hi!' },
      ];
      mockQuery.mockResolvedValueOnce(createQueryResult(messages));

      const result = await listMessages('conv-456');

      expect(result).toEqual(messages);
      expect(mockQuery).toHaveBeenCalledWith(
        `SELECT * FROM remote_agent_messages
     WHERE conversation_id = $1
     ORDER BY created_at ASC
     LIMIT $2`,
        ['conv-456', 200]
      );
    });

    test('returns empty array for no results', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      const result = await listMessages('conv-456');

      expect(result).toEqual([]);
    });

    test('respects custom limit parameter', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await listMessages('conv-456', 50);

      expect(mockQuery).toHaveBeenCalledWith(expect.any(String), ['conv-456', 50]);
    });
  });

  describe('listMessagesForReplay', () => {
    test('queries with summarized=FALSE OR kind=summary filter', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await listMessagesForReplay('conv-456');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("summarized = FALSE OR kind = 'summary'"),
        ['conv-456', 1000]
      );
    });

    test('returns non-summarized and summary messages', async () => {
      const rows: MessageRow[] = [
        { ...mockMessage, id: 'msg-1', kind: 'text', summarized: false },
        {
          ...mockMessage,
          id: 'msg-summary',
          role: 'system',
          kind: 'summary',
          summarized: false,
          summary_of: '["msg-old-1","msg-old-2"]',
        },
        { ...mockMessage, id: 'msg-2', kind: 'text', summarized: false },
      ];
      mockQuery.mockResolvedValueOnce(createQueryResult(rows));

      const result = await listMessagesForReplay('conv-456');

      expect(result).toHaveLength(3);
      expect(result[1]?.kind).toBe('summary');
    });

    test('respects custom limit', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await listMessagesForReplay('conv-456', 500);

      expect(mockQuery).toHaveBeenCalledWith(expect.any(String), ['conv-456', 500]);
    });
  });

  describe('buildReplayMessages', () => {
    test('builds messages from empty rows with system prompt', () => {
      const result = buildReplayMessages([], 'You are helpful.');

      expect(result).toEqual([{ role: 'system', content: 'You are helpful.' }]);
    });

    test('builds messages from empty rows without system prompt', () => {
      const result = buildReplayMessages([]);

      expect(result).toEqual([]);
    });

    test('builds user and assistant messages', () => {
      const rows: MessageRow[] = [
        { ...mockMessage, id: 'msg-1', role: 'user', content: 'Hi' },
        { ...mockMessage, id: 'msg-2', role: 'assistant', content: 'Hello!' },
      ];

      const result = buildReplayMessages(rows);

      expect(result).toEqual([
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello!' },
      ]);
    });

    test('builds assistant message with tool_calls from metadata', () => {
      const toolCalls = [
        {
          id: 'call_1',
          type: 'function' as const,
          function: { name: 'Read', arguments: '{"file_path":"/foo"}' },
        },
      ];
      const rows: MessageRow[] = [
        {
          ...mockMessage,
          id: 'msg-1',
          role: 'assistant',
          content: '',
          kind: 'tool_call',
          metadata: JSON.stringify({ toolCalls }),
        },
      ];

      const result = buildReplayMessages(rows);

      expect(result).toHaveLength(1);
      expect(result[0]?.role).toBe('assistant');
      expect(result[0]?.tool_calls).toEqual(toolCalls);
      // Empty content with tool_calls should be null
      expect(result[0]?.content).toBeNull();
    });

    test('builds tool result messages with tool_call_id', () => {
      const rows: MessageRow[] = [
        {
          ...mockMessage,
          id: 'msg-1',
          role: 'tool',
          content: 'file contents',
          kind: 'tool_result',
          metadata: JSON.stringify({ toolCallId: 'call_1', toolName: 'Read' }),
        },
      ];

      const result = buildReplayMessages(rows);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        role: 'tool',
        content: 'file contents',
        tool_call_id: 'call_1',
        name: 'Read',
      });
    });

    test('skips tool messages without toolCallId', () => {
      const rows: MessageRow[] = [
        {
          ...mockMessage,
          id: 'msg-1',
          role: 'tool',
          content: 'orphan result',
          kind: 'tool_result',
          metadata: '{}',
        },
      ];

      const result = buildReplayMessages(rows);

      expect(result).toHaveLength(0);
    });

    test('builds system messages including summaries', () => {
      const rows: MessageRow[] = [
        {
          ...mockMessage,
          id: 'msg-summary',
          role: 'system',
          content: 'Summary: User asked about X...',
          kind: 'summary',
          summary_of: '["msg-1","msg-2"]',
        },
        { ...mockMessage, id: 'msg-3', role: 'user', content: 'Continue' },
      ];

      const result = buildReplayMessages(rows, 'Be helpful');

      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ role: 'system', content: 'Be helpful' });
      expect(result[1]).toEqual({ role: 'system', content: 'Summary: User asked about X...' });
      expect(result[2]).toEqual({ role: 'user', content: 'Continue' });
    });

    test('round-trips tool call metadata through JSONB correctly', () => {
      const toolCalls = [
        {
          id: 'call_abc',
          type: 'function' as const,
          function: {
            name: 'Edit',
            arguments: JSON.stringify({
              file_path: '/src/index.ts',
              old_string: 'foo',
              new_string: 'bar',
            }),
          },
        },
        {
          id: 'call_def',
          type: 'function' as const,
          function: {
            name: 'Bash',
            arguments: JSON.stringify({ command: 'ls -la' }),
          },
        },
      ];

      const rows: MessageRow[] = [
        {
          ...mockMessage,
          id: 'msg-1',
          role: 'assistant',
          content: '',
          kind: 'tool_call',
          metadata: JSON.stringify({ toolCalls }),
        },
        {
          ...mockMessage,
          id: 'msg-2',
          role: 'tool',
          content: 'File edited successfully',
          kind: 'tool_result',
          metadata: JSON.stringify({ toolCallId: 'call_abc', toolName: 'Edit' }),
        },
        {
          ...mockMessage,
          id: 'msg-3',
          role: 'tool',
          content: 'drwxr-xr-x ...',
          kind: 'tool_result',
          metadata: JSON.stringify({ toolCallId: 'call_def', toolName: 'Bash' }),
        },
      ];

      const result = buildReplayMessages(rows);

      expect(result).toHaveLength(3);
      // Assistant with tool calls
      expect(result[0]?.tool_calls).toEqual(toolCalls);
      expect(result[0]?.content).toBeNull();
      // Tool results
      expect(result[1]?.tool_call_id).toBe('call_abc');
      expect(result[1]?.name).toBe('Edit');
      expect(result[2]?.tool_call_id).toBe('call_def');
      expect(result[2]?.name).toBe('Bash');
    });

    test('handles malformed metadata gracefully', () => {
      const rows: MessageRow[] = [
        { ...mockMessage, id: 'msg-1', role: 'user', content: 'Hi', metadata: 'not-json' },
      ];

      const result = buildReplayMessages(rows);

      expect(result).toEqual([{ role: 'user', content: 'Hi' }]);
    });
  });
});
