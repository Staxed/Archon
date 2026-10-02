/**
 * Subscription-only credentials for the CLI harnesses (Claude Code, Codex, Grok).
 *
 * These providers run only on the CLI's own OAuth / subscription login
 * (`CLAUDE_CODE_OAUTH_TOKEN` or `~/.claude`, `$CODEX_HOME/auth.json`,
 * `~/.grok/auth.json`). Every CLI prefers an API key over its login when one is
 * in its environment, which would silently bill a run to an API account, so the
 * subprocess environment never carries one. This is the single list for all
 * three harnesses: a key meant for one vendor has no business in another's
 * subprocess either.
 *
 * Base-URL overrides are stripped too: a subscription login is only valid
 * against the vendor's own servers, and a redirected base URL would hand the
 * OAuth bearer to another host.
 */

/** Env vars no subscription CLI subprocess may see. */
export const SUBSCRIPTION_STRIPPED_ENV_KEYS: readonly string[] = [
  // Anthropic (Claude Code)
  'ANTHROPIC_API_KEY',
  'CLAUDE_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  // OpenAI (Codex)
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'OPENAI_BASE_URL',
  // xAI (Grok)
  'XAI_API_KEY',
  'GROK_API_KEY',
  'XAI_BASE_URL',
  // Other vendors' API keys
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
];

const STRIPPED = new Set(SUBSCRIPTION_STRIPPED_ENV_KEYS);

/** True when `key` must never reach a subscription CLI subprocess. */
export function isStrippedSubscriptionEnvKey(key: string): boolean {
  return STRIPPED.has(key);
}

/**
 * Merge env layers (later wins) into a subprocess env with every API-key and
 * base-URL variable removed and `undefined` values dropped.
 */
export function buildSubscriptionEnv(
  ...layers: (Record<string, string | undefined> | undefined)[]
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const [key, value] of Object.entries(layer)) {
      if (value === undefined || STRIPPED.has(key)) continue;
      env[key] = value;
    }
  }
  return env;
}

/** The names in `env` that would have been stripped (for logging, never values). */
export function strippedKeysIn(env: Record<string, string | undefined> | undefined): string[] {
  if (!env) return [];
  return Object.keys(env).filter(key => STRIPPED.has(key) && env[key] !== undefined);
}
