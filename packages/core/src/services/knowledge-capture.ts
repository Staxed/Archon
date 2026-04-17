/**
 * Knowledge capture service — extracts decisions/lessons/patterns from conversation
 * transcripts and appends them to daily log files in the knowledge base.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getProjectKnowledgePath, getGlobalKnowledgePath, parseOwnerRepo } from '@archon/paths';
import { createLogger } from '@archon/paths';
import { getAssistantClient } from '../clients/factory';
import * as messageDb from '../db/messages';
import * as codebaseDb from '../db/codebases';
import { loadConfig } from '../config/config-loader';
import { initKnowledgeDir, initGlobalKnowledgeDir } from './knowledge-init';
import { scheduleFlush, scheduleGlobalFlush } from './knowledge-scheduler';
import type { MergedConfig } from '../config/config-types';
import type { MessageRow } from '../db/messages';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('knowledge.capture');
  return cachedLog;
}

/** Extraction prompt sent to the capture model to extract structured knowledge from a transcript */
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
 * @param additionalTranscript - Optional extra context (e.g. workflow JSONL logs) appended to transcript
 */
export async function captureKnowledge(
  conversationId: string,
  owner: string,
  repo: string,
  config?: MergedConfig,
  additionalTranscript?: string
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
    const transcript = formatTranscript(messages) + (additionalTranscript ?? '');

    // Call AI model to extract knowledge
    const extractedContent = await extractKnowledge(
      transcript,
      mergedConfig.knowledge.captureModel,
      mergedConfig.knowledge.captureProvider ?? 'claude'
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
async function extractKnowledge(
  transcript: string,
  captureModel: string,
  captureProvider: string
): Promise<string> {
  const client = getAssistantClient(captureProvider);
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

/** Scope addendum appended to extraction prompts when scope is 'both' */
const SCOPE_CLASSIFICATION_ADDENDUM = `

## Scope Classification

Classify each extracted item as PROJECT-scoped or GLOBAL-scoped:

- **PROJECT**: Knowledge specific to this repository — file paths, internal APIs, project-specific conventions, repo-specific decisions.
- **GLOBAL**: Knowledge applicable across any codebase — general engineering patterns, language idioms, tool usage tips, debugging techniques, universal best practices.

When in doubt, classify as PROJECT (conservative default).

Format your response with two clearly separated sections:

## PROJECT

{project-scoped knowledge items here}

## GLOBAL

{global-scoped knowledge items here}

If all items belong to one scope, include only that section.
`;

/**
 * Parse scoped extraction output into project and global sections.
 * Handles: both blocks present, only one block, and malformed (fallback to project).
 */
export function parseScopedOutput(
  content: string,
  scope: 'project' | 'global' | 'both'
): { project: string; global: string } {
  // Single-scope modes: all content goes to the requested scope
  if (scope === 'project') return { project: content, global: '' };
  if (scope === 'global') return { project: '', global: content };

  // 'both' scope: parse ## PROJECT and ## GLOBAL blocks
  const projectMatch = /## PROJECT\s*\n([\s\S]*?)(?=## GLOBAL|$)/i.exec(content);
  const globalMatch = /## GLOBAL\s*\n([\s\S]*?)(?=## PROJECT|$)/i.exec(content);

  const projectContent = projectMatch?.[1]?.trim() ?? '';
  const globalContent = globalMatch?.[1]?.trim() ?? '';

  // If neither block was found, fall back to project (conservative default)
  if (!projectContent && !globalContent) {
    getLog().info('knowledge.parse_scope_fallback_project');
    return { project: content.trim(), global: '' };
  }

  return { project: projectContent, global: globalContent };
}

/**
 * Extract knowledge using a custom prompt and context.
 * Used by knowledge-extract workflow nodes for targeted extraction.
 *
 * @param prompt - Custom extraction prompt describing what to extract
 * @param context - Upstream context (e.g. workflow node outputs)
 * @param cwd - Working directory (used to resolve owner/repo via git remote)
 * @param metadata - Workflow run and node identifiers for log entries
 * @param scope - Where to route extracted knowledge: 'project', 'global', or 'both' (default)
 * @returns Extracted knowledge content
 */
export async function extractKnowledgeFromContext(
  prompt: string,
  context: string,
  cwd: string,
  metadata: { workflowRunId: string; nodeId: string },
  scope: 'project' | 'global' | 'both' = 'both'
): Promise<string> {
  const log = getLog();

  // Resolve owner/repo from cwd via git remote
  const { toRepoPath, getRemoteUrl } = await import('@archon/git');
  const repoPath = toRepoPath(cwd);
  const remoteUrl = await getRemoteUrl(repoPath);
  if (!remoteUrl) {
    throw new Error('Cannot resolve owner/repo from git remote — no remote URL found');
  }
  const urlParts = remoteUrl.replace(/\.git$/, '').split(/[/:]/);
  const repo = urlParts.pop();
  const owner = urlParts.pop();
  if (!owner || !repo) {
    throw new Error(`Cannot parse owner/repo from remote URL: ${remoteUrl}`);
  }

  const mergedConfig = await loadConfig();
  if (!mergedConfig.knowledge.enabled) {
    log.debug('knowledge.extract_skipped_disabled');
    return '';
  }

  log.info({ owner, repo, nodeId: metadata.nodeId, scope }, 'knowledge.extract_started');

  // Build prompt — append scope classification instructions for 'both' scope
  const scopeAddendum = scope === 'both' ? SCOPE_CLASSIFICATION_ADDENDUM : '';
  const fullPrompt = `${prompt}${scopeAddendum}\n\n---\n\nCONTEXT:\n${context}`;
  const client = getAssistantClient(mergedConfig.knowledge.captureProvider ?? 'claude');
  const chunks: string[] = [];
  const generator = client.sendQuery(fullPrompt, cwd, undefined, {
    model: mergedConfig.knowledge.captureModel,
    tools: [],
  });

  for await (const chunk of generator) {
    if (chunk.type === 'assistant') {
      chunks.push(chunk.content);
    }
  }

  const extracted = chunks.join('');
  if (!extracted.trim()) {
    log.info({ nodeId: metadata.nodeId }, 'knowledge.extract_completed_nothing');
    return '';
  }

  // Parse scoped output
  const scoped = parseScopedOutput(extracted, scope);

  // Write project-scoped entries to project daily log
  if (scoped.project) {
    await initKnowledgeDir(owner, repo);
    const knowledgePath = getProjectKnowledgePath(owner, repo);
    const logsDir = join(knowledgePath, 'logs');
    await mkdir(logsDir, { recursive: true });

    const today = new Date().toISOString().slice(0, 10);
    const logFile = join(logsDir, `${today}.md`);
    const timestamp = new Date().toISOString();
    const entry = `\n---\n\n### Knowledge Extract: ${timestamp}\n**Workflow Run**: ${metadata.workflowRunId}\n**Node**: ${metadata.nodeId}\n\n${scoped.project}\n`;

    await appendFile(logFile, entry);

    log.info(
      { owner, repo, nodeId: metadata.nodeId, logFile, contentLength: scoped.project.length },
      'knowledge.extract_project_completed'
    );

    // Schedule debounced flush after project extraction
    await scheduleFlush(owner, repo);
  }

  // Write global-scoped entries to global daily log
  if (scoped.global) {
    await initGlobalKnowledgeDir();
    await appendToGlobalDailyLog(owner, repo, metadata, scoped.global);

    log.info(
      { nodeId: metadata.nodeId, contentLength: scoped.global.length },
      'knowledge.extract_global_completed'
    );

    // Schedule debounced global flush
    await scheduleGlobalFlush();
  }

  return extracted;
}

/**
 * Append extracted global knowledge to the global daily log.
 * Includes source attribution (owner/repo) for traceability.
 */
async function appendToGlobalDailyLog(
  owner: string,
  repo: string,
  metadata: { workflowRunId: string; nodeId: string },
  content: string
): Promise<string> {
  const globalKnowledgePath = getGlobalKnowledgePath();
  const logsDir = join(globalKnowledgePath, 'logs');
  await mkdir(logsDir, { recursive: true });

  const today = new Date().toISOString().slice(0, 10);
  const logFile = join(logsDir, `${today}.md`);
  const timestamp = new Date().toISOString();
  const entry = `\n---\n\n### Knowledge Extract: ${timestamp}\n**Source**: ${owner}/${repo}\n**Workflow Run**: ${metadata.workflowRunId}\n**Node**: ${metadata.nodeId}\n\n${content}\n`;

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
