/**
 * OpenRouter provider client.
 *
 * Extends OpenAICompatibleClient with OpenRouter-specific configuration:
 *   - Custom HTTP-Referer and X-Title headers
 *   - Calls go through the Dashed LLM gateway (see llm-gateway.ts), which holds
 *     the key; a base URL straight to OpenRouter needs one from config or
 *     OPENROUTER_API_KEY
 *   - Model routing via vendor/model format (e.g., 'anthropic/claude-3-haiku')
 */

import { OpenAICompatibleClient, type OpenAICompatibleClientConfig } from './openai-compatible';
import type { ProviderEndpointConfig } from './tool-loop';
import type { OpenRouterAssistantDefaults } from '../config/config-types';

import { createLogger } from '@archon/paths';
import { GATEWAY_CALLER_HEADERS, gatewayProviderBase, isDirectProviderUrl } from './llm-gateway';

const log = createLogger('client.openrouter');

/** Error thrown when an OpenRouter API key is needed (direct base URL) but missing. */
export class OpenRouterMissingApiKeyError extends Error {
  constructor() {
    super(
      'OpenRouter API key is required when calling OpenRouter directly. Set OPENROUTER_API_KEY or configure apiKey in .archon/config.yaml under assistants.openrouter, or leave the base URL on the LLM gateway, which holds the key.'
    );
    this.name = 'OpenRouterMissingApiKeyError';
  }
}

/** Configuration for the OpenRouter client. */
export interface OpenRouterClientConfig {
  /** OpenRouter API key. Falls back to OPENROUTER_API_KEY env var. Not needed via the gateway. */
  apiKey?: string;
  /** OpenAI-compatible base URL ending in /v1. Falls back to OPENROUTER_BASE_URL, then the gateway. */
  baseUrl?: string;
  /** Default model in vendor/model format (e.g., 'anthropic/claude-3-haiku'). */
  model?: string;
  /** HTTP-Referer header value for OpenRouter ranking/analytics. */
  siteUrl?: string;
  /** X-Title header value for OpenRouter ranking/analytics. */
  siteName?: string;
}

export class OpenRouterClient extends OpenAICompatibleClient {
  private readonly siteUrl: string | undefined;
  private readonly siteName: string | undefined;

  constructor(config: OpenRouterClientConfig = {}) {
    const apiKey = config.apiKey ?? process.env.OPENROUTER_API_KEY;
    const baseUrl = (
      config.baseUrl ??
      process.env.OPENROUTER_BASE_URL ??
      gatewayProviderBase('openrouter')
    ).replace(/\/+$/, '');

    if (!apiKey && isDirectProviderUrl(`${baseUrl}/`)) {
      throw new OpenRouterMissingApiKeyError();
    }

    const baseConfig: OpenAICompatibleClientConfig = {
      endpointUrl: `${baseUrl}/chat/completions`,
      apiKey,
      headers: { ...GATEWAY_CALLER_HEADERS },
      providerName: 'openrouter',
      defaultModel: config.model,
    };

    super(baseConfig);

    this.siteUrl = config.siteUrl;
    this.siteName = config.siteName;

    log.info(
      {
        model: config.model,
        baseUrl,
        hasSiteUrl: !!config.siteUrl,
        hasSiteName: !!config.siteName,
      },
      'openrouter.client_initialized'
    );
  }

  /**
   * Create an OpenRouterClient from merged config defaults.
   */
  static fromConfig(defaults: OpenRouterAssistantDefaults): OpenRouterClient {
    return new OpenRouterClient({
      apiKey: defaults.apiKey,
      baseUrl: defaults.baseUrl,
      model: defaults.model,
      siteUrl: defaults.siteUrl,
      siteName: defaults.siteName,
    });
  }

  /**
   * Override endpoint to inject OpenRouter-specific headers:
   * - HTTP-Referer: used by OpenRouter for ranking and analytics
   * - X-Title: used by OpenRouter for ranking and analytics
   */
  protected override buildEndpoint(): ProviderEndpointConfig {
    const endpoint = super.buildEndpoint();

    if (this.siteUrl) {
      endpoint.headers = { ...endpoint.headers, 'HTTP-Referer': this.siteUrl };
    }
    if (this.siteName) {
      endpoint.headers = { ...endpoint.headers, 'X-Title': this.siteName };
    }

    return endpoint;
  }
}
