import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { getAssistantClient } from './factory';

describe('factory', () => {
  describe('getAssistantClient', () => {
    test('returns ClaudeClient for claude type', () => {
      const client = getAssistantClient('claude');

      expect(client).toBeDefined();
      expect(client.getType()).toBe('claude');
      expect(typeof client.sendQuery).toBe('function');
    });

    test('returns CodexClient for codex type', () => {
      const client = getAssistantClient('codex');

      expect(client).toBeDefined();
      expect(client.getType()).toBe('codex');
      expect(typeof client.sendQuery).toBe('function');
    });

    describe('openrouter', () => {
      const originalEnv = process.env.OPENROUTER_API_KEY;

      beforeEach(() => {
        process.env.OPENROUTER_API_KEY = 'test-key-for-factory';
      });

      afterEach(() => {
        if (originalEnv !== undefined) {
          process.env.OPENROUTER_API_KEY = originalEnv;
        } else {
          delete process.env.OPENROUTER_API_KEY;
        }
      });

      test('returns OpenRouterClient for openrouter type', () => {
        const client = getAssistantClient('openrouter');

        expect(client).toBeDefined();
        expect(client.getType()).toBe('openrouter');
        expect(typeof client.sendQuery).toBe('function');
      });
    });

    test('returns LlamaCppClient for llamacpp type', () => {
      const client = getAssistantClient('llamacpp');

      expect(client).toBeDefined();
      expect(client.getType()).toBe('llamacpp');
      expect(typeof client.sendQuery).toBe('function');
    });

    test('throws error for unknown type', () => {
      expect(() => getAssistantClient('unknown')).toThrow(
        "Unknown assistant type: unknown. Supported types: 'claude', 'codex', 'openrouter', 'llamacpp'"
      );
    });

    test('throws error for empty string', () => {
      expect(() => getAssistantClient('')).toThrow(
        "Unknown assistant type: . Supported types: 'claude', 'codex', 'openrouter', 'llamacpp'"
      );
    });

    test('is case sensitive - Claude throws', () => {
      expect(() => getAssistantClient('Claude')).toThrow(
        "Unknown assistant type: Claude. Supported types: 'claude', 'codex', 'openrouter', 'llamacpp'"
      );
    });

    test('each call returns new instance', () => {
      const client1 = getAssistantClient('claude');
      const client2 = getAssistantClient('claude');

      // Each call should return a new instance
      expect(client1).not.toBe(client2);
    });
  });
});
