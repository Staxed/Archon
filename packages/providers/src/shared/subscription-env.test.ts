import { describe, expect, test } from 'bun:test';
import {
  buildSubscriptionEnv,
  isStrippedSubscriptionEnvKey,
  strippedKeysIn,
} from './subscription-env';

describe('subscription env', () => {
  test('strips cloud-provider switches and credentials, vendor keys and any *_API_KEY', () => {
    for (const key of [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'ANTHROPIC_BEDROCK_BASE_URL',
      'ANTHROPIC_VERTEX_PROJECT_ID',
      'ANTHROPIC_VERTEX_BASE_URL',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'AWS_PROFILE',
      'AWS_BEARER_TOKEN_BEDROCK',
      'AZURE_OPENAI_API_KEY',
      'AZURE_SPEECH_KEY',
      'GROQ_API_KEY',
      'MISTRAL_API_KEY',
      'DEEPSEEK_API_KEY',
      'TOGETHER_API_KEY',
      'FIREWORKS_API_KEY',
      'PERPLEXITY_API_KEY',
      'HF_TOKEN',
      'SOME_NEW_VENDOR_API_KEY',
    ]) {
      expect(isStrippedSubscriptionEnvKey(key)).toBe(true);
    }
  });

  test('keeps the subscription login and ordinary variables', () => {
    for (const key of ['CLAUDE_CODE_OAUTH_TOKEN', 'PATH', 'HOME', 'GITHUB_TOKEN', 'API_KEYS_DIR']) {
      expect(isStrippedSubscriptionEnvKey(key)).toBe(false);
    }
  });

  test('buildSubscriptionEnv drops stripped keys from every layer; strippedKeysIn names them', () => {
    const host = { PATH: '/bin', AWS_PROFILE: 'prod' };
    const request = { GROQ_API_KEY: 'x', CLAUDE_CODE_USE_BEDROCK: '1', FOO: 'bar' };
    expect(buildSubscriptionEnv(host, request)).toEqual({ PATH: '/bin', FOO: 'bar' });
    expect(strippedKeysIn(request).sort()).toEqual(['CLAUDE_CODE_USE_BEDROCK', 'GROQ_API_KEY']);
  });
});
