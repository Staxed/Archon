import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';

// Track flush calls
let flushCalls: { owner: string; repo: string }[] = [];
let loadConfigCalls = 0;
const DEFAULT_CONFIG = {
  knowledge: {
    enabled: true,
    captureModel: 'haiku',
    compileModel: 'sonnet',
    flushDebounceMinutes: 10,
    domains: ['architecture', 'decisions', 'patterns', 'lessons', 'connections'],
  },
};

mock.module('@archon/paths', () => ({
  createLogger: () => ({
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

mock.module('../config/config-loader', () => ({
  loadConfig: async () => {
    loadConfigCalls++;
    return DEFAULT_CONFIG;
  },
}));

mock.module('./knowledge-flush', () => ({
  flushKnowledge: async (owner: string, repo: string) => {
    flushCalls.push({ owner, repo });
    return {
      articlesCreated: 0,
      articlesUpdated: 0,
      articlesStale: 0,
      domainsCreated: [],
      logsProcessed: [],
      skipped: false,
    };
  },
}));

const { scheduleFlush, cancelScheduledFlush, isFlushScheduled, cancelAllScheduledFlushes } =
  await import('./knowledge-scheduler');

describe('knowledge-scheduler', () => {
  beforeEach(() => {
    cancelAllScheduledFlushes();
    flushCalls = [];
    loadConfigCalls = 0;
  });

  afterEach(() => {
    cancelAllScheduledFlushes();
  });

  it('should schedule a flush that fires after the debounce period', async () => {
    // Use a very short debounce for testing (0.001 minutes = 60ms)
    await scheduleFlush('acme', 'widget', 0.001);

    expect(isFlushScheduled('acme', 'widget')).toBe(true);
    expect(flushCalls).toHaveLength(0);

    // Wait for the timer to fire
    await new Promise(resolve => setTimeout(resolve, 120));

    expect(flushCalls).toHaveLength(1);
    expect(flushCalls[0]).toEqual({ owner: 'acme', repo: 'widget' });
    expect(isFlushScheduled('acme', 'widget')).toBe(false);
  });

  it('should reset the timer if scheduleFlush is called again (debounce)', async () => {
    await scheduleFlush('acme', 'widget', 0.002); // ~120ms

    // Wait 60ms then reschedule
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(flushCalls).toHaveLength(0);

    await scheduleFlush('acme', 'widget', 0.002); // reset timer

    // Wait 60ms more — original timer would have fired by now
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(flushCalls).toHaveLength(0); // Still no flush — timer was reset

    // Wait for the new timer to fire
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(flushCalls).toHaveLength(1);
  });

  it('should use per-project timers (different projects are independent)', async () => {
    await scheduleFlush('acme', 'widget', 0.001);
    await scheduleFlush('acme', 'other', 0.001);

    expect(isFlushScheduled('acme', 'widget')).toBe(true);
    expect(isFlushScheduled('acme', 'other')).toBe(true);

    await new Promise(resolve => setTimeout(resolve, 120));

    expect(flushCalls).toHaveLength(2);
    const projects = flushCalls.map(c => `${c.owner}/${c.repo}`).sort();
    expect(projects).toEqual(['acme/other', 'acme/widget']);
  });

  it('should load config for debounce minutes when not provided', async () => {
    // Don't pass debounceMinutes — should load from config
    await scheduleFlush('acme', 'widget');

    expect(loadConfigCalls).toBe(1);
    expect(isFlushScheduled('acme', 'widget')).toBe(true);

    // Cancel to avoid waiting for the 10-minute timer
    cancelScheduledFlush('acme', 'widget');
  });

  it('should cancel a scheduled flush', async () => {
    await scheduleFlush('acme', 'widget', 0.001);
    expect(isFlushScheduled('acme', 'widget')).toBe(true);

    const cancelled = cancelScheduledFlush('acme', 'widget');
    expect(cancelled).toBe(true);
    expect(isFlushScheduled('acme', 'widget')).toBe(false);

    await new Promise(resolve => setTimeout(resolve, 120));
    expect(flushCalls).toHaveLength(0);
  });

  it('should return false when cancelling a non-existent schedule', () => {
    const cancelled = cancelScheduledFlush('acme', 'nonexistent');
    expect(cancelled).toBe(false);
  });

  it('should cancel all scheduled flushes', async () => {
    await scheduleFlush('acme', 'widget', 0.001);
    await scheduleFlush('acme', 'other', 0.001);

    cancelAllScheduledFlushes();

    expect(isFlushScheduled('acme', 'widget')).toBe(false);
    expect(isFlushScheduled('acme', 'other')).toBe(false);

    await new Promise(resolve => setTimeout(resolve, 120));
    expect(flushCalls).toHaveLength(0);
  });
});
