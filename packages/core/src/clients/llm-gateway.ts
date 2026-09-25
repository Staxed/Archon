/**
 * The Dashed LLM gateway (`llm-metrics`, port 8093) — where every model call
 * Archon makes over HTTP goes, so its usage and cost are recorded.
 *
 * Archon runs inside the `archon` sandbox, where loopback is blocked and direct
 * provider hosts are not on the egress allowlist, so the gateway is also the only
 * route out. It serves local llama.cpp on `/v1/*` and OpenAI-compatible providers
 * on `/<provider>/v1/*`, and holds the provider API keys itself: a client needs
 * no key, and one it does send is harmless (the gateway substitutes its own).
 *
 * Override the gateway with LLM_GATEWAY_URL, or one provider with its own
 * variable (OPENROUTER_BASE_URL, LLAMACPP_ENDPOINT).
 * Read at call time, not import time, so tests and config reloads see changes.
 */

const DEFAULT_GATEWAY_URL = 'http://host.docker.internal:8093';

/** Identifies Archon's calls in the gateway's per-project usage. */
export const GATEWAY_CALLER_HEADERS: Readonly<Record<string, string>> = { 'X-Caller': 'archon' };

/** Gateway root without a trailing slash; its bare `/v1/*` is local llama.cpp. */
export function llmGatewayUrl(): string {
  return (process.env.LLM_GATEWAY_URL ?? DEFAULT_GATEWAY_URL).replace(/\/+$/, '');
}

/**
 * OpenAI-compatible base URL (ending in `/v1`) for a provider behind the gateway.
 * Only OpenRouter: Codex and Grok run on the user's subscriptions and never use
 * the gateway (Codex's old OpenAI API tool loop is gone).
 */
export function gatewayProviderBase(provider: 'openrouter'): string {
  return `${llmGatewayUrl()}/${provider}/v1`;
}

/** True when a base URL points straight at a provider rather than a gateway, so a key is needed. */
export function isDirectProviderUrl(url: string): boolean {
  return url.startsWith('https://openrouter.ai/');
}
