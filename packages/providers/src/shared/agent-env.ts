/**
 * Server secrets kept out of what agent tools run with (Claude, Codex, Grok).
 *
 * The Archon server's own environment holds credentials only the server uses:
 * its database URL (the Postgres superuser), the chat adapters' bot tokens, the
 * webhook secrets, the web-auth secrets. Agent CLIs inherit the server env, and
 * every shell command an agent runs inherits the CLI's env, so without this an
 * `env` in a workflow node puts those values in front of a cloud model.
 *
 * Rules (subscription-env.ts still strips vendor API keys on top of this):
 *  - Only the SERVER layer (process.env) is scrubbed. A project's own env
 *    (codebase env vars, per-user credentials, delivered in requestOptions.env)
 *    passes through: a project's own DATABASE_URL is the project's to use. A
 *    request-layer entry that merely copies a scrubbed server value is dropped.
 *  - DATABASE_URL: ARCHON_AGENT_DATABASE_URL (e.g. a read-only role) replaces it
 *    when the operator set one. Otherwise it is REMOVED, with one exception: in
 *    Archon's own repo it becomes an address that can never resolve, because an
 *    unset DATABASE_URL would make an `archon` CLI an agent runs there fall back
 *    to SQLite and migrate ~/.archon/archon.db. Everywhere else it is unset: a
 *    placeholder would beat the project's own .env file (bun's auto-load, the
 *    usual env-file loaders and `node --env-file` never override an existing
 *    variable) and break its tests.
 *  - The forge tokens agents use for `gh` and `git push` over https (GH_TOKEN,
 *    GITHUB_TOKEN, GITLAB_TOKEN, GITEA_TOKEN) are NOT scrubbed: the bundled PR and
 *    issue workflows run `gh pr create`, `gh issue create` and `git push` from
 *    agent nodes. Their scope is governed by github-token-policy.ts.
 *  - CLAUDE_CODE_OAUTH_TOKEN is the Claude CLI's own login: kept in the Claude
 *    CLI's env, unset in its Bash tool (CLAUDE_ENV_FILE, claudeBashEnvFile), and
 *    removed outright from the Codex and Grok CLIs, which never use it.
 *
 * This file imports node built-ins only (the CLI hook dispatcher imports it).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** Server-only secrets no agent tool needs (exact names). */
export const AGENT_SCRUBBED_ENV_KEYS: readonly string[] = [
  // Archon's own database: the superuser password and its compose variable
  'POSTGRES_PASSWORD',
  // Chat and forge adapters: the bots' own tokens and webhook signing secrets
  'TELEGRAM_BOT_TOKEN',
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  'DISCORD_BOT_TOKEN',
  'WEBHOOK_SECRET',
  'GITEA_WEBHOOK_SECRET',
  'GITLAB_WEBHOOK_SECRET',
  // GitHub App mode: the App's private key mints installation tokens
  'GITHUB_APP_PRIVATE_KEY',
  // Web auth and the credential store
  'BETTER_AUTH_SECRET',
  'COOKIE_SECRET',
  'AUTH_PASSWORD_HASH',
  'CADDY_BASIC_AUTH',
  'TOKEN_ENCRYPTION_KEY',
  // Codex login material setup-auth.ts turns into auth.json at container start;
  // the Codex CLI reads auth.json, never these
  'CODEX_ID_TOKEN',
  'CODEX_ACCESS_TOKEN',
  'CODEX_REFRESH_TOKEN',
];

/** The Claude CLI's own login: kept for Claude's CLI, never for its tools or other CLIs. */
export const CLAUDE_LOGIN_ENV_KEYS: readonly string[] = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
];

/** Operator-set replacement for DATABASE_URL in agent envs (e.g. a read-only role). */
export const AGENT_DATABASE_URL_ENV = 'ARCHON_AGENT_DATABASE_URL';

/** What DATABASE_URL becomes in Archon's own repo when no replacement is set: fails to connect, never SQLite. */
export const SCRUBBED_DATABASE_URL =
  'postgresql://removed-by-archon@database-url-not-available-to-agents.invalid:5432/none';

export type AgentCli = 'claude' | 'codex' | 'grok';

type Env = Record<string, string | undefined>;

/**
 * True when `cwd` is inside Archon's own repo (a package.json named "archon"
 * at or above it): the one place an `archon` CLI could fall back to SQLite.
 */
export function isArchonRepo(cwd: string | undefined): boolean {
  if (!cwd) return false;
  let dir = resolve(cwd);
  for (let i = 0; i < 40; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown };
      if (pkg.name === 'archon') return true;
    } catch {
      // no package.json here, or unreadable: keep climbing
    }
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
  return false;
}

/** Names scrubbed for `cli` (DATABASE_URL is handled separately: replaced, not dropped). */
function scrubbedNames(cli: AgentCli): Set<string> {
  const names = new Set(AGENT_SCRUBBED_ENV_KEYS);
  names.add(AGENT_DATABASE_URL_ENV);
  if (cli !== 'claude') for (const k of CLAUDE_LOGIN_ENV_KEYS) names.add(k);
  return names;
}

/**
 * The server env with every server-only secret removed, for an agent CLI.
 * `server` is the inherited layer (normally process.env); `cwd` is the node's
 * working directory (decides what DATABASE_URL becomes, see the header).
 */
export function scrubServerEnv(server: Env, cli: AgentCli, cwd?: string): Record<string, string> {
  const names = scrubbedNames(cli);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(server)) {
    if (value === undefined || names.has(key) || key === 'DATABASE_URL') continue;
    out[key] = value;
  }
  if (server.DATABASE_URL !== undefined) {
    const replacement = server[AGENT_DATABASE_URL_ENV];
    if (replacement) out.DATABASE_URL = replacement;
    else if (isArchonRepo(cwd)) out.DATABASE_URL = SCRUBBED_DATABASE_URL;
  }
  return out;
}

/**
 * A request-layer env (project env, per-user creds) with any entry removed that
 * carries one of the server's scrubbed values under any name, so a server secret
 * copied into a project's env does not come back. Everything else passes.
 */
export function dropServerSecretCopies(
  request: Record<string, string> | undefined,
  server: Env,
  cli: AgentCli
): Record<string, string> | undefined {
  if (!request) return request;
  const names = scrubbedNames(cli);
  // A project's own DATABASE_URL is legitimate unless it IS the server's.
  names.add('DATABASE_URL');
  const secrets = new Set<string>();
  for (const name of names) {
    const v = server[name];
    if (v && v.length >= 8) secrets.add(v);
  }
  if (secrets.size === 0) return request;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(request)) {
    if (secrets.has(value)) continue;
    out[key] = value;
  }
  return out;
}

/** Names `scrubServerEnv` removed or replaced (for logging; never values). */
export function scrubbedKeysIn(server: Env, cli: AgentCli): string[] {
  const names = scrubbedNames(cli);
  names.add('DATABASE_URL');
  return Object.keys(server).filter(k => names.has(k) && server[k] !== undefined);
}

/** Shell lines the Claude CLI sources before every Bash command (CLAUDE_ENV_FILE). */
export const CLAUDE_BASH_ENV_SCRIPT = `${CLAUDE_LOGIN_ENV_KEYS.map(k => `unset ${k}`).join('\n')}\n`;

/**
 * Path of the script Claude Code sources before each Bash command, written
 * once per process. Claude Code reads CLAUDE_ENV_FILE from its own environment
 * and prepends the file to every Bash tool command, so the login stays in the
 * CLI (which needs it) and is gone from every shell the agent runs.
 */
export function claudeBashEnvFile(dir: string = join(tmpdir(), 'archon-agent-env')): string {
  const path = join(dir, 'claude-bash-env.sh');
  try {
    if (readFileSync(path, 'utf8') === CLAUDE_BASH_ENV_SCRIPT) return path;
  } catch {
    // missing: write it
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, CLAUDE_BASH_ENV_SCRIPT, { mode: 0o600 });
  return path;
}

/** The env a Claude Bash command runs with, given the Claude CLI's env. */
export function claudeBashEnv(cliEnv: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(cliEnv)) {
    if (v === undefined || CLAUDE_LOGIN_ENV_KEYS.includes(k) || k === 'CLAUDE_ENV_FILE') continue;
    out[k] = v;
  }
  return out;
}
