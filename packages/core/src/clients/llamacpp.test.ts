/**
 * Tests for LlamaCppClient.
 *
 * Verifies: endpoint config, no-API-key path, GBNF grammar injection
 * for output_format, connection error classification, fromConfig factory.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { LlamaCppClient, LlamaCppEndpointUnreachableError } from './llamacpp';
import type { MessageChunk } from '../types';

// ─── Helpers ────────────────────────────────────────────────────────────────

async function collectChunks(gen: AsyncGenerator<MessageChunk>): Promise<MessageChunk[]> {
  const chunks: MessageChunk[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}

/** Build SSE-formatted streaming response body. */
function makeSSE(content: string): string {
  const lines: string[] = [];
  lines.push(
    `data: ${JSON.stringify({
      id: 'test',
      choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
    })}\n\n`
  );
  lines.push(
    `data: ${JSON.stringify({
      id: 'test',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
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

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('LlamaCppClient', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalEndpointEnv: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEndpointEnv = process.env.LLAMACPP_ENDPOINT;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalEndpointEnv !== undefined) {
      process.env.LLAMACPP_ENDPOINT = originalEndpointEnv;
    } else {
      delete process.env.LLAMACPP_ENDPOINT;
    }
  });

  describe('constructor — endpoint config', () => {
    it('uses endpoint from config', async () => {
      let requestUrl = '';
      globalThis.fetch = async (url: string | URL | Request) => {
        requestUrl = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
        return okResponse(makeSSE('ok'));
      };

      const client = new LlamaCppClient({ endpoint: 'http://myhost:9090' });
      await collectChunks(client.sendQuery('Hi', '/tmp/test'));

      expect(requestUrl).toBe('http://myhost:9090/v1/chat/completions');
    });

    it('falls back to LLAMACPP_ENDPOINT env var', async () => {
      let requestUrl = '';
      process.env.LLAMACPP_ENDPOINT = 'http://envhost:7070';
      globalThis.fetch = async (url: string | URL | Request) => {
        requestUrl = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
        return okResponse(makeSSE('ok'));
      };

      const client = new LlamaCppClient();
      await collectChunks(client.sendQuery('Hi', '/tmp/test'));

      expect(requestUrl).toBe('http://envhost:7070/v1/chat/completions');
    });

    it('defaults to http://localhost:8080 when no config or env', async () => {
      delete process.env.LLAMACPP_ENDPOINT;
      let requestUrl = '';
      globalThis.fetch = async (url: string | URL | Request) => {
        requestUrl = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
        return okResponse(makeSSE('ok'));
      };

      const client = new LlamaCppClient();
      await collectChunks(client.sendQuery('Hi', '/tmp/test'));

      expect(requestUrl).toBe('http://localhost:8080/v1/chat/completions');
    });

    it('strips trailing slashes from endpoint', async () => {
      let requestUrl = '';
      globalThis.fetch = async (url: string | URL | Request) => {
        requestUrl = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
        return okResponse(makeSSE('ok'));
      };

      const client = new LlamaCppClient({ endpoint: 'http://myhost:9090/' });
      await collectChunks(client.sendQuery('Hi', '/tmp/test'));

      expect(requestUrl).toBe('http://myhost:9090/v1/chat/completions');
    });
  });

  describe('getType()', () => {
    it('returns llamacpp', () => {
      const client = new LlamaCppClient();
      expect(client.getType()).toBe('llamacpp');
    });
  });

  describe('no API key', () => {
    it('constructs without error when no API key is set', () => {
      const client = new LlamaCppClient();
      expect(client.getType()).toBe('llamacpp');
    });

    it('does not send Authorization header', async () => {
      let headers: Record<string, string> = {};
      globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
        headers = Object.fromEntries(
          Object.entries(init?.headers ?? {}).map(([k, v]) => [k, String(v)])
        );
        return okResponse(makeSSE('ok'));
      };

      const client = new LlamaCppClient();
      await collectChunks(client.sendQuery('Hi', '/tmp/test'));

      expect(headers['Authorization']).toBeUndefined();
    });
  });

  describe('model field', () => {
    it('sends configured model in request body', async () => {
      let body: Record<string, unknown> | null = null;
      globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(init?.body as string) as Record<string, unknown>;
        return okResponse(makeSSE('ok'));
      };

      const client = new LlamaCppClient({ model: 'my-local-model' });
      await collectChunks(client.sendQuery('Hi', '/tmp/test'));

      expect(body!.model).toBe('my-local-model');
    });

    it('defaults model to "local" when not specified', async () => {
      let body: Record<string, unknown> | null = null;
      globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(init?.body as string) as Record<string, unknown>;
        return okResponse(makeSSE('ok'));
      };

      const client = new LlamaCppClient();
      await collectChunks(client.sendQuery('Hi', '/tmp/test'));

      expect(body!.model).toBe('local');
    });
  });

  describe('GBNF grammar for output_format', () => {
    it('sends grammar field instead of response_format', async () => {
      let body: Record<string, unknown> | null = null;
      globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(init?.body as string) as Record<string, unknown>;
        return okResponse(makeSSE('{"result":"ok"}'));
      };

      const client = new LlamaCppClient();
      await collectChunks(
        client.sendQuery('Hi', '/tmp/test', undefined, {
          outputFormat: {
            schema: {
              type: 'object',
              properties: {
                result: { type: 'string' },
              },
              required: ['result'],
            },
          },
        })
      );

      // Should have grammar field, not response_format
      expect(body!.grammar).toBeDefined();
      expect(typeof body!.grammar).toBe('string');
      expect(body!.response_format).toBeUndefined();

      // Grammar should contain GBNF rules
      const grammar = body!.grammar as string;
      expect(grammar).toContain('root ::=');
      expect(grammar).toContain('string ::=');
    });

    it('does not send grammar when no output_format', async () => {
      let body: Record<string, unknown> | null = null;
      globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(init?.body as string) as Record<string, unknown>;
        return okResponse(makeSSE('ok'));
      };

      const client = new LlamaCppClient();
      await collectChunks(client.sendQuery('Hi', '/tmp/test'));

      expect(body!.grammar).toBeUndefined();
      expect(body!.response_format).toBeUndefined();
    });
  });

  describe('connection error classification', () => {
    it('throws LlamaCppEndpointUnreachableError on ECONNREFUSED', async () => {
      globalThis.fetch = async () => {
        throw new TypeError('fetch failed: ECONNREFUSED');
      };

      const client = new LlamaCppClient({ endpoint: 'http://localhost:9999' });

      try {
        await collectChunks(client.sendQuery('Hi', '/tmp/test'));
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(LlamaCppEndpointUnreachableError);
        const err = e as LlamaCppEndpointUnreachableError;
        expect(err.endpoint).toBe('http://localhost:9999');
        expect(err.message).toContain('http://localhost:9999');
        expect(err.message).toContain('llama-server');
      }
    });

    it('throws LlamaCppEndpointUnreachableError on ENOTFOUND', async () => {
      globalThis.fetch = async () => {
        throw new TypeError('fetch failed: ENOTFOUND');
      };

      const client = new LlamaCppClient({ endpoint: 'http://nonexistent:8080' });

      try {
        await collectChunks(client.sendQuery('Hi', '/tmp/test'));
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(LlamaCppEndpointUnreachableError);
      }
    });

    it('re-throws non-connection errors without wrapping', async () => {
      globalThis.fetch = async () => {
        return new Response('Internal Server Error', { status: 500 });
      };

      const client = new LlamaCppClient();

      try {
        await collectChunks(client.sendQuery('Hi', '/tmp/test'));
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).not.toBeInstanceOf(LlamaCppEndpointUnreachableError);
      }
    });
  });

  describe('fromConfig()', () => {
    it('creates client from LlamaCppAssistantDefaults', () => {
      const client = LlamaCppClient.fromConfig({
        endpoint: 'http://gpu-server:8080',
        model: 'llama-3.1-70b',
      });
      expect(client.getType()).toBe('llamacpp');
    });

    it('uses defaults when config fields are empty', () => {
      const client = LlamaCppClient.fromConfig({});
      expect(client.getType()).toBe('llamacpp');
    });
  });

  describe('streaming response', () => {
    it('yields assistant and result chunks', async () => {
      globalThis.fetch = async () => okResponse(makeSSE('Hello from Llama'));

      const client = new LlamaCppClient();
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
  });
});
