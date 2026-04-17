/**
 * SSH reconnection state machine with exponential backoff.
 *
 * Pure logic — no React dependency. The React component in App.tsx
 * consumes these helpers to drive the banner UI.
 */

/** Backoff intervals in milliseconds: 1s, 2s, 4s, 8s, 16s */
export const BACKOFF_INTERVALS_MS = [1000, 2000, 4000, 8000, 16000] as const;

/** Total backoff time before giving up (~31s) */
export const TOTAL_BACKOFF_MS = BACKOFF_INTERVALS_MS.reduce((a, b) => a + b, 0);

/** Fade-out delay after successful reconnection (ms) */
export const FADE_OUT_DELAY_MS = 2000;

export type ReconnectPhase =
  | 'disconnected' // just detected drop, about to start retrying
  | 'retrying' // auto-retry in progress
  | 'failed' // all auto-retries exhausted
  | 'reconnected' // successfully reconnected, fading out
  | 'hidden'; // banner not visible

export interface ReconnectState {
  phase: ReconnectPhase;
  /** Current retry attempt index (0-based into BACKOFF_INTERVALS_MS) */
  retryIndex: number;
}

export function createInitialReconnectState(): ReconnectState {
  return { phase: 'hidden', retryIndex: 0 };
}

/**
 * Get the delay (ms) for the current retry attempt.
 * Returns null if all retries are exhausted.
 */
export function getBackoffDelay(retryIndex: number): number | null {
  if (retryIndex < 0 || retryIndex >= BACKOFF_INTERVALS_MS.length) {
    return null;
  }
  return BACKOFF_INTERVALS_MS[retryIndex];
}

/**
 * Advance the state after a failed retry attempt.
 */
export function advanceRetry(state: ReconnectState): ReconnectState {
  const nextIndex = state.retryIndex + 1;
  if (nextIndex >= BACKOFF_INTERVALS_MS.length) {
    return { phase: 'failed', retryIndex: nextIndex };
  }
  return { phase: 'retrying', retryIndex: nextIndex };
}

/**
 * Transition to the disconnected/retrying phase (tunnel just dropped).
 */
export function onTunnelDrop(): ReconnectState {
  return { phase: 'retrying', retryIndex: 0 };
}

/**
 * Reset retry counter (manual Reconnect button pressed).
 */
export function onManualReconnect(): ReconnectState {
  return { phase: 'retrying', retryIndex: 0 };
}

/**
 * Transition to reconnected phase (will fade out).
 */
export function onReconnected(): ReconnectState {
  return { phase: 'reconnected', retryIndex: 0 };
}

/**
 * Transition to hidden (after fade-out completes).
 */
export function onFadeOutComplete(): ReconnectState {
  return { phase: 'hidden', retryIndex: 0 };
}

/**
 * Get the user-facing banner message for the current state.
 */
export function getBannerMessage(state: ReconnectState): string {
  switch (state.phase) {
    case 'retrying':
      return 'SSH connection lost \u2014 reconnecting\u2026';
    case 'failed':
      return 'Reconnection failed \u2014 click Reconnect to try again';
    case 'reconnected':
      return 'SSH connection restored';
    case 'disconnected':
      return 'SSH connection lost \u2014 reconnecting\u2026';
    case 'hidden':
      return '';
  }
}

/**
 * Whether the banner should be visible.
 */
export function isBannerVisible(state: ReconnectState): boolean {
  return state.phase !== 'hidden';
}

/**
 * Whether auto-retry is active (should schedule next attempt).
 */
export function isAutoRetrying(state: ReconnectState): boolean {
  return state.phase === 'retrying';
}
