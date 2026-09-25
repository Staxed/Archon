-- Harness session id on token usage rows
-- Version: 22.0
-- Description: Records the provider's own session id (Claude session, Codex
--   thread, Grok session) on each usage row, so a collector reading the
--   harness's session files can skip the ones Archon already counted.

ALTER TABLE remote_agent_token_usage ADD COLUMN IF NOT EXISTS session_id VARCHAR(255);

COMMENT ON COLUMN remote_agent_token_usage.session_id IS
  'The provider''s own session id for this usage (Claude session, Codex thread, Grok session); NULL when the provider reported none.';
