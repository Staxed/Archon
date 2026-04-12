/**
 * Database operations for conversation messages (Web UI history)
 *
 * Supports both legacy (user/assistant) and extended message types
 * for stateless-provider replay (system, tool, summary).
 */
import { pool, getDialect } from './connection';
import { createLogger } from '@archon/paths';
import type { ChatMessage, ToolCall } from '../clients/tool-loop';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.messages');
  return cachedLog;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  metadata: string; // JSON string - parsed by frontend
  kind: 'text' | 'tool_call' | 'tool_result' | 'summary';
  summarized: boolean;
  summary_of: string | null; // JSON array of UUIDs (TEXT in SQLite, UUID[] in PostgreSQL)
  created_at: string;
}

/** Extended options for addMessage to support all message types. */
export interface AddMessageOptions {
  /** Message kind. Default: inferred from role and metadata. */
  kind?: MessageRow['kind'];
  /** Tool call ID, required when role is 'tool'. */
  toolCallId?: string;
  /** Tool name, required when role is 'tool'. */
  toolName?: string;
  /** Tool calls array for assistant messages that invoke tools. */
  toolCalls?: ToolCall[];
  /** Mark as a summary message with references to summarized message IDs. */
  summaryOf?: string[];
}

/**
 * Add a message to conversation history.
 *
 * Supports all OpenAI chat/completions roles:
 *   - user: Standard user message
 *   - assistant: Model response (optionally with tool_calls in metadata)
 *   - system: System prompt or summary injection
 *   - tool: Tool result (requires toolCallId and toolName in options)
 *
 * metadata should contain toolCalls array and/or error object if applicable.
 */
export async function addMessage(
  conversationId: string,
  role: MessageRow['role'],
  content: string,
  metadata?: Record<string, unknown>,
  options?: AddMessageOptions
): Promise<MessageRow> {
  const dialect = getDialect();

  // Build metadata, merging in tool call info when provided
  const mergedMetadata: Record<string, unknown> = { ...(metadata ?? {}) };
  if (options?.toolCallId) mergedMetadata.toolCallId = options.toolCallId;
  if (options?.toolName) mergedMetadata.toolName = options.toolName;
  if (options?.toolCalls) mergedMetadata.toolCalls = options.toolCalls;

  // Infer kind from context when not explicitly set
  const kind = options?.kind ?? inferKind(role, mergedMetadata, options);

  // Build summary_of: serialized as a JSON array string for both backends.
  // SQLite stores it as TEXT; PostgreSQL stores it as TEXT (not UUID[]).
  // Consumers must JSON.parse() the value to get the array of summarized message IDs.
  const summaryOf = options?.summaryOf ? JSON.stringify(options.summaryOf) : null;

  const isSummary = kind === 'summary';

  const result = await pool.query<MessageRow>(
    `INSERT INTO remote_agent_messages (conversation_id, role, content, metadata, kind, summarized, summary_of, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, ${dialect.now()})
     RETURNING *`,
    [
      conversationId,
      role,
      content,
      JSON.stringify(mergedMetadata),
      kind,
      isSummary ? false : false, // summarized starts as false; set to true on summarized rows
      summaryOf,
    ]
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(
      `Failed to persist message: INSERT returned no rows (conversation: ${conversationId})`
    );
  }
  getLog().debug({ conversationId, role, kind, messageId: row.id }, 'db.message_persist_completed');
  return row;
}

/**
 * Infer message kind from role and metadata.
 */
function inferKind(
  role: MessageRow['role'],
  metadata: Record<string, unknown>,
  options?: AddMessageOptions
): MessageRow['kind'] {
  if (options?.summaryOf && options.summaryOf.length > 0) return 'summary';
  if (role === 'tool') return 'tool_result';
  if (role === 'assistant' && metadata.toolCalls) return 'tool_call';
  return 'text';
}

/**
 * Mark messages as summarized (they've been collapsed into a summary).
 */
export async function markMessagesSummarized(messageIds: string[]): Promise<void> {
  if (messageIds.length === 0) return;

  // Build placeholder list: $1, $2, $3, ...
  const placeholders = messageIds.map((_, i) => `$${String(i + 1)}`).join(', ');

  await pool.query(
    `UPDATE remote_agent_messages SET summarized = TRUE WHERE id IN (${placeholders})`,
    messageIds
  );

  getLog().debug({ messageIds, count: messageIds.length }, 'db.messages_marked_summarized');
}

/**
 * List messages for a conversation, oldest first.
 * conversationId is the database UUID (not platform_conversation_id).
 */
export async function listMessages(
  conversationId: string,
  limit = 200
): Promise<readonly MessageRow[]> {
  const result = await pool.query<MessageRow>(
    `SELECT * FROM remote_agent_messages
     WHERE conversation_id = $1
     ORDER BY created_at ASC
     LIMIT $2`,
    [conversationId, limit]
  );
  return result.rows;
}

/**
 * List messages for replay by stateless providers.
 *
 * Returns non-summarized messages plus any summary messages,
 * all ordered by created_at. Summarized original messages are excluded
 * since their content has been collapsed into summary messages.
 */
export async function listMessagesForReplay(
  conversationId: string,
  limit = 1000
): Promise<readonly MessageRow[]> {
  const result = await pool.query<MessageRow>(
    `SELECT * FROM remote_agent_messages
     WHERE conversation_id = $1
       AND (summarized = FALSE OR kind = 'summary')
     ORDER BY created_at ASC
     LIMIT $2`,
    [conversationId, limit]
  );
  return result.rows;
}

/**
 * Build an OpenAI-format messages array from persisted MessageRows.
 *
 * Constructs the replay array for stateless providers:
 *   - system prompt (if provided) at position 0
 *   - summary messages in chronological position
 *   - verbatim user/assistant/tool turns
 *
 * Claude/Codex paths do NOT use this — they manage their own state.
 */
export function buildReplayMessages(
  rows: readonly MessageRow[],
  systemPrompt?: string
): ChatMessage[] {
  const messages: ChatMessage[] = [];

  // Prepend system prompt if provided
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }

  for (const row of rows) {
    const metadata = parseMetadata(row.metadata);

    switch (row.role) {
      case 'system': {
        // System messages (including summaries) are injected as-is
        messages.push({ role: 'system', content: row.content });
        break;
      }
      case 'user': {
        messages.push({ role: 'user', content: row.content });
        break;
      }
      case 'assistant': {
        const msg: ChatMessage = { role: 'assistant', content: row.content };
        // Attach tool_calls if present in metadata
        const toolCalls = metadata.toolCalls as ToolCall[] | undefined;
        if (toolCalls && Array.isArray(toolCalls) && toolCalls.length > 0) {
          msg.tool_calls = toolCalls;
          // OpenAI requires content to be null when tool_calls are present
          if (!row.content) msg.content = null;
        }
        messages.push(msg);
        break;
      }
      case 'tool': {
        const toolCallId = metadata.toolCallId as string | undefined;
        const toolName = metadata.toolName as string | undefined;
        if (!toolCallId) {
          getLog().warn(
            { messageId: row.id, conversationId: row.conversation_id },
            'db.replay_skip_tool_no_id'
          );
          break;
        }
        const msg: ChatMessage = {
          role: 'tool',
          content: row.content,
          tool_call_id: toolCallId,
        };
        if (toolName) msg.name = toolName;
        messages.push(msg);
        break;
      }
    }
  }

  return messages;
}

/**
 * Parse metadata JSON string safely.
 */
function parseMetadata(metadata: string): Record<string, unknown> {
  try {
    return JSON.parse(metadata) as Record<string, unknown>;
  } catch {
    return {};
  }
}
