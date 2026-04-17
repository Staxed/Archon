import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { buildDismissalKey } from './PreflightBanner';
import type { PreflightCheck } from './PreflightBanner';

// ---------------------------------------------------------------------------
// Tests: buildDismissalKey (pure function — banner state logic)
// ---------------------------------------------------------------------------

describe('buildDismissalKey', () => {
  test('returns key with missing dependency names sorted', () => {
    const checks: PreflightCheck[] = [
      { name: 'tmux', present: true },
      { name: 'aichat', present: false, installCommand: 'cargo install aichat' },
      { name: 'typescript-language-server', present: false, installCommand: 'npm i -g ...' },
      { name: 'archon', present: true, version: '0.2.0' },
    ];

    const key = buildDismissalKey(checks);
    expect(key).toBe('preflight-dismissed:aichat,typescript-language-server');
  });

  test('includes warning-only checks in key', () => {
    const checks: PreflightCheck[] = [
      { name: 'tmux', present: true, version: '2.9', warning: 'below 3.0' },
      { name: 'aichat', present: true },
      { name: 'typescript-language-server', present: true },
      { name: 'archon', present: true },
    ];

    const key = buildDismissalKey(checks);
    expect(key).toBe('preflight-dismissed:tmux');
  });

  test('returns empty issues key when all pass', () => {
    const checks: PreflightCheck[] = [
      { name: 'tmux', present: true, version: '3.4' },
      { name: 'aichat', present: true },
      { name: 'archon', present: true },
    ];

    const key = buildDismissalKey(checks);
    expect(key).toBe('preflight-dismissed:');
  });

  test('sorts names alphabetically for stable keys', () => {
    const checks: PreflightCheck[] = [
      { name: 'zsh', present: false },
      { name: 'aichat', present: false },
      { name: 'node', present: false },
    ];

    const key = buildDismissalKey(checks);
    expect(key).toBe('preflight-dismissed:aichat,node,zsh');
  });

  test('different missing deps produce different keys', () => {
    const checks1: PreflightCheck[] = [
      { name: 'tmux', present: false },
      { name: 'aichat', present: true },
    ];
    const checks2: PreflightCheck[] = [
      { name: 'tmux', present: true },
      { name: 'aichat', present: false },
    ];

    const key1 = buildDismissalKey(checks1);
    const key2 = buildDismissalKey(checks2);
    expect(key1).not.toBe(key2);
  });
});

// ---------------------------------------------------------------------------
// Tests: localStorage-based persistence (mocked)
// ---------------------------------------------------------------------------

describe('banner dismissal persistence', () => {
  const store: Record<string, string> = {};

  beforeEach(() => {
    // Mock localStorage for test environment
    Object.keys(store).forEach(k => delete store[k]);

    globalThis.localStorage = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
      removeItem: (key: string) => {
        delete store[key];
      },
      clear: () => {
        Object.keys(store).forEach(k => delete store[k]);
      },
      length: 0,
      key: () => null,
    };
  });

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete (globalThis as Record<string, unknown>)['localStorage'];
  });

  test('isDismissed returns false when not persisted', async () => {
    const { isDismissed } = await import('./PreflightBanner');
    expect(isDismissed('preflight-dismissed:tmux')).toBe(false);
  });

  test('persistDismissal + isDismissed round-trip', async () => {
    const { isDismissed, persistDismissal } = await import('./PreflightBanner');
    const key = 'preflight-dismissed:aichat';

    expect(isDismissed(key)).toBe(false);
    persistDismissal(key);
    expect(isDismissed(key)).toBe(true);
  });

  test('different keys are independent', async () => {
    const { isDismissed, persistDismissal } = await import('./PreflightBanner');
    persistDismissal('preflight-dismissed:aichat');

    expect(isDismissed('preflight-dismissed:aichat')).toBe(true);
    expect(isDismissed('preflight-dismissed:tmux')).toBe(false);
  });
});
