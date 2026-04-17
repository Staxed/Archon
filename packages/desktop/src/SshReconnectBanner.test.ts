import { describe, expect, test } from 'bun:test';
import {
  BACKOFF_INTERVALS_MS,
  TOTAL_BACKOFF_MS,
  FADE_OUT_DELAY_MS,
  createInitialReconnectState,
  getBackoffDelay,
  advanceRetry,
  onTunnelDrop,
  onManualReconnect,
  onReconnected,
  onFadeOutComplete,
  getBannerMessage,
  isBannerVisible,
  isAutoRetrying,
} from './SshReconnectBanner';
import type { ReconnectState } from './SshReconnectBanner';

describe('BACKOFF_INTERVALS_MS', () => {
  test('contains exactly 5 intervals', () => {
    expect(BACKOFF_INTERVALS_MS).toHaveLength(5);
  });

  test('intervals are 1s, 2s, 4s, 8s, 16s', () => {
    expect([...BACKOFF_INTERVALS_MS]).toEqual([1000, 2000, 4000, 8000, 16000]);
  });

  test('total backoff is ~31s', () => {
    expect(TOTAL_BACKOFF_MS).toBe(31000);
  });

  test('fade-out delay is 2s', () => {
    expect(FADE_OUT_DELAY_MS).toBe(2000);
  });
});

describe('createInitialReconnectState', () => {
  test('starts hidden with retryIndex 0', () => {
    const state = createInitialReconnectState();
    expect(state.phase).toBe('hidden');
    expect(state.retryIndex).toBe(0);
  });
});

describe('getBackoffDelay', () => {
  test('returns correct delay for each index', () => {
    expect(getBackoffDelay(0)).toBe(1000);
    expect(getBackoffDelay(1)).toBe(2000);
    expect(getBackoffDelay(2)).toBe(4000);
    expect(getBackoffDelay(3)).toBe(8000);
    expect(getBackoffDelay(4)).toBe(16000);
  });

  test('returns null for out-of-range index', () => {
    expect(getBackoffDelay(5)).toBeNull();
    expect(getBackoffDelay(-1)).toBeNull();
    expect(getBackoffDelay(100)).toBeNull();
  });
});

describe('advanceRetry', () => {
  test('advances retryIndex and stays retrying', () => {
    const state: ReconnectState = { phase: 'retrying', retryIndex: 0 };
    const next = advanceRetry(state);
    expect(next.phase).toBe('retrying');
    expect(next.retryIndex).toBe(1);
  });

  test('advances through all retries', () => {
    let state: ReconnectState = { phase: 'retrying', retryIndex: 0 };
    // Advance through indices 0..3 (retrying)
    for (let i = 0; i < 4; i++) {
      state = advanceRetry(state);
      expect(state.phase).toBe('retrying');
      expect(state.retryIndex).toBe(i + 1);
    }
    // Last advance (index 4 -> 5) transitions to failed
    state = advanceRetry(state);
    expect(state.phase).toBe('failed');
    expect(state.retryIndex).toBe(5);
  });

  test('transitions to failed when retries exhausted', () => {
    const state: ReconnectState = { phase: 'retrying', retryIndex: 4 };
    const next = advanceRetry(state);
    expect(next.phase).toBe('failed');
    expect(next.retryIndex).toBe(5);
  });
});

describe('onTunnelDrop', () => {
  test('transitions to retrying with index 0', () => {
    const state = onTunnelDrop();
    expect(state.phase).toBe('retrying');
    expect(state.retryIndex).toBe(0);
  });
});

describe('onManualReconnect', () => {
  test('resets to retrying with index 0', () => {
    const state = onManualReconnect();
    expect(state.phase).toBe('retrying');
    expect(state.retryIndex).toBe(0);
  });

  test('resets even from failed state', () => {
    // Simulates: user clicks Reconnect after all retries failed
    const state = onManualReconnect();
    expect(state.phase).toBe('retrying');
    expect(state.retryIndex).toBe(0);
  });
});

describe('onReconnected', () => {
  test('transitions to reconnected phase', () => {
    const state = onReconnected();
    expect(state.phase).toBe('reconnected');
    expect(state.retryIndex).toBe(0);
  });
});

describe('onFadeOutComplete', () => {
  test('transitions to hidden', () => {
    const state = onFadeOutComplete();
    expect(state.phase).toBe('hidden');
    expect(state.retryIndex).toBe(0);
  });
});

describe('getBannerMessage', () => {
  test('retrying shows reconnecting message', () => {
    expect(getBannerMessage({ phase: 'retrying', retryIndex: 0 })).toBe(
      'SSH connection lost \u2014 reconnecting\u2026'
    );
  });

  test('failed shows failure message', () => {
    expect(getBannerMessage({ phase: 'failed', retryIndex: 5 })).toBe(
      'Reconnection failed \u2014 click Reconnect to try again'
    );
  });

  test('reconnected shows restored message', () => {
    expect(getBannerMessage({ phase: 'reconnected', retryIndex: 0 })).toBe(
      'SSH connection restored'
    );
  });

  test('hidden returns empty string', () => {
    expect(getBannerMessage({ phase: 'hidden', retryIndex: 0 })).toBe('');
  });

  test('disconnected shows reconnecting message', () => {
    expect(getBannerMessage({ phase: 'disconnected', retryIndex: 0 })).toBe(
      'SSH connection lost \u2014 reconnecting\u2026'
    );
  });
});

describe('isBannerVisible', () => {
  test('visible during retrying', () => {
    expect(isBannerVisible({ phase: 'retrying', retryIndex: 0 })).toBe(true);
  });

  test('visible during failed', () => {
    expect(isBannerVisible({ phase: 'failed', retryIndex: 5 })).toBe(true);
  });

  test('visible during reconnected', () => {
    expect(isBannerVisible({ phase: 'reconnected', retryIndex: 0 })).toBe(true);
  });

  test('not visible when hidden', () => {
    expect(isBannerVisible({ phase: 'hidden', retryIndex: 0 })).toBe(false);
  });
});

describe('isAutoRetrying', () => {
  test('true during retrying', () => {
    expect(isAutoRetrying({ phase: 'retrying', retryIndex: 0 })).toBe(true);
  });

  test('false during failed', () => {
    expect(isAutoRetrying({ phase: 'failed', retryIndex: 5 })).toBe(false);
  });

  test('false during reconnected', () => {
    expect(isAutoRetrying({ phase: 'reconnected', retryIndex: 0 })).toBe(false);
  });

  test('false when hidden', () => {
    expect(isAutoRetrying({ phase: 'hidden', retryIndex: 0 })).toBe(false);
  });
});

describe('full reconnection lifecycle', () => {
  test('tunnel drop → retries → failure → manual → success → fade', () => {
    // 1. Tunnel drops
    let state = onTunnelDrop();
    expect(state.phase).toBe('retrying');
    expect(isBannerVisible(state)).toBe(true);

    // 2. Auto-retry through all 5 attempts
    for (let i = 0; i < 5; i++) {
      const delay = getBackoffDelay(state.retryIndex);
      expect(delay).not.toBeNull();
      state = advanceRetry(state);
    }
    expect(state.phase).toBe('failed');
    expect(isAutoRetrying(state)).toBe(false);
    expect(isBannerVisible(state)).toBe(true);

    // 3. Manual reconnect resets
    state = onManualReconnect();
    expect(state.phase).toBe('retrying');
    expect(state.retryIndex).toBe(0);
    expect(isAutoRetrying(state)).toBe(true);

    // 4. This time reconnection succeeds
    state = onReconnected();
    expect(state.phase).toBe('reconnected');
    expect(isBannerVisible(state)).toBe(true);
    expect(getBannerMessage(state)).toBe('SSH connection restored');

    // 5. Fade out completes
    state = onFadeOutComplete();
    expect(state.phase).toBe('hidden');
    expect(isBannerVisible(state)).toBe(false);
  });

  test('tunnel drop → immediate reconnection success', () => {
    let state = onTunnelDrop();
    expect(state.phase).toBe('retrying');

    // First attempt succeeds immediately
    state = onReconnected();
    expect(state.phase).toBe('reconnected');
    expect(getBannerMessage(state)).toBe('SSH connection restored');

    state = onFadeOutComplete();
    expect(state.phase).toBe('hidden');
  });
});
