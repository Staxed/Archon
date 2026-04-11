/**
 * Knowledge flush scheduler — debounced per-project flush triggers.
 *
 * After capture completes, schedules a flush with a configurable debounce.
 * If another capture fires within the debounce window, the timer resets.
 * Timers are in-memory only (not persisted across restarts).
 */
import { createLogger } from '@archon/paths';
import { loadConfig } from '../config/config-loader';
import { flushKnowledge } from './knowledge-flush';

/** Lazy-initialized logger */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('knowledge.scheduler');
  return cachedLog;
}

/** Per-project debounce timers. Key is "owner/repo". */
const flushTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Schedule a debounced flush for a project.
 * If a flush is already scheduled, the timer resets.
 *
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param debounceMinutes - Override debounce interval (uses config default if omitted)
 */
export async function scheduleFlush(
  owner: string,
  repo: string,
  debounceMinutes?: number
): Promise<void> {
  const log = getLog();
  const projectKey = `${owner}/${repo}`;

  // Resolve debounce interval
  let minutes = debounceMinutes;
  if (minutes === undefined) {
    const config = await loadConfig();
    minutes = config.knowledge.flushDebounceMinutes;
  }

  // Cancel existing timer for this project (debounce reset)
  const existing = flushTimers.get(projectKey);
  if (existing) {
    clearTimeout(existing);
    log.debug({ projectKey }, 'knowledge.flush_debounce_reset');
  }

  const delayMs = minutes * 60 * 1000;

  log.info({ projectKey, debounceMinutes: minutes }, 'knowledge.flush_scheduled');

  const timer = setTimeout(() => {
    flushTimers.delete(projectKey);
    log.info({ projectKey }, 'knowledge.flush_debounce_fired');

    void flushKnowledge(owner, repo).catch(err => {
      log.error(
        { projectKey, error: (err as Error).message, err },
        'knowledge.flush_scheduled_failed'
      );
    });
  }, delayMs);

  // Prevent the timer from keeping the process alive
  if (typeof timer === 'object' && 'unref' in timer) {
    timer.unref();
  }

  flushTimers.set(projectKey, timer);
}

/**
 * Cancel a scheduled flush for a project.
 * Returns true if a timer was cancelled, false if none was pending.
 */
export function cancelScheduledFlush(owner: string, repo: string): boolean {
  const projectKey = `${owner}/${repo}`;
  const timer = flushTimers.get(projectKey);
  if (timer) {
    clearTimeout(timer);
    flushTimers.delete(projectKey);
    getLog().debug({ projectKey }, 'knowledge.flush_schedule_cancelled');
    return true;
  }
  return false;
}

/**
 * Check if a flush is scheduled for a project.
 */
export function isFlushScheduled(owner: string, repo: string): boolean {
  return flushTimers.has(`${owner}/${repo}`);
}

/**
 * Cancel all scheduled flushes. Used for graceful shutdown.
 */
export function cancelAllScheduledFlushes(): void {
  for (const [key, timer] of flushTimers) {
    clearTimeout(timer);
    getLog().debug({ projectKey: key }, 'knowledge.flush_schedule_cancelled');
  }
  flushTimers.clear();
}
