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
 * OAuth bearer to another host. So are the switches that move Claude Code onto a
 * cloud provider (Bedrock, Vertex, Foundry) and those clouds' credentials.
 *
 * Beyond the named list, any `*_API_KEY` name is stripped: nothing these CLIs or
 * Archon's workflows need is passed that way (the deployment holds no provider
 * keys; the LLM gateway does), so there is no allowlist.
 */

/** Env vars no subscription CLI subprocess may see (exact names). */
export const SUBSCRIPTION_STRIPPED_ENV_KEYS: readonly string[] = [
  // Anthropic (Claude Code)
  'ANTHROPIC_API_KEY',
  'CLAUDE_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  // Claude Code on a cloud provider instead of the subscription
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
  'AWS_BEARER_TOKEN_BEDROCK',
  'GOOGLE_APPLICATION_CREDENTIALS',
  // OpenAI (Codex)
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'OPENAI_BASE_URL',
  'AZURE_OPENAI_API_KEY',
  // xAI (Grok)
  'XAI_API_KEY',
  'GROK_API_KEY',
  'XAI_BASE_URL',
  // Other vendors (also caught by the *_API_KEY rule; named so the list reads whole)
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'DEEPSEEK_API_KEY',
  'TOGETHER_API_KEY',
  'FIREWORKS_API_KEY',
  'PERPLEXITY_API_KEY',
  'HF_TOKEN',
];

/** Name patterns no subscription CLI subprocess may see. */
export const SUBSCRIPTION_STRIPPED_ENV_PATTERNS: readonly RegExp[] = [
  /_API_KEY$/,
  /^ANTHROPIC_VERTEX_/,
  /^ANTHROPIC_FOUNDRY_/,
  /^AZURE_.*KEY$/,
];

const STRIPPED = new Set(SUBSCRIPTION_STRIPPED_ENV_KEYS);

/** True when `key` must never reach a subscription CLI subprocess. */
export function isStrippedSubscriptionEnvKey(key: string): boolean {
  return STRIPPED.has(key) || SUBSCRIPTION_STRIPPED_ENV_PATTERNS.some(re => re.test(key));
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
      if (value === undefined || isStrippedSubscriptionEnvKey(key)) continue;
      env[key] = value;
    }
  }
  return env;
}

/** The names in `env` that would have been stripped (for logging, never values). */
export function strippedKeysIn(env: Record<string, string | undefined> | undefined): string[] {
  if (!env) return [];
  return Object.keys(env).filter(
    key => isStrippedSubscriptionEnvKey(key) && env[key] !== undefined
  );
}
