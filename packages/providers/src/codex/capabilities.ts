import type { ProviderCapabilities } from '../types';

export const CODEX_CAPABILITIES: ProviderCapabilities = {
  sessionResume: true,
  sessionFork: false,
  mcp: true,
  // hooks, allowed/denied tools: Archon's CLI hook dispatcher
  // (shared/cli-hooks), installed in $CODEX_HOME/hooks.json and trusted per run.
  hooks: true,
  // Codex has no per-node skill list: a node's `skills:` are preloaded into
  // developer_instructions (as Claude preloads them); the automatic catalog stays
  // suppressed for workflow nodes.
  skills: true,
  agents: false,
  toolRestrictions: true,
  structuredOutput: 'enforced', // SDK outputSchema grammar-constrains decoding
  requiresAllPropertiesRequired: true, // OpenAI strict-mode: every key in properties must appear in required
  envInjection: true,
  costControl: true, // Archon prices the rollout's per-call token counts and stops the turn
  costReporting: false, // turn usage carries token axes only
  tokenReporting: true,
  stopReasonReporting: false,
  turnCountReporting: false,
  resolvedModelReporting: true, // the rollout's turn_context names the model that served the turn
  // Codex reads the node-level `effort:` field like every other effort-capable
  // provider and translates it to the SDK's `modelReasoningEffort` internally
  // (#2556). Before that it was `false` — which was read as "Codex cannot do
  // reasoning depth" rather than the truth, "Codex spells it differently".
  effortControl: true,
  fallbackModel: true, // Archon retries once on a model-access error
  sandbox: true, // sandbox_mode workspace-write + writable roots + network on/off
  settingSources: false, // Claude Agent SDK-only knob (which setting sources the agent loads)
  nativeTools: false,
  containerExec: false, // no in-container spawn path yet (fail-fast source of truth)
};
