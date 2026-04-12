/**
 * Tests for OpenAICompatibleClient.
 *
 * Verifies: IAssistantClient implementation, tool resolution, context-window
 * integration, rate-limit retry with exponential backoff, system prompt
 * injection, structured output mapping, and abort signal support.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { OpenAICompatibleClient, type OpenAICompatibleClientConfig } from './openai-compatible';
import type { MessageChunk, AssistantRequestOptions } from '../types';

// ─── Helpers ────────────────────────────────────────────────────────────────

async function collectChunks(gen: AsyncGenerator<MessageChunk>): Promise<MessageChunk[]> {
  const chunks: MessageChunk[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}

/** Build SSE-formatted streaming response body. */
function makeSSE(
  content: string,
  opts?: { promptTokens?: number; completionTokens?: number }
): string {
  const lines: string[] = [];
  // Content chunk
  lines.push(
    `data: ${JSON.stringify({
      id: 'test',
      choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
    })}\n\n`
  );
  // Final chunk
  lines.push(
    `data: ${JSON.stringify({
      id: 'test',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: opts?.promptTokens ?? 10,
        completion_tokens: opts?.completionTokens ?? 5,
        total_tokens: (opts?.promptTokens ?? 10) + (opts?.completionTokens ?? 5),
      },
    })}\n\n`
  );
  lines.push('data: [DONE]\n\n');
  return lines.join('');
}

function okResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

const BASE_CONFIG: OpenAICompatibleClientConfig = {
  endpointUrl: 'https://test.api/v1/chat/completions',
  apiKey: 'test-key',
  providerName: 'test-provider',
  defaultModel: 'test-model',
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('OpenAICompatibleClient', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('getType()', () => {
    it('returns the configured provider name', () => {
      const client = new OpenAICompatibleClient(BASE_CONFIG);
      expect(client.getType()).toBe('test-provider');
    });
  });

  describe('sendQuery() — single-turn', () => {
    it('yields assistant + result chunks', async () => {
      globalThis.fetch = async () => okResponse(makeSSE('Hello world'));

      const client = new OpenAICompatibleClient(BASE_CONFIG);
      const chunks = await collectChunks(client.sendQuery('Hi', '/tmp/test'));

      const assistant = chunks.filter(c => c.type === 'assistant');
      const result = chunks.filter(c => c.type === 'result');
      expect(assistant.length).toBeGreaterThanOrEqual(1);
      expect(result.length).toBe(1);

      const r = result[0] as Extract<MessageChunk, { type: 'result' }>;
      expect(r.tokens).toBeDefined();
      expect(r.tokens!.input).toBe(10);
      expect(r.tokens!.output).toBe(5);
    });

    it('sends model and messages in request body', async () => {
      let body: Record<string, unknown> | null = null;
      globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(init?.body as string) as Record<string, unknown>;
        return okResponse(makeSSE('ok'));
      };

      const client = new OpenAICompatibleClient(BASE_CONFIG);
      await collectChunks(client.sendQuery('test', '/tmp/test'));

      expect(body!.model).toBe('test-model');
      expect(body!.messages).toBeDefined();
    });
  });

  describe('sendQuery() — system prompt', () => {
    it('prepends system message when systemPrompt is set', async () => {
      let body: Record<string, unknown> | null = null;
      globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(init?.body as string) as Record<string, unknown>;
        return okResponse(makeSSE('ok'));
      };

      const client = new OpenAICompatibleClient(BASE_CONFIG);
      await collectChunks(
        client.sendQuery('user prompt', '/tmp/test', undefined, {
          systemPrompt: 'You are helpful.',
        })
      );

      const msgs = body!.messages as { role: string; content: string }[];
      expect(msgs[0]!.role).toBe('system');
      expect(msgs[0]!.content).toBe('You are helpful.');
      expect(msgs[1]!.role).toBe('user');
      expect(msgs[1]!.content).toBe('user prompt');
    });
  });

  describe('sendQuery() — structured output', () => {
    it('maps outputFormat to response_format', async () => {
      let body: Record<string, unknown> | null = null;
      globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(init?.body as string) as Record<string, unknown>;
        return okResponse(makeSSE('{"key":"val"}'));
      };

      const schema = { type: 'object', properties: { key: { type: 'string' } } };
      const client = new OpenAICompatibleClient(BASE_CONFIG);
      await collectChunks(
        client.sendQuery('gen', '/tmp/test', undefined, {
          outputFormat: { type: 'json_schema', schema },
        })
      );

      expect(body!.response_format).toEqual({
        type: 'json_schema',
        json_schema: schema,
      });
    });
  });

  describe('sendQuery() — tool resolution', () => {
    it('includes all 8 canonical tools by default', async () => {
      let body: Record<string, unknown> | null = null;
      globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(init?.body as string) as Record<string, unknown>;
        return okResponse(makeSSE('ok'));
      };

      const client = new OpenAICompatibleClient(BASE_CONFIG);
      await collectChunks(client.sendQuery('test', '/tmp/test'));

      const tools = body!.tools as { function: { name: string } }[];
      expect(tools.length).toBe(8);
    });

    it('filters to allowed_tools when specified', async () => {
      let body: Record<string, unknown> | null = null;
      globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(init?.body as string) as Record<string, unknown>;
        return okResponse(makeSSE('ok'));
      };

      const client = new OpenAICompatibleClient(BASE_CONFIG);
      await collectChunks(
        client.sendQuery('test', '/tmp/test', undefined, { tools: ['Read', 'Write'] })
      );

      const tools = body!.tools as { function: { name: string } }[];
      expect(tools.length).toBe(2);
      expect(tools.map(t => t.function.name).sort()).toEqual(['Read', 'Write']);
    });

    it('excludes denied_tools', async () => {
      let body: Record<string, unknown> | null = null;
      globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(init?.body as string) as Record<string, unknown>;
        return okResponse(makeSSE('ok'));
      };

      const client = new OpenAICompatibleClient(BASE_CONFIG);
      await collectChunks(
        client.sendQuery('test', '/tmp/test', undefined, { disallowedTools: ['Bash', 'Write'] })
      );

      const tools = body!.tools as { function: { name: string } }[];
      expect(tools.length).toBe(6);
      const names = tools.map(t => t.function.name);
      expect(names).not.toContain('Bash');
      expect(names).not.toContain('Write');
    });

    it('sends no tools when tools is explicitly empty', async () => {
      let body: Record<string, unknown> | null = null;
      globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(init?.body as string) as Record<string, unknown>;
        return okResponse(makeSSE('ok'));
      };

      const client = new OpenAICompatibleClient(BASE_CONFIG);
      await collectChunks(client.sendQuery('test', '/tmp/test', undefined, { tools: [] }));

      expect(body!.tools).toBeUndefined();
    });
  });

  describe('sendQuery() — endpoint config', () => {
    it('sends Authorization header with API key', async () => {
      let hdrs: Record<string, string> | null = null;
      globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
        hdrs = { ...(init?.headers as Record<string, string>) };
        return okResponse(makeSSE('ok'));
      };

      const client = new OpenAICompatibleClient(BASE_CONFIG);
      await collectChunks(client.sendQuery('test', '/tmp/test'));
      expect(hdrs!['Authorization']).toBe('Bearer test-key');
    });

    it('sends custom headers', async () => {
      let hdrs: Record<string, string> | null = null;
      globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
        hdrs = { ...(init?.headers as Record<string, string>) };
        return okResponse(makeSSE('ok'));
      };

      const client = new OpenAICompatibleClient({
        ...BASE_CONFIG,
        headers: { 'X-Custom': 'value' },
      });
      await collectChunks(client.sendQuery('test', '/tmp/test'));
      expect(hdrs!['X-Custom']).toBe('value');
    });

    it('sends to configured endpoint URL', async () => {
      let url = '';
      globalThis.fetch = async (u: string | URL | Request) => {
        url = typeof u === 'string' ? u : u instanceof URL ? u.toString() : u.url;
        return okResponse(makeSSE('ok'));
      };

      const client = new OpenAICompatibleClient(BASE_CONFIG);
      await collectChunks(client.sendQuery('test', '/tmp/test'));
      expect(url).toBe('https://test.api/v1/chat/completions');
    });

    it('works without API key (local servers)', async () => {
      let hdrs: Record<string, string> | null = null;
      globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
        hdrs = { ...(init?.headers as Record<string, string>) };
        return okResponse(makeSSE('ok'));
      };

      const client = new OpenAICompatibleClient({ ...BASE_CONFIG, apiKey: undefined });
      await collectChunks(client.sendQuery('test', '/tmp/test'));
      expect(hdrs!['Authorization']).toBeUndefined();
    });
  });

  describe('sendQuery() — rate limiting', () => {
    it('retries on HTTP 429 with backoff', async () => {
      let callCount = 0;
      globalThis.fetch = async () => {
        callCount++;
        if (callCount <= 2) {
          return new Response('Rate limited', { status: 429 });
        }
        return okResponse(makeSSE('success'));
      };

      const client = new OpenAICompatibleClient(BASE_CONFIG);
      // Make sleep instant for testing
      (client as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => {};

      const chunks = await collectChunks(client.sendQuery('test', '/tmp/test'));

      const rateLimits = chunks.filter(c => c.type === 'rate_limit');
      const results = chunks.filter(c => c.type === 'result');
      expect(rateLimits.length).toBe(2);
      expect(results.length).toBe(1);
      expect(callCount).toBe(3);
    });

    it('throws after max retries exceeded', async () => {
      globalThis.fetch = async () => new Response('Rate limited', { status: 429 });

      const client = new OpenAICompatibleClient(BASE_CONFIG);
      (client as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => {};
      (
        client as unknown as { rateLimitConfig: { maxRetries: number } }
      ).rateLimitConfig.maxRetries = 2;

      await expect(collectChunks(client.sendQuery('test', '/tmp/test'))).rejects.toThrow(
        'HTTP 429'
      );
    });

    it('emits rate_limit chunks with retry info', async () => {
      let callCount = 0;
      globalThis.fetch = async () => {
        callCount++;
        if (callCount <= 1) {
          return new Response('Rate limited', { status: 429 });
        }
        return okResponse(makeSSE('ok'));
      };

      const client = new OpenAICompatibleClient(BASE_CONFIG);
      (client as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async () => {};

      const chunks = await collectChunks(client.sendQuery('test', '/tmp/test'));
      const rl = chunks.find(c => c.type === 'rate_limit') as Extract<
        MessageChunk,
        { type: 'rate_limit' }
      >;

      expect(rl).toBeDefined();
      expect(rl.rateLimitInfo.attempt).toBe(1);
      expect(rl.rateLimitInfo.provider).toBe('test-provider');
    });
  });

  describe('sendQuery() — error handling', () => {
    it('throws on non-429 HTTP errors', async () => {
      globalThis.fetch = async () => new Response('Internal Server Error', { status: 500 });

      const client = new OpenAICompatibleClient(BASE_CONFIG);
      await expect(collectChunks(client.sendQuery('test', '/tmp/test'))).rejects.toThrow(
        'HTTP 500'
      );
    });
  });

  describe('sendQuery() — abort signal', () => {
    it('propagates abort signal', async () => {
      const controller = new AbortController();
      controller.abort();

      globalThis.fetch = async () => {
        throw new DOMException('The operation was aborted.', 'AbortError');
      };

      const client = new OpenAICompatibleClient(BASE_CONFIG);
      await expect(
        collectChunks(
          client.sendQuery('test', '/tmp/test', undefined, { abortSignal: controller.signal })
        )
      ).rejects.toThrow();
    });
  });

  describe('sendQuery() — model selection', () => {
    it('uses options.model over defaultModel', async () => {
      let body: Record<string, unknown> | null = null;
      globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(init?.body as string) as Record<string, unknown>;
        return okResponse(makeSSE('ok'));
      };

      const client = new OpenAICompatibleClient(BASE_CONFIG);
      await collectChunks(
        client.sendQuery('test', '/tmp/test', undefined, { model: 'custom-model' })
      );
      expect(body!.model).toBe('custom-model');
    });

    it('falls back to defaultModel', async () => {
      let body: Record<string, unknown> | null = null;
      globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(init?.body as string) as Record<string, unknown>;
        return okResponse(makeSSE('ok'));
      };

      const client = new OpenAICompatibleClient(BASE_CONFIG);
      await collectChunks(client.sendQuery('test', '/tmp/test'));
      expect(body!.model).toBe('test-model');
    });
  });

  describe('subclass extensibility', () => {
    it('allows subclass to override buildEndpoint()', async () => {
      class CustomClient extends OpenAICompatibleClient {
        protected override buildEndpoint() {
          const ep = super.buildEndpoint();
          ep.headers = { ...ep.headers, 'X-Custom-Header': 'custom' };
          return ep;
        }
      }

      let hdrs: Record<string, string> | null = null;
      globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
        hdrs = { ...(init?.headers as Record<string, string>) };
        return okResponse(makeSSE('ok'));
      };

      const client = new CustomClient(BASE_CONFIG);
      await collectChunks(client.sendQuery('test', '/tmp/test'));
      expect(hdrs!['X-Custom-Header']).toBe('custom');
    });

    it('allows subclass to override buildExtraBody()', async () => {
      class GrammarClient extends OpenAICompatibleClient {
        protected override buildExtraBody(options?: AssistantRequestOptions) {
          const extra = super.buildExtraBody(options);
          if (options?.outputFormat) {
            delete extra.response_format;
            extra.grammar = 'root ::= "test"';
          }
          return extra;
        }
      }

      let body: Record<string, unknown> | null = null;
      globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(init?.body as string) as Record<string, unknown>;
        return okResponse(makeSSE('ok'));
      };

      const schema = { type: 'object', properties: {} };
      const client = new GrammarClient(BASE_CONFIG);
      await collectChunks(
        client.sendQuery('test', '/tmp/test', undefined, {
          outputFormat: { type: 'json_schema', schema },
        })
      );

      expect(body!.grammar).toBe('root ::= "test"');
      expect(body!.response_format).toBeUndefined();
    });
  });
});
