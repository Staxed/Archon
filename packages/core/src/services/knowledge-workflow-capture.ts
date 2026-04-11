/**
 * Knowledge workflow capture — subscribes to workflow_completed events
 * and triggers knowledge capture with JSONL log context.
 *
 * Must be initialized once (call subscribeToWorkflowCapture()) at server startup.
 * Fire-and-forget: errors are logged but never surface to the caller.
 */
import { readFile } from 'node:fs/promises';
import {
  getWorkflowEventEmitter,
  type WorkflowEmitterEvent,
} from '@archon/workflows/event-emitter';
import { createLogger, getRunLogPath, parseOwnerRepo } from '@archon/paths';
import * as codebaseDb from '../db/codebases';
import * as workflowDb from '../db/workflows';
import { captureKnowledge } from './knowledge-capture';

/** Lazy-initialized logger */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('knowledge.workflow-capture');
  return cachedLog;
}

/** Track whether subscription is active (prevent double-subscribe) */
let subscribed = false;
/** Active unsubscribe function */
let activeUnsubscribe: (() => void) | null = null;

/**
 * Subscribe to workflow_completed events and trigger knowledge capture.
 * Safe to call multiple times — only subscribes once.
 * Returns an unsubscribe function.
 */
export function subscribeToWorkflowCapture(): () => void {
  if (subscribed) {
    // Already subscribed — return no-op unsubscribe
    return () => {
      /* noop */
    };
  }

  const emitter = getWorkflowEventEmitter();
  const unsubscribe = emitter.subscribe((event: WorkflowEmitterEvent) => {
    if (event.type !== 'workflow_completed') return;

    const conversationId = emitter.getConversationId(event.runId);
    if (!conversationId) {
      getLog().debug({ runId: event.runId }, 'knowledge.workflow_capture_skipped_no_conversation');
      return;
    }

    // Fire-and-forget
    void handleWorkflowCompleted(event.runId, conversationId).catch(err => {
      getLog().error(
        {
          runId: event.runId,
          conversationId,
          error: (err as Error).message,
          err,
        },
        'knowledge.workflow_capture_failed'
      );
    });
  });

  subscribed = true;
  activeUnsubscribe = unsubscribe;

  return () => {
    unsubscribe();
    subscribed = false;
    activeUnsubscribe = null;
  };
}

/**
 * Reset internal state for testing.
 */
export function resetWorkflowCaptureSubscription(): void {
  if (activeUnsubscribe) {
    activeUnsubscribe();
  }
  subscribed = false;
  activeUnsubscribe = null;
}

/**
 * Handle a completed workflow — look up codebase, read JSONL logs, trigger capture.
 */
async function handleWorkflowCompleted(runId: string, conversationId: string): Promise<void> {
  const log = getLog();

  // Look up workflow run to get codebase_id
  const run = await workflowDb.getWorkflowRun(runId);
  if (!run?.codebase_id) {
    log.debug({ runId, conversationId }, 'knowledge.workflow_capture_skipped_no_codebase');
    return;
  }

  // Look up codebase to get owner/repo
  const codebase = await codebaseDb.getCodebase(run.codebase_id);
  if (!codebase) {
    log.debug(
      { runId, codebaseId: run.codebase_id },
      'knowledge.workflow_capture_skipped_codebase_not_found'
    );
    return;
  }

  const parsed = parseOwnerRepo(codebase.name);
  if (!parsed) {
    log.debug(
      { runId, codebaseName: codebase.name },
      'knowledge.workflow_capture_skipped_no_owner_repo'
    );
    return;
  }

  // Read JSONL workflow logs as additional context
  const workflowLogContent = await readWorkflowLogs(parsed.owner, parsed.repo, runId);

  log.info(
    { runId, conversationId, owner: parsed.owner, repo: parsed.repo },
    'knowledge.workflow_capture_started'
  );

  await captureKnowledge(conversationId, parsed.owner, parsed.repo, undefined, workflowLogContent);
}

/**
 * Read and format JSONL workflow logs for use as additional capture context.
 * Returns empty string if logs don't exist or can't be read.
 */
async function readWorkflowLogs(owner: string, repo: string, runId: string): Promise<string> {
  try {
    const logPath = getRunLogPath(owner, repo, runId);
    const content = await readFile(logPath, 'utf-8');

    // Parse JSONL and extract relevant events (assistant messages, tool calls)
    const lines = content.trim().split('\n');
    const relevant: string[] = [];

    for (const line of lines) {
      try {
        const event = JSON.parse(line) as {
          type: string;
          content?: string;
          tool_name?: string;
          workflow_name?: string;
          step?: string;
        };
        if (event.type === 'assistant' && event.content) {
          relevant.push(`[ASSISTANT${event.step ? ` (${event.step})` : ''}]: ${event.content}`);
        } else if (event.type === 'tool' && event.tool_name) {
          relevant.push(`[TOOL: ${event.tool_name}]`);
        } else if (event.type === 'workflow_start' && event.workflow_name) {
          relevant.push(`[WORKFLOW: ${event.workflow_name}]`);
        }
      } catch {
        // Skip malformed JSONL lines
      }
    }

    if (relevant.length === 0) return '';

    return '\n\n---\n\nWORKFLOW EXECUTION LOG:\n' + relevant.join('\n');
  } catch {
    // Log file doesn't exist or can't be read — not an error
    return '';
  }
}
