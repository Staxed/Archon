/**
 * OpenRouter provider client.
 *
 * Extends OpenAICompatibleClient with OpenRouter-specific configuration:
 *   - Custom HTTP-Referer and X-Title headers
 *   - API key from config or OPENROUTER_API_KEY env var
 *   - Model routing via vendor/model format (e.g., 'anthropic/claude-3-haiku')
 */

import { OpenAICompatibleClient, type OpenAICompatibleClientConfig } from './openai-compatible';
import type { ProviderEndpointConfig } from './tool-loop';
import type { OpenRouterAssistantDefaults } from '../config/config-types';

import { createLogger } from '@archon/paths';

const log = createLogger('client.openrouter');

const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

/** Error thrown when OpenRouter API key is missing. */
export class OpenRouterMissingApiKeyError extends Error {
  constructor() {
    super(
      'OpenRouter API key is required. Set OPENROUTER_API_KEY environment variable or configure apiKey in .archon/config.yaml under assistants.openrouter.'
    );
    this.name = 'OpenRouterMissingApiKeyError';
  }
}

/** Configuration for the OpenRouter client. */
export interface OpenRouterClientConfig {
  /** OpenRouter API key. Falls back to OPENROUTER_API_KEY env var. */
  apiKey?: string;
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

    if (!apiKey) {
      throw new OpenRouterMissingApiKeyError();
    }

    const baseConfig: OpenAICompatibleClientConfig = {
      endpointUrl: OPENROUTER_ENDPOINT,
      apiKey,
      providerName: 'openrouter',
      defaultModel: config.model,
    };

    super(baseConfig);

    this.siteUrl = config.siteUrl;
    this.siteName = config.siteName;

    log.info(
      { model: config.model, hasSiteUrl: !!config.siteUrl, hasSiteName: !!config.siteName },
      'openrouter.client_initialized'
    );
  }

  /**
   * Create an OpenRouterClient from merged config defaults.
   */
  static fromConfig(defaults: OpenRouterAssistantDefaults): OpenRouterClient {
    return new OpenRouterClient({
      apiKey: defaults.apiKey,
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
