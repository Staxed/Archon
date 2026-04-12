-- Message history columns for stateless provider replay + token usage tracking
-- Version: 21.0
-- Description: Adds kind/summarized/summary_of columns to messages table for
--   context-window summarization, and creates token_usage table for per-node cost tracking.

-- New columns on remote_agent_messages for stateless-provider replay
ALTER TABLE remote_agent_messages ADD COLUMN IF NOT EXISTS kind VARCHAR(32) NOT NULL DEFAULT 'text';
ALTER TABLE remote_agent_messages ADD COLUMN IF NOT EXISTS summarized BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE remote_agent_messages ADD COLUMN IF NOT EXISTS summary_of UUID[] NULL;

-- Token usage tracking table
CREATE TABLE IF NOT EXISTS remote_agent_token_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id UUID REFERENCES remote_agent_workflow_runs(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES remote_agent_conversations(id) ON DELETE CASCADE,
  node_id VARCHAR(255),
  provider VARCHAR(32) NOT NULL,
  model VARCHAR(255) NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd NUMERIC(12, 6),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_token_usage_workflow_run
  ON remote_agent_token_usage(workflow_run_id);

CREATE INDEX IF NOT EXISTS idx_token_usage_conversation
  ON remote_agent_token_usage(conversation_id);

CREATE INDEX IF NOT EXISTS idx_token_usage_created_at
  ON remote_agent_token_usage(created_at);

COMMENT ON TABLE remote_agent_token_usage IS
  'Per-node token usage and cost tracking across all providers.';
