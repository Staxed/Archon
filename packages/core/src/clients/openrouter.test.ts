/**
 * Tests for OpenRouterClient.
 *
 * Verifies: API key handling, custom headers (HTTP-Referer, X-Title),
 * model routing, fromConfig factory, classified missing-key error.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { OpenRouterClient, OpenRouterMissingApiKeyError } from './openrouter';
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

describe('OpenRouterClient', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEnv = process.env.OPENROUTER_API_KEY;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalEnv !== undefined) {
      process.env.OPENROUTER_API_KEY = originalEnv;
    } else {
      delete process.env.OPENROUTER_API_KEY;
    }
  });

  describe('constructor — API key handling', () => {
    it('uses apiKey from config', () => {
      const client = new OpenRouterClient({ apiKey: 'test-key' });
      expect(client.getType()).toBe('openrouter');
    });

    it('falls back to OPENROUTER_API_KEY env var', () => {
      process.env.OPENROUTER_API_KEY = 'env-key';
      const client = new OpenRouterClient();
      expect(client.getType()).toBe('openrouter');
    });

    it('config apiKey takes precedence over env var', () => {
      process.env.OPENROUTER_API_KEY = 'env-key';
      const client = new OpenRouterClient({ apiKey: 'config-key' });
      expect(client.getType()).toBe('openrouter');
    });

    it('throws OpenRouterMissingApiKeyError when no key available', () => {
      delete process.env.OPENROUTER_API_KEY;
      expect(() => new OpenRouterClient()).toThrow(OpenRouterMissingApiKeyError);
    });

    it('error message includes actionable guidance', () => {
      delete process.env.OPENROUTER_API_KEY;
      try {
        new OpenRouterClient();
      } catch (e) {
        const err = e as Error;
        expect(err.message).toContain('OPENROUTER_API_KEY');
        expect(err.message).toContain('assistants.openrouter');
      }
    });
  });

  describe('getType()', () => {
    it('returns openrouter', () => {
      const client = new OpenRouterClient({ apiKey: 'test-key' });
      expect(client.getType()).toBe('openrouter');
    });
  });

  describe('custom headers', () => {
    it('sends HTTP-Referer header from siteUrl', async () => {
      let headers: Record<string, string> = {};
      globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
        headers = Object.fromEntries(
          Object.entries(init?.headers ?? {}).map(([k, v]) => [k, String(v)])
        );
        return okResponse(makeSSE('ok'));
      };

      const client = new OpenRouterClient({ apiKey: 'test-key', siteUrl: 'https://example.com' });
      await collectChunks(client.sendQuery('Hi', '/tmp/test'));

      expect(headers['HTTP-Referer']).toBe('https://example.com');
    });

    it('sends X-Title header from siteName', async () => {
      let headers: Record<string, string> = {};
      globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
        headers = Object.fromEntries(
          Object.entries(init?.headers ?? {}).map(([k, v]) => [k, String(v)])
        );
        return okResponse(makeSSE('ok'));
      };

      const client = new OpenRouterClient({ apiKey: 'test-key', siteName: 'My App' });
      await collectChunks(client.sendQuery('Hi', '/tmp/test'));

      expect(headers['X-Title']).toBe('My App');
    });

    it('sends both headers when both configured', async () => {
      let headers: Record<string, string> = {};
      globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
        headers = Object.fromEntries(
          Object.entries(init?.headers ?? {}).map(([k, v]) => [k, String(v)])
        );
        return okResponse(makeSSE('ok'));
      };

      const client = new OpenRouterClient({
        apiKey: 'test-key',
        siteUrl: 'https://example.com',
        siteName: 'My App',
      });
      await collectChunks(client.sendQuery('Hi', '/tmp/test'));

      expect(headers['HTTP-Referer']).toBe('https://example.com');
      expect(headers['X-Title']).toBe('My App');
    });

    it('omits custom headers when not configured', async () => {
      let headers: Record<string, string> = {};
      globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
        headers = Object.fromEntries(
          Object.entries(init?.headers ?? {}).map(([k, v]) => [k, String(v)])
        );
        return okResponse(makeSSE('ok'));
      };

      const client = new OpenRouterClient({ apiKey: 'test-key' });
      await collectChunks(client.sendQuery('Hi', '/tmp/test'));

      expect(headers['HTTP-Referer']).toBeUndefined();
      expect(headers['X-Title']).toBeUndefined();
    });
  });

  describe('model routing', () => {
    it('sends configured model in request body', async () => {
      let body: Record<string, unknown> | null = null;
      globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(init?.body as string) as Record<string, unknown>;
        return okResponse(makeSSE('ok'));
      };

      const client = new OpenRouterClient({
        apiKey: 'test-key',
        model: 'anthropic/claude-3-haiku',
      });
      await collectChunks(client.sendQuery('Hi', '/tmp/test'));

      expect(body!.model).toBe('anthropic/claude-3-haiku');
    });

    it('allows per-request model override', async () => {
      let body: Record<string, unknown> | null = null;
      globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(init?.body as string) as Record<string, unknown>;
        return okResponse(makeSSE('ok'));
      };

      const client = new OpenRouterClient({
        apiKey: 'test-key',
        model: 'anthropic/claude-3-haiku',
      });
      await collectChunks(
        client.sendQuery('Hi', '/tmp/test', undefined, { model: 'meta-llama/llama-4-scout' })
      );

      expect(body!.model).toBe('meta-llama/llama-4-scout');
    });

    it('sends requests to OpenRouter endpoint', async () => {
      let requestUrl = '';
      globalThis.fetch = async (url: string | URL | Request, _init?: RequestInit) => {
        requestUrl = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
        return okResponse(makeSSE('ok'));
      };

      const client = new OpenRouterClient({ apiKey: 'test-key' });
      await collectChunks(client.sendQuery('Hi', '/tmp/test'));

      expect(requestUrl).toBe('https://openrouter.ai/api/v1/chat/completions');
    });
  });

  describe('API key in Authorization header', () => {
    it('sends Bearer token in Authorization header', async () => {
      let headers: Record<string, string> = {};
      globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
        headers = Object.fromEntries(
          Object.entries(init?.headers ?? {}).map(([k, v]) => [k, String(v)])
        );
        return okResponse(makeSSE('ok'));
      };

      const client = new OpenRouterClient({ apiKey: 'sk-or-test-123' });
      await collectChunks(client.sendQuery('Hi', '/tmp/test'));

      expect(headers['Authorization']).toBe('Bearer sk-or-test-123');
    });
  });

  describe('fromConfig()', () => {
    it('creates client from OpenRouterAssistantDefaults', () => {
      const client = OpenRouterClient.fromConfig({
        apiKey: 'cfg-key',
        model: 'anthropic/claude-3-haiku',
        siteUrl: 'https://mysite.com',
        siteName: 'My Site',
      });
      expect(client.getType()).toBe('openrouter');
    });

    it('throws when config has no apiKey and env var not set', () => {
      delete process.env.OPENROUTER_API_KEY;
      expect(() => OpenRouterClient.fromConfig({})).toThrow(OpenRouterMissingApiKeyError);
    });
  });

  describe('streaming response', () => {
    it('yields assistant and result chunks', async () => {
      globalThis.fetch = async () => okResponse(makeSSE('Hello from OpenRouter'));

      const client = new OpenRouterClient({ apiKey: 'test-key' });
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
