/**
 * Knowledge capture service — extracts decisions/lessons/patterns from conversation
 * transcripts and appends them to daily log files in the knowledge base.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getProjectKnowledgePath, parseOwnerRepo } from '@archon/paths';
import { createLogger } from '@archon/paths';
import { getAssistantClient } from '../clients/factory';
import * as messageDb from '../db/messages';
import * as codebaseDb from '../db/codebases';
import { loadConfig } from '../config/config-loader';
import { initKnowledgeDir } from './knowledge-init';
import { scheduleFlush } from './knowledge-scheduler';
import type { MergedConfig } from '../config/config-types';
import type { MessageRow } from '../db/messages';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('knowledge.capture');
  return cachedLog;
}

/** Extraction prompt sent to Haiku to extract structured knowledge from a transcript */
const EXTRACTION_PROMPT = `You are a knowledge extraction agent. Analyze the following conversation transcript and extract any valuable knowledge into these categories:

## Decisions
Architectural or design decisions made, with rationale.

## Patterns
Recurring code patterns, conventions, or best practices discovered or applied.

## Lessons
Mistakes encountered, debugging insights, gotchas, or constraints learned.

## Connections
Cross-component dependencies, system relationships, or integration points discovered.

Rules:
- Only include items that would be valuable for a future session on this project
- Skip trivial or obvious items
- Use bullet points with concise descriptions
- Include the "why" for decisions and lessons
- If no items exist for a category, omit that category entirely
- If the transcript contains no extractable knowledge, respond with "No knowledge to extract."

---

TRANSCRIPT:
`;

export interface KnowledgeCaptureReport {
  logFile: string;
  extractedContent: string;
  skipped: boolean;
  skipReason?: string;
}

/**
 * Extract knowledge from a conversation transcript and append to a daily log.
 *
 * @param conversationId - Database UUID of the conversation
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param config - Optional pre-loaded config (avoids redundant loading)
 */
export async function captureKnowledge(
  conversationId: string,
  owner: string,
  repo: string,
  config?: MergedConfig
): Promise<KnowledgeCaptureReport> {
  const log = getLog();

  // Load config if not provided
  const mergedConfig = config ?? (await loadConfig());

  // Check if knowledge capture is enabled
  if (!mergedConfig.knowledge.enabled) {
    log.debug({ conversationId }, 'knowledge.capture_skipped_disabled');
    return {
      logFile: '',
      extractedContent: '',
      skipped: true,
      skipReason: 'Knowledge capture is disabled',
    };
  }

  log.info({ conversationId, owner, repo }, 'knowledge.capture_started');

  try {
    // Read conversation messages
    const messages = await messageDb.listMessages(conversationId);

    if (messages.length === 0) {
      log.info({ conversationId }, 'knowledge.capture_skipped_empty');
      return {
        logFile: '',
        extractedContent: '',
        skipped: true,
        skipReason: 'No messages in conversation',
      };
    }

    // Format transcript for extraction
    const transcript = formatTranscript(messages);

    // Call AI model to extract knowledge
    const extractedContent = await extractKnowledge(
      transcript,
      mergedConfig.knowledge.captureModel
    );

    // Skip if nothing to extract
    if (!extractedContent.trim() || extractedContent.includes('No knowledge to extract')) {
      log.info({ conversationId }, 'knowledge.capture_completed_nothing');
      return {
        logFile: '',
        extractedContent: '',
        skipped: true,
        skipReason: 'No knowledge extracted from conversation',
      };
    }

    // Ensure KB directory exists
    await initKnowledgeDir(owner, repo);

    // Append to daily log
    const logFile = await appendToDailyLog(owner, repo, conversationId, extractedContent);

    log.info(
      { conversationId, logFile, contentLength: extractedContent.length },
      'knowledge.capture_completed'
    );

    return {
      logFile,
      extractedContent,
      skipped: false,
    };
  } catch (e) {
    const err = e as Error;
    log.error(
      {
        conversationId,
        error: err.message,
        errorType: err.constructor.name,
        err,
      },
      'knowledge.capture_failed'
    );
    throw err;
  }
}

/**
 * Format conversation messages into a readable transcript for extraction.
 */
function formatTranscript(messages: readonly MessageRow[]): string {
  return messages.map(msg => `[${msg.role.toUpperCase()}]: ${msg.content}`).join('\n\n');
}

/**
 * Call AI model to extract structured knowledge from a transcript.
 * Falls back to default model if configured model is unavailable.
 */
async function extractKnowledge(transcript: string, captureModel: string): Promise<string> {
  const client = getAssistantClient('claude');
  const prompt = EXTRACTION_PROMPT + transcript;

  const chunks: string[] = [];
  const generator = client.sendQuery(prompt, process.cwd(), undefined, {
    model: captureModel,
    tools: [], // No tools needed for extraction
  });

  for await (const chunk of generator) {
    if (chunk.type === 'assistant') {
      chunks.push(chunk.content);
    }
    // Ignore other chunk types (tool, thinking, result, etc.)
  }

  return chunks.join('');
}

/**
 * Append extracted knowledge to the daily log file.
 * Creates the log file if it doesn't exist.
 * Returns the log file path.
 */
async function appendToDailyLog(
  owner: string,
  repo: string,
  conversationId: string,
  content: string
): Promise<string> {
  const knowledgePath = getProjectKnowledgePath(owner, repo);
  const logsDir = join(knowledgePath, 'logs');

  // Ensure logs directory exists
  await mkdir(logsDir, { recursive: true });

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const logFile = join(logsDir, `${today}.md`);

  const timestamp = new Date().toISOString();
  const entry = `\n---\n\n### Capture: ${timestamp}\n**Conversation**: ${conversationId}\n\n${content}\n`;

  await appendFile(logFile, entry);

  return logFile;
}

/**
 * Fire-and-forget capture trigger for session transitions.
 * Resolves owner/repo from codebaseId, then calls captureKnowledge().
 * Logs errors but never throws — safe to call without await.
 */
export function triggerCapture(conversationId: string, codebaseId: string | null): void {
  if (!codebaseId) return;

  const log = getLog();

  void (async (): Promise<void> => {
    const codebase = await codebaseDb.getCodebase(codebaseId);
    if (!codebase) {
      log.debug({ conversationId, codebaseId }, 'knowledge.trigger_skipped_no_codebase');
      return;
    }

    const parsed = parseOwnerRepo(codebase.name);
    if (!parsed) {
      log.debug(
        { conversationId, codebaseName: codebase.name },
        'knowledge.trigger_skipped_no_owner_repo'
      );
      return;
    }

    const report = await captureKnowledge(conversationId, parsed.owner, parsed.repo);
    // Schedule debounced flush after successful capture (non-skipped)
    if (!report.skipped) {
      await scheduleFlush(parsed.owner, parsed.repo);
    }
  })().catch(err => {
    log.error(
      { conversationId, codebaseId, error: (err as Error).message, err },
      'knowledge.trigger_failed'
    );
  });
}
