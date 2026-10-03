import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_DATABASE_URL_ENV,
  CLAUDE_BASH_ENV_SCRIPT,
  SCRUBBED_DATABASE_URL,
  claudeBashEnv,
  claudeBashEnvFile,
  dropServerSecretCopies,
  scrubServerEnv,
  scrubbedKeysIn,
} from './agent-env';

/** The deployment's real container env names (archon-app-1, 2026-10-03), fake values. */
const SERVER = {
  AGENT_BROWSER_EXECUTABLE_PATH: '/usr/bin/chromium',
  ARCHON_DOCKER: 'true',
  ARCHON_DOCKER_HOME: '/home/staxed/.archon',
  ARCHON_LLM_GATEWAY_URL: 'http://host.docker.internal:8093',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token-value-123',
  CLAUDE_USE_GLOBAL_AUTH: 'false',
  DATABASE_URL: 'postgresql://postgres:pw-value-123@archon-postgres:5432/remote_coding_agent',
  GH_TOKEN: 'gh-token-value-123',
  GITHUB_TOKEN: 'gh-token-value-123',
  GITHUB_ALLOWED_USERS: 'staxed',
  HOME: '/home/bun',
  PATH: '/usr/local/bin:/usr/bin:/bin',
  POSTGRES_PASSWORD: 'pw-value-123',
  TELEGRAM_ALLOWED_USER_IDS: '1',
  TELEGRAM_BOT_TOKEN: 'telegram-token-value-123',
  WEBHOOK_SECRET: 'webhook-secret-value-123',
};

describe('scrubServerEnv: what agents lose', () => {
  test('server-only secrets are gone for every CLI', () => {
    for (const cli of ['claude', 'codex', 'grok'] as const) {
      const env = scrubServerEnv(SERVER, cli);
      expect(env.POSTGRES_PASSWORD).toBeUndefined();
      expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
      expect(env.WEBHOOK_SECRET).toBeUndefined();
      expect(Object.values(env)).not.toContain(SERVER.DATABASE_URL);
    }
  });

  test('DATABASE_URL becomes an address that cannot connect (never unset: no SQLite fallback)', () => {
    const env = scrubServerEnv(SERVER, 'codex');
    expect(env.DATABASE_URL).toBe(SCRUBBED_DATABASE_URL);
    expect(new URL(env.DATABASE_URL).hostname.endsWith('.invalid')).toBe(true);
  });

  test('DATABASE_URL becomes the operator-set agent URL when there is one', () => {
    const env = scrubServerEnv(
      { ...SERVER, [AGENT_DATABASE_URL_ENV]: 'postgresql://archon_ro@archon-postgres/x' },
      'claude'
    );
    expect(env.DATABASE_URL).toBe('postgresql://archon_ro@archon-postgres/x');
    expect(env[AGENT_DATABASE_URL_ENV]).toBeUndefined();
  });

  test('no DATABASE_URL on the server: none is invented', () => {
    const { DATABASE_URL: _drop, ...rest } = SERVER;
    expect(scrubServerEnv(rest, 'claude').DATABASE_URL).toBeUndefined();
  });

  test('the Claude login leaves Codex and Grok, stays for the Claude CLI', () => {
    expect(scrubServerEnv(SERVER, 'codex').CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(scrubServerEnv(SERVER, 'grok').CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(scrubServerEnv(SERVER, 'claude').CLAUDE_CODE_OAUTH_TOKEN).toBe(
      SERVER.CLAUDE_CODE_OAUTH_TOKEN
    );
  });

  test('names for the log, never values', () => {
    const names = scrubbedKeysIn(SERVER, 'grok');
    expect(names).toEqual(
      expect.arrayContaining([
        'DATABASE_URL',
        'POSTGRES_PASSWORD',
        'TELEGRAM_BOT_TOKEN',
        'WEBHOOK_SECRET',
        'CLAUDE_CODE_OAUTH_TOKEN',
      ])
    );
    expect(names.join(' ')).not.toContain('value-123');
  });
});

describe('scrubServerEnv: what agents keep (normal work)', () => {
  test('gh and git push keep their token (PR and issue workflows run them in agent nodes)', () => {
    for (const cli of ['claude', 'codex', 'grok'] as const) {
      const env = scrubServerEnv(SERVER, cli);
      expect(env.GH_TOKEN).toBe(SERVER.GH_TOKEN);
      expect(env.GITHUB_TOKEN).toBe(SERVER.GITHUB_TOKEN);
    }
  });

  test('ordinary variables pass unchanged', () => {
    const env = scrubServerEnv(SERVER, 'codex');
    for (const k of [
      'PATH',
      'HOME',
      'ARCHON_DOCKER',
      'ARCHON_DOCKER_HOME',
      'ARCHON_LLM_GATEWAY_URL',
      'AGENT_BROWSER_EXECUTABLE_PATH',
      'GITHUB_ALLOWED_USERS',
      'TELEGRAM_ALLOWED_USER_IDS',
    ] as const) {
      expect(env[k]).toBe(SERVER[k]);
    }
  });
});

describe('dropServerSecretCopies: the project layer', () => {
  test("a project's own DATABASE_URL and secrets pass", () => {
    const project = {
      DATABASE_URL: 'postgresql://app@localhost:5432/app',
      STRIPE_TEST_KEY: 'x',
    };
    expect(dropServerSecretCopies(project, SERVER, 'codex')).toEqual(project);
  });

  test("a copy of the server's value comes out under any name", () => {
    const out = dropServerSecretCopies(
      { MY_DB: SERVER.DATABASE_URL, BOT: SERVER.TELEGRAM_BOT_TOKEN, FOO: 'bar' },
      SERVER,
      'claude'
    );
    expect(out).toEqual({ FOO: 'bar' });
  });

  test('the GitHub token delivered by Archon in the request layer stays', () => {
    const out = dropServerSecretCopies({ GH_TOKEN: SERVER.GH_TOKEN }, SERVER, 'codex');
    expect(out).toEqual({ GH_TOKEN: SERVER.GH_TOKEN });
  });

  test('a managed Claude login stays for Claude', () => {
    const out = dropServerSecretCopies(
      { CLAUDE_CODE_OAUTH_TOKEN: SERVER.CLAUDE_CODE_OAUTH_TOKEN },
      SERVER,
      'claude'
    );
    expect(out?.CLAUDE_CODE_OAUTH_TOKEN).toBe(SERVER.CLAUDE_CODE_OAUTH_TOKEN);
  });

  test('undefined stays undefined', () => {
    expect(dropServerSecretCopies(undefined, SERVER, 'grok')).toBeUndefined();
  });
});

describe('Claude Bash env', () => {
  test('CLAUDE_ENV_FILE unsets the login in every Bash command', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-env-test-'));
    const path = claudeBashEnvFile(dir);
    expect(readFileSync(path, 'utf8')).toBe(CLAUDE_BASH_ENV_SCRIPT);
    expect(CLAUDE_BASH_ENV_SCRIPT).toContain('unset CLAUDE_CODE_OAUTH_TOKEN');
    expect(statSync(path).mode & 0o077).toBe(0);
    expect(claudeBashEnvFile(dir)).toBe(path); // idempotent
  });

  test('the script really removes the token from a shell that sources it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-env-test-'));
    const path = claudeBashEnvFile(dir);
    const r = Bun.spawnSync(
      ['bash', '-c', `. "${path}"; printf '%s|%s' "\${CLAUDE_CODE_OAUTH_TOKEN-unset}" "$KEEP"`],
      { env: { PATH: '/usr/bin:/bin', CLAUDE_CODE_OAUTH_TOKEN: 'tok', KEEP: 'kept' } }
    );
    expect(r.stdout.toString()).toBe('unset|kept');
  });

  test('claudeBashEnv is the CLI env without the login (what the judge is told)', () => {
    const env = claudeBashEnv({ ...scrubServerEnv(SERVER, 'claude'), CLAUDE_ENV_FILE: '/x' });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_ENV_FILE).toBeUndefined();
    expect(env.GH_TOKEN).toBe(SERVER.GH_TOKEN);
  });
});
