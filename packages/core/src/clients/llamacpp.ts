/**
 * Llama.cpp provider client.
 *
 * Extends OpenAICompatibleClient with Llama.cpp-specific configuration:
 *   - Local server endpoint (default http://localhost:8080)
 *   - No API key required
 *   - GBNF grammar for structured output (instead of response_format)
 *   - Model loaded server-side; model field is informational
 */

import { OpenAICompatibleClient, type OpenAICompatibleClientConfig } from './openai-compatible';
import type { AssistantRequestOptions } from '../types';
import type { LlamaCppAssistantDefaults } from '../config/config-types';
import { jsonSchemaToGbnf } from './grammar/json-schema-to-gbnf';

import { createLogger } from '@archon/paths';

const log = createLogger('client.llamacpp');

const DEFAULT_ENDPOINT = 'http://localhost:8080';

/** Error thrown when the Llama.cpp endpoint is unreachable. */
export class LlamaCppEndpointUnreachableError extends Error {
  readonly endpoint: string;

  constructor(endpoint: string, cause?: Error) {
    super(
      `Cannot reach llama.cpp endpoint at ${endpoint}. Ensure llama-server is running and accessible.`
    );
    this.name = 'LlamaCppEndpointUnreachableError';
    this.endpoint = endpoint;
    if (cause) {
      this.cause = cause;
    }
  }
}

/** Configuration for the Llama.cpp client. */
export interface LlamaCppClientConfig {
  /** llama-server endpoint URL. Falls back to LLAMACPP_ENDPOINT env var, then default. */
  endpoint?: string;
  /** Model name (informational — model is loaded server-side). */
  model?: string;
}

export class LlamaCppClient extends OpenAICompatibleClient {
  private readonly endpoint: string;

  constructor(config: LlamaCppClientConfig = {}) {
    const endpoint = config.endpoint ?? process.env.LLAMACPP_ENDPOINT ?? DEFAULT_ENDPOINT;

    const baseConfig: OpenAICompatibleClientConfig = {
      endpointUrl: `${endpoint.replace(/\/+$/, '')}/v1/chat/completions`,
      providerName: 'llamacpp',
      defaultModel: config.model ?? 'local',
    };

    super(baseConfig);

    this.endpoint = endpoint;

    log.info({ endpoint, model: config.model ?? 'local' }, 'llamacpp.client_initialized');
  }

  /**
   * Create a LlamaCppClient from merged config defaults.
   */
  static fromConfig(defaults: LlamaCppAssistantDefaults): LlamaCppClient {
    return new LlamaCppClient({
      endpoint: defaults.endpoint,
      model: defaults.model,
    });
  }

  /**
   * Override extra body to use GBNF grammar instead of response_format
   * for structured output. Llama.cpp uses the `grammar` field natively.
   */
  protected override buildExtraBody(options?: AssistantRequestOptions): Record<string, unknown> {
    const extra: Record<string, unknown> = {};
    if (options?.outputFormat) {
      extra.grammar = jsonSchemaToGbnf(options.outputFormat.schema);
    }
    return extra;
  }

  /**
   * Override sendQuery to wrap connection errors with classified error.
   */
  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    options?: AssistantRequestOptions
  ): AsyncGenerator<import('../types').MessageChunk> {
    try {
      yield* super.sendQuery(prompt, cwd, resumeSessionId, options);
    } catch (err) {
      const error = err as Error;
      if (this.isConnectionError(error)) {
        throw new LlamaCppEndpointUnreachableError(this.endpoint, error);
      }
      throw error;
    }
  }

  /**
   * Check if an error indicates a connection failure (endpoint unreachable).
   */
  private isConnectionError(error: Error): boolean {
    const msg = error.message.toLowerCase();
    return (
      msg.includes('econnrefused') ||
      msg.includes('enotfound') ||
      msg.includes('econnreset') ||
      msg.includes('etimedout') ||
      msg.includes('fetch failed') ||
      msg.includes('unable to connect')
    );
  }
}
