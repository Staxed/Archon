import type { ProviderCapabilities } from '../../types';

/**
 * Grok CLI capabilities — each flag is wired end-to-end in `provider.ts` on the
 * user's SuperGrok subscription login (never an API key). Flags flipped to `true`
 * suppress the dag-executor's per-capability warning, so keep each one honest.
 */
export const GROK_CAPABILITIES: ProviderCapabilities = {
  sessionResume: true, // --resume <session id>
  mcp: true, // mcpServers in a per-run agent definition (--agent)
  hooks: true, // Archon's CLI hook dispatcher (shared/cli-hooks)
  skills: true, // preloaded through --rules
  agents: false,
  toolRestrictions: true, // --tools / --disallowed-tools, and again in the hook dispatcher
  structuredOutput: 'enforced', // --json-schema
  requiresAllPropertiesRequired: false,
  envInjection: true,
  costControl: true, // Archon prices the stream's per-call usage lines and stops
  costReporting: true, // Grok's own total_cost_usd(_ticks), else the session usage.json
  tokenReporting: true,
  stopReasonReporting: true,
  turnCountReporting: true,
  resolvedModelReporting: true, // modelUsage on the end event
  effortControl: true, // --effort
  fallbackModel: true, // Archon retries once on a model error
  sandbox: true, // a custom profile in $GROK_HOME/sandbox.toml (--sandbox)
  settingSources: false,
  nativeTools: false,
  containerExec: false,
};
