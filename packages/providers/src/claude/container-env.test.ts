import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { buildRequestSubprocessEnv } from './provider';

/**
 * Env-isolation enforcement point: a container run must receive ONLY the
 * Archon-managed env bag over a minimal base — host `process.env` must NEVER
 * cross into the container. A host run keeps inheriting the host env unchanged.
 */
describe('buildRequestSubprocessEnv — container env isolation', () => {
  const CANARY = 'ARCHON_HOST_CANARY_SECRET';

  beforeEach(() => {
    process.env[CANARY] = 'leaked-host-secret';
  });
  afterEach(() => {
    delete process.env[CANARY];
  });

  test('container run EXCLUDES host process.env (canary absent), keeps managed creds', () => {
    const env = buildRequestSubprocessEnv({
      execContext: { kind: 'container', containerId: 'c1' },
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-managed', CODEBASE_VAR: 'x' },
    });
    expect(env[CANARY]).toBeUndefined(); // host secret did NOT cross the boundary
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-managed'); // managed creds delivered
    expect(env.CODEBASE_VAR).toBe('x');
    expect(env.TERM).toBe('dumb'); // minimal base only
  });

  test('host run INHERITS host process.env (canary present) — unchanged behavior', () => {
    const env = buildRequestSubprocessEnv({ env: { FOO: 'bar' } });
    expect(env[CANARY]).toBe('leaked-host-secret');
    expect(env.FOO).toBe('bar');
  });

  test('container run strips API keys from the managed bag (subscription only)', () => {
    const env = buildRequestSubprocessEnv({
      execContext: { kind: 'container', containerId: 'c1' },
      env: { CLAUDE_API_KEY: 'sk-claude', ANTHROPIC_API_KEY: 'sk-ant', OPENAI_API_KEY: 'sk-o' },
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env[CANARY]).toBeUndefined();
  });

  test('host run strips API keys inherited from the host env', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-host';
    try {
      const env = buildRequestSubprocessEnv({ env: { FOO: 'bar' } });
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.FOO).toBe('bar');
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });
});
