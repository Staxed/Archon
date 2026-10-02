import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PiGatewayPolicyError,
  assertGatewayProviderId,
  buildGatewayModelsPath,
  isGatewayBaseUrl,
  isPiGatewayOnly,
  resolveGatewayUrl,
} from './gateway';

const HOST = 'http://localhost:8093';
const CONTAINER = 'http://host.docker.internal:8093';

describe('gateway policy primitives', () => {
  test('gateway-only defaults to on and explicit config wins', () => {
    expect(isPiGatewayOnly(undefined)).toBe(true);
    expect(isPiGatewayOnly(false)).toBe(false);
  });

  test('refuses built-in vendors and un-prefixed custom providers', () => {
    for (const vendor of ['openrouter', 'xai', 'openai', 'google', 'anthropic', 'mygw']) {
      expect(() => assertGatewayProviderId(vendor)).toThrow(PiGatewayPolicyError);
    }
    expect(() => assertGatewayProviderId('gateway-openrouter')).not.toThrow();
  });

  test('gateway URL comes from the request env and must be set', () => {
    expect(resolveGatewayUrl({ ARCHON_LLM_GATEWAY_URL: `${HOST}/` })).toBe(HOST);
    expect(() => resolveGatewayUrl({ ARCHON_LLM_GATEWAY_URL: '' })).toThrow(/is not set/);
  });

  test('baseUrl must be the gateway root or under it', () => {
    expect(isGatewayBaseUrl(`${HOST}/openrouter/v1`, HOST)).toBe(true);
    expect(isGatewayBaseUrl(`${HOST}/v1`, HOST)).toBe(true);
    expect(isGatewayBaseUrl('https://openrouter.ai/api/v1', HOST)).toBe(false);
    expect(isGatewayBaseUrl('http://localhost:80930/v1', HOST)).toBe(false);
    expect(isGatewayBaseUrl(undefined, HOST)).toBe(false);
  });
});

describe('buildGatewayModelsPath', () => {
  let dir: string;
  let source: string;
  const written: string[] = [];

  const write = (providers: Record<string, unknown>): void => {
    writeFileSync(source, JSON.stringify({ providers }));
  };
  const build = (provider: string, gatewayUrl = HOST): string => {
    const path = buildGatewayModelsPath(provider, {
      ARCHON_LLM_GATEWAY_URL: gatewayUrl,
      ARCHON_PI_MODELS_PATH: source,
    });
    written.push(path);
    return path;
  };
  const good = {
    baseUrl: '${ARCHON_LLM_GATEWAY_URL}/openrouter/v1',
    api: 'openai-completions',
    apiKey: 'gateway',
    headers: { 'X-Caller': 'archon' },
    models: [{ id: 'm' }],
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'archon-gateway-unit-'));
    source = join(dir, 'models.json');
  });
  afterEach(() => {
    for (const p of written.splice(0)) rmSync(p, { force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  test('resolves baseUrl per environment and writes only the selected provider', () => {
    write({
      'gateway-openrouter': good,
      'gateway-llamacpp': { ...good, baseUrl: '${ARCHON_LLM_GATEWAY_URL}/v1' },
    });
    const hostFile = JSON.parse(readFileSync(build('gateway-openrouter'), 'utf-8')) as {
      providers: Record<string, { baseUrl: string }>;
    };
    expect(Object.keys(hostFile.providers)).toEqual(['gateway-openrouter']);
    expect(hostFile.providers['gateway-openrouter'].baseUrl).toBe(`${HOST}/openrouter/v1`);

    const containerFile = JSON.parse(
      readFileSync(build('gateway-llamacpp', CONTAINER), 'utf-8')
    ) as {
      providers: Record<string, { baseUrl: string }>;
    };
    expect(containerFile.providers['gateway-llamacpp'].baseUrl).toBe(`${CONTAINER}/v1`);
  });

  test('refuses a provider pointing straight at a vendor', () => {
    write({ 'gateway-openrouter': { ...good, baseUrl: 'https://openrouter.ai/api/v1' } });
    expect(() => build('gateway-openrouter')).toThrow(/does not point at the gateway/);
  });

  test('refuses a per-model baseUrl that leaves the gateway', () => {
    write({
      'gateway-openrouter': { ...good, models: [{ id: 'm', baseUrl: 'https://api.x.ai/v1' }] },
    });
    expect(() => build('gateway-openrouter')).toThrow(/models\[0\]\.baseUrl/);
  });

  test('refuses an apiKey or header that pulls a secret from the environment', () => {
    write({ 'gateway-openrouter': { ...good, apiKey: '${OPENROUTER_API_KEY}' } });
    expect(() => build('gateway-openrouter')).toThrow(/apiKey must be a literal/);
    write({ 'gateway-openrouter': { ...good, apiKey: '!cat key' } });
    expect(() => build('gateway-openrouter')).toThrow(/apiKey must be a literal/);
    write({
      'gateway-openrouter': { ...good, headers: { 'X-Caller': 'archon', Authorization: '$TOKEN' } },
    });
    expect(() => build('gateway-openrouter')).toThrow(/headers\.Authorization/);
  });

  test('requires the X-Caller header', () => {
    write({ 'gateway-openrouter': { ...good, headers: {} } });
    expect(() => build('gateway-openrouter')).toThrow(/X-Caller/);
  });

  test('refuses a provider missing from models.json, and a missing file', () => {
    write({ 'gateway-openrouter': good });
    expect(() => build('gateway-xai')).toThrow(/not defined/);
    rmSync(source);
    expect(() => build('gateway-openrouter')).toThrow(/cannot read gateway models.json/);
  });

  test('the tracked deploy/pi/models.gateway.json passes the policy', () => {
    const tracked = join(import.meta.dir, '../../../../../deploy/pi/models.gateway.json');
    expect(existsSync(tracked)).toBe(true);
    const ids = Object.keys(
      (JSON.parse(readFileSync(tracked, 'utf-8')) as { providers: Record<string, unknown> })
        .providers
    );
    expect(ids).toContain('gateway-openrouter');
    expect(ids).toContain('gateway-llamacpp');
    for (const id of ids) {
      const path = buildGatewayModelsPath(id, {
        ARCHON_LLM_GATEWAY_URL: CONTAINER,
        ARCHON_PI_MODELS_PATH: tracked,
      });
      written.push(path);
    }
  });
});
