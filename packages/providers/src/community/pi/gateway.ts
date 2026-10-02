/**
 * Pi gateway-only mode (fork policy, see FORK.md).
 *
 * Every HTTP model call on this host must go through the LLM metering gateway
 * (`llm-metrics`), which holds the provider keys. With `assistants.pi.gatewayOnly`
 * on (the fork default), a Pi node may only use a `gateway-*` provider defined in
 * a models.json whose baseUrl sits under `$ARCHON_LLM_GATEWAY_URL`, with a literal
 * (non-secret) apiKey and an `X-Caller` header. Built-in vendors (openrouter, xai,
 * openai, google, anthropic, …), auth.json logins and API-key env vars are refused.
 *
 * Pi resolves `${VAR}` only in apiKey/headers, never in baseUrl, so Archon
 * substitutes `${ARCHON_LLM_GATEWAY_URL}` in baseUrl itself and hands Pi a
 * per-call models.json holding just the selected provider. That lets one
 * tracked file serve the host (`http://localhost:8093`) and containers/sandboxes
 * (`http://host.docker.internal:8093`).
 */
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expandTilde } from '@archon/paths';

import { PI_PROVIDER_ENV_VARS } from './pi-vendor-map.generated';
import { getUserModelsPath } from './request-auth';

/** Gateway root without the provider segment, e.g. `http://localhost:8093`. */
export const GATEWAY_URL_ENV = 'ARCHON_LLM_GATEWAY_URL';
/** Optional models.json override (e.g. the tracked deploy/pi/models.gateway.json). */
export const GATEWAY_MODELS_PATH_ENV = 'ARCHON_PI_MODELS_PATH';
/** Provider ids allowed in gateway-only mode. */
export const GATEWAY_PROVIDER_PREFIX = 'gateway-';

const GATEWAY_URL_TOKEN = `\${${GATEWAY_URL_ENV}}`;

let gatewayOnlyDefault = true;

/** Effective gateway-only setting: explicit config wins, else the fork default (on). */
export function isPiGatewayOnly(configValue: boolean | undefined): boolean {
  return configValue ?? gatewayOnlyDefault;
}

/** Test-only: the upstream Pi suites exercise built-in vendors directly. */
export function setPiGatewayOnlyDefaultForTest(value: boolean): void {
  gatewayOnlyDefault = value;
}

export class PiGatewayPolicyError extends Error {
  constructor(message: string) {
    super(`Pi gateway-only: ${message}`);
    this.name = 'PiGatewayPolicyError';
  }
}

type Env = Readonly<Record<string, string | undefined>>;

function readEnv(name: string, requestEnv: Env | undefined): string | undefined {
  const value = (requestEnv?.[name] ?? process.env[name])?.trim();
  return value ? value : undefined;
}

/** `$ARCHON_LLM_GATEWAY_URL` without a trailing slash; throws when unset. */
export function resolveGatewayUrl(requestEnv?: Env): string {
  const url = readEnv(GATEWAY_URL_ENV, requestEnv);
  if (!url) {
    throw new PiGatewayPolicyError(
      `${GATEWAY_URL_ENV} is not set. Set it to http://localhost:8093 on the host or ` +
        'http://host.docker.internal:8093 in a container or sandbox.'
    );
  }
  return url.replace(/\/+$/, '');
}

/** True when `baseUrl` is the gateway root or a path under it. */
export function isGatewayBaseUrl(baseUrl: string | undefined, gatewayUrl: string): boolean {
  if (!baseUrl) return false;
  const normalized = baseUrl.replace(/\/+$/, '');
  return normalized === gatewayUrl || normalized.startsWith(`${gatewayUrl}/`);
}

/** Refuse a model ref before any credential is loaded. */
export function assertGatewayProviderId(provider: string): void {
  if (
    PI_PROVIDER_ENV_VARS[provider] !== undefined ||
    !provider.startsWith(GATEWAY_PROVIDER_PREFIX)
  ) {
    throw new PiGatewayPolicyError(
      `provider '${provider}' is not allowed. Model calls must go through the LLM gateway: ` +
        `use a '${GATEWAY_PROVIDER_PREFIX}*' provider from the gateway models.json ` +
        "(e.g. 'gateway-openrouter/<model>' or 'gateway-llamacpp/<model>'), not a direct vendor."
    );
  }
}

function isLiteral(value: string): boolean {
  return !value.includes('$') && !value.startsWith('!');
}

function substituteBaseUrl(value: unknown, gatewayUrl: string, where: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new PiGatewayPolicyError(`${where} must be a string`);
  const resolved = value.split(GATEWAY_URL_TOKEN).join(gatewayUrl);
  if (!isGatewayBaseUrl(resolved, gatewayUrl)) {
    throw new PiGatewayPolicyError(
      `${where} '${value}' does not point at the gateway (${gatewayUrl}). ` +
        `Use '${GATEWAY_URL_TOKEN}/<provider>/v1'.`
    );
  }
  return resolved;
}

function assertLiteralHeaders(headers: unknown, where: string): Record<string, string> {
  if (headers === undefined) return {};
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    throw new PiGatewayPolicyError(`${where} must be an object`);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (typeof value !== 'string' || !isLiteral(value)) {
      throw new PiGatewayPolicyError(
        `${where}.${key} must be a literal string (no \${VAR} or !command): ` +
          'the project holds no secrets, the gateway does.'
      );
    }
    out[key] = value;
  }
  return out;
}

/**
 * Validate the selected gateway provider and write a per-call models.json with
 * its baseUrl(s) resolved against `$ARCHON_LLM_GATEWAY_URL`. Returns the file
 * path for `ModelRuntime.create({ modelsPath })`; the caller removes it.
 */
export function buildGatewayModelsPath(provider: string, requestEnv?: Env): string {
  assertGatewayProviderId(provider);
  const gatewayUrl = resolveGatewayUrl(requestEnv);

  const override = readEnv(GATEWAY_MODELS_PATH_ENV, requestEnv);
  const sourcePath = override ? expandTilde(override) : getUserModelsPath();
  let parsed: { providers?: Record<string, unknown> };
  try {
    parsed = JSON.parse(readFileSync(sourcePath, 'utf-8')) as typeof parsed;
  } catch (err) {
    throw new PiGatewayPolicyError(
      `cannot read gateway models.json at ${sourcePath}: ${(err as Error).message}. ` +
        `Point ${GATEWAY_MODELS_PATH_ENV} at deploy/pi/models.gateway.json or copy it there.`
    );
  }
  const entry = parsed.providers?.[provider];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new PiGatewayPolicyError(`provider '${provider}' is not defined in ${sourcePath}.`);
  }

  const config = structuredClone(entry) as Record<string, unknown>;
  if (config.oauth !== undefined) {
    throw new PiGatewayPolicyError(`providers.${provider}.oauth is not allowed.`);
  }
  const baseUrl = substituteBaseUrl(config.baseUrl, gatewayUrl, `providers.${provider}.baseUrl`);
  if (baseUrl === undefined) {
    throw new PiGatewayPolicyError(`providers.${provider}.baseUrl is required.`);
  }
  config.baseUrl = baseUrl;

  if (
    config.apiKey !== undefined &&
    (typeof config.apiKey !== 'string' || !isLiteral(config.apiKey))
  ) {
    throw new PiGatewayPolicyError(
      `providers.${provider}.apiKey must be a literal placeholder (no \${VAR} or !command): ` +
        'the gateway holds the real key.'
    );
  }

  const headers = assertLiteralHeaders(config.headers, `providers.${provider}.headers`);
  if (!Object.entries(headers).some(([k, v]) => k.toLowerCase() === 'x-caller' && v.trim())) {
    throw new PiGatewayPolicyError(`providers.${provider}.headers must set X-Caller.`);
  }

  if (Array.isArray(config.models)) {
    config.models = config.models.map((model: unknown, i: number) => {
      if (!model || typeof model !== 'object') return model;
      const m = { ...(model as Record<string, unknown>) };
      const where = `providers.${provider}.models[${i}]`;
      if (m.baseUrl !== undefined)
        m.baseUrl = substituteBaseUrl(m.baseUrl, gatewayUrl, `${where}.baseUrl`);
      if (m.headers !== undefined) assertLiteralHeaders(m.headers, `${where}.headers`);
      return m;
    });
  }

  const dir = join(tmpdir(), 'archon-pi-models');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const filePath = join(
    dir,
    `gateway-${provider}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.json`
  );
  try {
    writeFileSync(filePath, JSON.stringify({ providers: { [provider]: config } }, null, 2), {
      mode: 0o600,
    });
  } catch (err) {
    rmSync(filePath, { force: true });
    throw err;
  }
  return filePath;
}

/**
 * Empty credential store for gateway mode, so neither ~/.pi/agent/auth.json nor
 * ARCHON_PI_AUTH_PATH can supply a vendor key. Pi creates it as `{}`.
 */
export function gatewayAuthPath(): string {
  const dir = join(tmpdir(), 'archon-pi-gateway');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, 'auth.json');
}
