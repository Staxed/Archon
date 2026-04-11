/**
 * Knowledge flush service — synthesizes daily capture logs into structured
 * domain articles in the knowledge base.
 *
 * Reads unprocessed logs since last flush, calls the compile model to produce/update
 * concept articles, then updates indexes and the flush timestamp.
 */
import { readFile, readdir, writeFile, mkdir, rename, unlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  getProjectKnowledgePath,
  getGlobalKnowledgePath,
  getProjectSourcePath,
} from '@archon/paths';
import { createLogger } from '@archon/paths';
import { execFileAsync } from '@archon/git';
import { getAssistantClient } from '../clients/factory';
import { loadConfig } from '../config/config-loader';
import { initKnowledgeDir, initGlobalKnowledgeDir } from './knowledge-init';
import type { MergedConfig } from '../config/config-types';

/** Lazy-initialized logger */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('knowledge.flush');
  return cachedLog;
}

/** Shape of meta/last-flush.json */
export interface LastFlushMeta {
  timestamp: string;
  gitSha: string;
  logsCaptured: string[];
}

/** Zod schema for validating AI flush synthesis responses */
const flushSynthesisSchema = z.object({
  articles: z.array(
    z.object({
      domain: z.string(),
      concept: z.string(),
      content: z.string(),
    })
  ),
  domainSummaries: z.record(z.string()),
  indexSummary: z.string(),
});

/** AI response structure for flush synthesis */
type FlushSynthesis = z.infer<typeof flushSynthesisSchema>;

export interface KnowledgeFlushReport {
  articlesCreated: number;
  articlesUpdated: number;
  articlesStale: number;
  domainsCreated: string[];
  logsProcessed: string[];
  skipped: boolean;
  skipReason?: string;
}

/**
 * Acquire a file-based flush lock. Returns true if lock acquired, false if
 * another live process holds it (skip with warning).
 * Stale locks (dead PID) are reclaimed automatically.
 */
async function acquireFlushLock(knowledgePath: string): Promise<boolean> {
  const log = getLog();
  const lockPath = join(knowledgePath, 'meta', 'flush.lock');
  await mkdir(join(knowledgePath, 'meta'), { recursive: true });

  // Attempt atomic create — fails if file already exists
  try {
    await writeFile(lockPath, String(process.pid), { flag: 'wx' });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }

  // Lock file exists — check if holder is alive
  try {
    const content = await readFile(lockPath, 'utf-8');
    const pid = parseInt(content.trim(), 10);
    if (!isNaN(pid)) {
      try {
        process.kill(pid, 0); // Signal 0 = existence check
        log.warn({ pid, lockPath }, 'knowledge.flush_lock_held');
        return false; // Live process holds lock
      } catch {
        // Process is dead — reclaim stale lock
        log.info({ stalePid: pid, lockPath }, 'knowledge.flush_lock_reclaimed');
      }
    }
    await unlink(lockPath);
  } catch {
    // Lock file disappeared between our attempts — race with another reclaimer
  }

  // Retry atomic create after stale lock removal
  try {
    await writeFile(lockPath, String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    log.warn({ lockPath }, 'knowledge.flush_lock_held');
    return false;
  }
}

/**
 * Release the flush lock file.
 */
async function releaseFlushLock(knowledgePath: string): Promise<void> {
  const lockPath = join(knowledgePath, 'meta', 'flush.lock');
  try {
    await unlink(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
}

/** Prompt sent to the compile model to synthesize daily logs into structured articles */
const SYNTHESIS_PROMPT = `You are a knowledge base compiler. Given daily capture logs and optionally existing articles, produce structured knowledge articles.

## Output Format

You MUST respond with a JSON object (no markdown fences, no explanation, just JSON) with this exact structure:

{
  "articles": [
    {
      "domain": "architecture|decisions|patterns|lessons|connections|<new-domain>",
      "concept": "kebab-case-concept-name",
      "content": "Full markdown article content with [[wikilink]] backlinks to related concepts"
    }
  ],
  "domainSummaries": {
    "architecture": "One-line summary of architecture knowledge",
    "decisions": "One-line summary of decisions"
  },
  "indexSummary": "Brief overview of all domains for the top-level index"
}

## Rules
- Each article should be a focused concept (e.g., "auth-token-strategy", "database-migration-pattern")
- Use [[wikilinks]] to cross-reference related articles (e.g., [[decisions/auth-token-strategy]])
- Domain names are lowercase kebab-case
- Concept filenames are lowercase kebab-case
- Merge new knowledge with existing articles when the concept overlaps (prefer updating over creating duplicates)
- You may create new domains beyond the starting set if the knowledge doesn't fit existing domains
- Every article should start with a level-1 heading matching the concept name in title case
- Include a "Related" section at the end of each article with [[wikilinks]]
- If no meaningful articles can be produced, return {"articles":[],"domainSummaries":{},"indexSummary":""}

---

`;

/** Options for the shared flush core logic */
interface FlushCoreOptions {
  /** Label for logging (e.g., "acme/widget" or "global") */
  label: string;
  /** Path to the knowledge base directory */
  knowledgePath: string;
  /** Merged config */
  config: MergedConfig;
  /** Optional owner/repo for git-based staleness validation */
  git?: { owner: string; repo: string };
  /** Init function to call before flushing (ensures KB directory exists) */
  init: () => Promise<void>;
}

/**
 * Shared flush core — used by both project and global flush functions.
 */
async function flushKnowledgeCore(options: FlushCoreOptions): Promise<KnowledgeFlushReport> {
  const log = getLog();
  const { label, knowledgePath, config: mergedConfig, git: gitInfo, init } = options;

  if (!mergedConfig.knowledge.enabled) {
    log.debug({ label }, 'knowledge.flush_skipped_disabled');
    return {
      articlesCreated: 0,
      articlesUpdated: 0,
      articlesStale: 0,
      domainsCreated: [],
      logsProcessed: [],
      skipped: true,
      skipReason: 'Knowledge is disabled',
    };
  }

  log.info({ label }, 'knowledge.flush_started');

  // Ensure KB directory exists
  await init();

  // Acquire flush lock (one concurrent flush per KB)
  const lockAcquired = await acquireFlushLock(knowledgePath);
  if (!lockAcquired) {
    log.warn({ label }, 'knowledge.flush_skipped_locked');
    return {
      articlesCreated: 0,
      articlesUpdated: 0,
      articlesStale: 0,
      domainsCreated: [],
      logsProcessed: [],
      skipped: true,
      skipReason: 'Flush lock held by another process',
    };
  }

  try {
    // Read last flush metadata
    const lastFlush = await readLastFlush(knowledgePath);

    // Find unprocessed daily logs
    const unprocessedLogs = await findUnprocessedLogs(knowledgePath, lastFlush?.timestamp);

    if (unprocessedLogs.length === 0) {
      log.info({ label }, 'knowledge.flush_skipped_no_logs');
      return {
        articlesCreated: 0,
        articlesUpdated: 0,
        articlesStale: 0,
        domainsCreated: [],
        logsProcessed: [],
        skipped: true,
        skipReason: 'No unprocessed logs to flush',
      };
    }

    // Read log contents
    const logContents = await readLogContents(knowledgePath, unprocessedLogs);

    // Read existing articles for merge context
    const existingArticles = await readExistingArticles(knowledgePath);

    // Call AI to synthesize
    const synthesis = await synthesizeLogs(
      logContents,
      existingArticles,
      mergedConfig.knowledge.compileModel
    );

    // Write to temp dir first, then atomic rename to final paths
    const report = await writeFlushResultsAtomic(knowledgePath, synthesis, unprocessedLogs);

    // Validate staleness against git history (project tier only — global has no git repo)
    if (gitInfo) {
      const validation = await validateStaleness(
        knowledgePath,
        gitInfo.owner,
        gitInfo.repo,
        lastFlush?.gitSha || undefined,
        mergedConfig.knowledge.captureModel
      );
      report.articlesStale = validation.articlesFlaggedStale;
    }

    // Update last-flush metadata (git SHA only for project tier)
    await updateLastFlush(knowledgePath, unprocessedLogs, gitInfo?.owner, gitInfo?.repo);

    log.info(
      {
        label,
        articlesCreated: report.articlesCreated,
        articlesUpdated: report.articlesUpdated,
        articlesStale: report.articlesStale,
        domainsCreated: report.domainsCreated,
        logsProcessed: report.logsProcessed.length,
      },
      'knowledge.flush_completed'
    );

    return report;
  } catch (e) {
    const err = e as Error;
    log.error(
      {
        label,
        error: err.message,
        errorType: err.constructor.name,
        err,
      },
      'knowledge.flush_failed'
    );
    throw err;
  } finally {
    // Always release the lock
    await releaseFlushLock(knowledgePath);
  }
}

/**
 * Flush daily logs into structured domain articles for a project KB.
 *
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param config - Optional pre-loaded config (avoids redundant loading)
 */
export async function flushKnowledge(
  owner: string,
  repo: string,
  config?: MergedConfig
): Promise<KnowledgeFlushReport> {
  const mergedConfig = config ?? (await loadConfig());
  return flushKnowledgeCore({
    label: `${owner}/${repo}`,
    knowledgePath: getProjectKnowledgePath(owner, repo),
    config: mergedConfig,
    git: { owner, repo },
    init: () => initKnowledgeDir(owner, repo),
  });
}

/**
 * Flush daily logs into structured domain articles for the global KB.
 * Same as project flush but operates on the global knowledge directory
 * and skips git-based staleness validation (no associated repository).
 *
 * @param config - Optional pre-loaded config (avoids redundant loading)
 */
export async function flushGlobalKnowledge(config?: MergedConfig): Promise<KnowledgeFlushReport> {
  const mergedConfig = config ?? (await loadConfig());
  return flushKnowledgeCore({
    label: 'global',
    knowledgePath: getGlobalKnowledgePath(),
    config: mergedConfig,
    init: () => initGlobalKnowledgeDir(),
  });
}

/**
 * Read meta/last-flush.json. Returns null if it doesn't exist.
 */
export async function readLastFlush(knowledgePath: string): Promise<LastFlushMeta | null> {
  try {
    const content = await readFile(join(knowledgePath, 'meta', 'last-flush.json'), 'utf-8');
    return JSON.parse(content) as LastFlushMeta;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

/**
 * Find daily log files that are newer than the last flush timestamp.
 * If no last flush exists, return all logs.
 * Returns sorted array of filenames (YYYY-MM-DD.md).
 */
async function findUnprocessedLogs(
  knowledgePath: string,
  lastFlushTimestamp?: string
): Promise<string[]> {
  const logsDir = join(knowledgePath, 'logs');

  let files: string[];
  try {
    files = await readdir(logsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw err;
  }

  // Filter to YYYY-MM-DD.md files
  const logFiles = files.filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();

  if (!lastFlushTimestamp) {
    return logFiles;
  }

  // Filter to files newer than last flush date
  const flushDate = lastFlushTimestamp.slice(0, 10); // YYYY-MM-DD
  return logFiles.filter(f => f.replace('.md', '') >= flushDate);
}

/**
 * Read the contents of the specified log files.
 */
async function readLogContents(knowledgePath: string, logFiles: string[]): Promise<string> {
  const logsDir = join(knowledgePath, 'logs');
  const contents: string[] = [];

  for (const file of logFiles) {
    const content = await readFile(join(logsDir, file), 'utf-8');
    contents.push(`## Log: ${file}\n\n${content}`);
  }

  return contents.join('\n\n---\n\n');
}

/**
 * Read existing articles from domains/ for merge context.
 * Returns a formatted string of existing articles.
 */
async function readExistingArticles(knowledgePath: string): Promise<string> {
  const domainsDir = join(knowledgePath, 'domains');
  const articles: string[] = [];

  let domains: string[];
  try {
    domains = await readdir(domainsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return '';
    }
    throw err;
  }

  for (const domain of domains) {
    const domainDir = join(domainsDir, domain);
    let files: string[];
    try {
      files = await readdir(domainDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        getLog().warn({ domain, error: (err as Error).message }, 'knowledge.read_domain_failed');
      }
      continue;
    }

    for (const file of files) {
      if (file === '_index.md' || !file.endsWith('.md')) continue;
      try {
        const content = await readFile(join(domainDir, file), 'utf-8');
        articles.push(`### ${domain}/${file}\n\n${content}`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          getLog().warn(
            { domain, file, error: (err as Error).message },
            'knowledge.read_article_failed'
          );
        }
        continue;
      }
    }
  }

  return articles.length > 0
    ? `## Existing Articles (merge with these if concepts overlap)\n\n${articles.join('\n\n---\n\n')}`
    : '';
}

/**
 * Call AI model to synthesize logs into structured articles.
 */
async function synthesizeLogs(
  logContents: string,
  existingArticles: string,
  compileModel: string
): Promise<FlushSynthesis> {
  const client = getAssistantClient('claude');

  const contextParts = [SYNTHESIS_PROMPT];
  if (existingArticles) {
    contextParts.push(existingArticles);
  }
  contextParts.push(`## New Daily Logs to Process\n\n${logContents}`);

  const prompt = contextParts.join('\n\n');

  const chunks: string[] = [];
  const generator = client.sendQuery(prompt, process.cwd(), undefined, {
    model: compileModel,
    tools: [],
  });

  for await (const chunk of generator) {
    if (chunk.type === 'assistant') {
      chunks.push(chunk.content);
    }
  }

  const rawResponse = chunks.join('');

  // Parse JSON from response (handle potential markdown code fences)
  const jsonStr = rawResponse.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '');

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    const err = e as Error;
    getLog().warn(
      { rawResponseLength: rawResponse.length, error: err.message },
      'knowledge.flush_synthesis_json_parse_failed'
    );
    throw new Error(`Flush synthesis returned invalid JSON: ${err.message}`);
  }

  const result = flushSynthesisSchema.safeParse(parsed);
  if (!result.success) {
    getLog().warn(
      { errors: result.error.issues },
      'knowledge.flush_synthesis_schema_validation_failed'
    );
    throw new Error(`Flush synthesis response has invalid structure: ${result.error.message}`);
  }
  return result.data;
}

/**
 * Write synthesized articles to a temp directory, then atomically rename
 * into final paths. If flush crashes mid-write, the temp dir is cleaned up
 * on next flush (idempotent).
 */
async function writeFlushResultsAtomic(
  knowledgePath: string,
  synthesis: FlushSynthesis,
  processedLogs: string[]
): Promise<KnowledgeFlushReport> {
  const domainsDir = join(knowledgePath, 'domains');
  const tmpDir = join(knowledgePath, '.tmp');

  // Clean up any leftover temp dir from a previous crashed flush
  try {
    await rm(tmpDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
  await mkdir(tmpDir, { recursive: true });

  let articlesCreated = 0;
  let articlesUpdated = 0;
  const domainsCreated: string[] = [];
  const domainArticles: Record<string, string[]> = {};

  // Collect all files to write into temp dir first
  const pendingRenames: { tmpPath: string; finalPath: string }[] = [];

  // Write individual articles to temp dir
  for (const article of synthesis.articles) {
    const domainDir = join(domainsDir, article.domain);

    // Create real domain directory (needed for _index.md check and final location)
    await mkdir(domainDir, { recursive: true });

    // Track domains created by checking if _index.md exists
    const indexPath = join(domainDir, '_index.md');
    let isNewDomain = false;
    try {
      await readFile(indexPath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        isNewDomain = true;
        if (!domainsCreated.includes(article.domain)) {
          domainsCreated.push(article.domain);
        }
      }
    }

    const articlePath = join(domainDir, `${article.concept}.md`);

    // Check if article exists in real dir (for created vs updated tracking)
    let articleExists = false;
    try {
      await readFile(articlePath, 'utf-8');
      articleExists = true;
    } catch {
      // File doesn't exist
    }

    // Write to temp dir
    const tmpArticleDir = join(tmpDir, 'domains', article.domain);
    await mkdir(tmpArticleDir, { recursive: true });
    const tmpArticlePath = join(tmpArticleDir, `${article.concept}.md`);
    await writeFile(tmpArticlePath, article.content);
    pendingRenames.push({ tmpPath: tmpArticlePath, finalPath: articlePath });

    if (articleExists) {
      articlesUpdated++;
    } else {
      articlesCreated++;
    }

    // Track articles per domain for index updates
    if (!domainArticles[article.domain]) {
      domainArticles[article.domain] = [];
    }
    domainArticles[article.domain].push(article.concept);

    // Create domain _index.md in temp if new domain
    if (isNewDomain) {
      const domainTitle = article.domain
        .split('-')
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
      const domainIndexContent = `# ${domainTitle}\n\n${synthesis.domainSummaries[article.domain] ?? ''}\n\n## Articles\n\n${domainArticles[article.domain].map(c => `- [[${article.domain}/${c}|${formatConceptTitle(c)}]]`).join('\n')}\n`;
      const tmpIndexPath = join(tmpArticleDir, '_index.md');
      await writeFile(tmpIndexPath, domainIndexContent);
      pendingRenames.push({ tmpPath: tmpIndexPath, finalPath: indexPath });
    }
  }

  // Update existing domain indexes — write to temp, then rename
  for (const [domain, concepts] of Object.entries(domainArticles)) {
    const indexPath = join(domainsDir, domain, '_index.md');
    try {
      const existingIndex = await readFile(indexPath, 'utf-8');
      const updatedIndex = updateDomainIndex(
        existingIndex,
        domain,
        concepts,
        synthesis.domainSummaries[domain]
      );
      const tmpIndexDir = join(tmpDir, 'domains', domain);
      await mkdir(tmpIndexDir, { recursive: true });
      const tmpIndexPath = join(tmpIndexDir, '_index.md');
      await writeFile(tmpIndexPath, updatedIndex);
      pendingRenames.push({ tmpPath: tmpIndexPath, finalPath: indexPath });
    } catch {
      // Index was already created above for new domains
    }
  }

  // Write top-level index.md to temp
  if (synthesis.indexSummary || synthesis.articles.length > 0) {
    const indexContent = buildTopLevelIndex(synthesis, domainArticles);
    const tmpIndexPath = join(tmpDir, 'index.md');
    await writeFile(tmpIndexPath, indexContent);
    pendingRenames.push({
      tmpPath: tmpIndexPath,
      finalPath: join(knowledgePath, 'index.md'),
    });
  }

  // Atomic phase: rename all temp files into their final locations
  for (const { tmpPath, finalPath } of pendingRenames) {
    await rename(tmpPath, finalPath);
  }

  // Clean up temp dir
  try {
    await rm(tmpDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }

  return {
    articlesCreated,
    articlesUpdated,
    articlesStale: 0, // Staleness is US-011
    domainsCreated,
    logsProcessed: processedLogs,
    skipped: false,
  };
}

/**
 * Update a domain _index.md with new article links.
 */
function updateDomainIndex(
  existingContent: string,
  domain: string,
  newConcepts: string[],
  summary?: string
): string {
  let content = existingContent;

  // Update summary if provided
  if (summary) {
    // Replace the line after the heading with the summary
    const lines = content.split('\n');
    if (lines.length >= 2) {
      // Find the line after the first heading
      const headingIdx = lines.findIndex(l => l.startsWith('# '));
      if (headingIdx !== -1 && headingIdx + 1 < lines.length) {
        // Insert or replace summary after heading
        if (lines[headingIdx + 1] === '' && headingIdx + 2 < lines.length) {
          // Replace the description line
          if (!lines[headingIdx + 2]?.startsWith('##')) {
            lines[headingIdx + 2] = summary;
          }
        }
        content = lines.join('\n');
      }
    }
  }

  // Add new article links if not already present
  for (const concept of newConcepts) {
    const wikilink = `[[${domain}/${concept}|${formatConceptTitle(concept)}]]`;
    if (!content.includes(wikilink)) {
      // Remove placeholder text if present
      content = content.replace(
        '_No articles yet. Articles will appear here as knowledge is compiled._',
        ''
      );
      // Append to Articles section
      content = content.trimEnd() + `\n- ${wikilink}\n`;
    }
  }

  return content;
}

/**
 * Build the top-level index.md content (pure — no I/O).
 */
function buildTopLevelIndex(
  synthesis: FlushSynthesis,
  domainArticles: Record<string, string[]>
): string {
  const domainSections: string[] = [];
  const allDomains = new Set([
    ...Object.keys(synthesis.domainSummaries),
    ...Object.keys(domainArticles),
  ]);

  for (const domain of [...allDomains].sort()) {
    const title = formatConceptTitle(domain);
    const summary = synthesis.domainSummaries[domain] ?? '';
    domainSections.push(`### [[domains/${domain}/_index|${title}]]\n${summary}`);
  }

  return `# Knowledge Base Index

> This index is auto-maintained. Navigate to domain indexes for detailed articles.

## Domains

${domainSections.join('\n\n')}
`;
}

/**
 * Update meta/last-flush.json with current timestamp and git SHA via atomic temp+rename.
 * Git SHA is only fetched when owner/repo are provided (project tier).
 */
async function updateLastFlush(
  knowledgePath: string,
  processedLogs: string[],
  owner?: string,
  repo?: string
): Promise<void> {
  const metaDir = join(knowledgePath, 'meta');
  await mkdir(metaDir, { recursive: true });

  const gitSha = owner && repo ? await getCurrentGitSha(owner, repo) : '';

  const meta: LastFlushMeta = {
    timestamp: new Date().toISOString(),
    gitSha,
    logsCaptured: processedLogs,
  };

  const tmpPath = join(metaDir, 'last-flush.json.tmp');
  const finalPath = join(metaDir, 'last-flush.json');
  await writeFile(tmpPath, JSON.stringify(meta, null, 2));
  await rename(tmpPath, finalPath);
}

/**
 * Get the current HEAD SHA from the project source repository.
 * Returns empty string if git is unavailable.
 */
export async function getCurrentGitSha(owner: string, repo: string): Promise<string> {
  try {
    const sourcePath = getProjectSourcePath(owner, repo);
    const { stdout } = await execFileAsync('git', ['-C', sourcePath, 'rev-parse', 'HEAD'], {
      timeout: 10000,
    });
    return stdout.trim();
  } catch (err) {
    getLog().debug({ owner, repo, error: (err as Error).message }, 'knowledge.git_sha_unavailable');
    return '';
  }
}

/**
 * Get git diff output (changed file names) between two SHAs.
 * Returns empty string if git is unavailable or SHAs are invalid.
 */
export async function getGitDiffNameOnly(
  owner: string,
  repo: string,
  fromSha: string
): Promise<string> {
  try {
    const sourcePath = getProjectSourcePath(owner, repo);
    const { stdout } = await execFileAsync(
      'git',
      ['-C', sourcePath, 'diff', '--name-only', `${fromSha}..HEAD`],
      { timeout: 30000 }
    );
    return stdout.trim();
  } catch (err) {
    getLog().debug(
      { owner, repo, fromSha, error: (err as Error).message },
      'knowledge.git_diff_unavailable'
    );
    return '';
  }
}

/** Prompt for Haiku to perform staleness comparison */
const STALENESS_PROMPT = `You are a knowledge base validator. Given a list of changed files from git and a set of knowledge articles, identify which articles reference files, functions, or patterns that have changed significantly.

## Output Format

Respond with a JSON array of article paths that are stale (no markdown fences, no explanation, just JSON):

["domain/concept", "domain/concept2"]

If no articles are stale, return an empty array: []

## Rules
- An article is stale if it specifically references files, functions, classes, or patterns that appear in the changed files list
- General conceptual articles that don't reference specific code are NOT stale
- Only flag articles where the changes are significant enough to potentially invalidate the article's content
- Be conservative — only flag clearly affected articles

---

`;

/** Staleness validation result */
interface StalenessResult {
  articlesChecked: number;
  articlesFlaggedStale: number;
  brokenLinks: number;
  staleArticles: string[];
  brokenWikilinks: { source: string; target: string }[];
}

/**
 * Validate articles for staleness against git history and check for broken wikilinks.
 */
async function validateStaleness(
  knowledgePath: string,
  owner: string,
  repo: string,
  lastFlushSha: string | undefined,
  captureModel: string
): Promise<StalenessResult> {
  const log = getLog();

  // Collect all articles
  const articles = await collectAllArticles(knowledgePath);

  if (articles.length === 0) {
    return {
      articlesChecked: 0,
      articlesFlaggedStale: 0,
      brokenLinks: 0,
      staleArticles: [],
      brokenWikilinks: [],
    };
  }

  // Check staleness via git diff + AI
  let staleArticles: string[] = [];
  if (lastFlushSha) {
    const diffOutput = await getGitDiffNameOnly(owner, repo, lastFlushSha);
    if (diffOutput) {
      staleArticles = await identifyStaleArticles(articles, diffOutput, captureModel);
    }
  }

  // Add staleness markers to flagged articles
  for (const articleKey of staleArticles) {
    const [domain, concept] = articleKey.split('/');
    if (!domain || !concept) continue;
    const articlePath = join(knowledgePath, 'domains', domain, `${concept}.md`);
    await addStalenessMarker(articlePath);
  }

  // Check for broken wikilinks
  const brokenWikilinks = checkBrokenWikilinks(articles);

  log.info(
    {
      articlesChecked: articles.length,
      articlesFlaggedStale: staleArticles.length,
      brokenLinks: brokenWikilinks.length,
    },
    'knowledge.flush_validation_completed'
  );

  return {
    articlesChecked: articles.length,
    articlesFlaggedStale: staleArticles.length,
    brokenLinks: brokenWikilinks.length,
    staleArticles,
    brokenWikilinks,
  };
}

/** Collected article with domain/concept key and content */
export interface CollectedArticle {
  key: string; // "domain/concept"
  content: string;
}

/**
 * Collect all articles from domains/ directory.
 */
export async function collectAllArticles(knowledgePath: string): Promise<CollectedArticle[]> {
  const domainsDir = join(knowledgePath, 'domains');
  const articles: CollectedArticle[] = [];

  let domains: string[];
  try {
    domains = await readdir(domainsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  for (const domain of domains) {
    const domainDir = join(domainsDir, domain);
    let files: string[];
    try {
      files = await readdir(domainDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        getLog().warn({ domain, error: (err as Error).message }, 'knowledge.collect_domain_failed');
      }
      continue;
    }

    for (const file of files) {
      if (file === '_index.md' || !file.endsWith('.md')) continue;
      try {
        const content = await readFile(join(domainDir, file), 'utf-8');
        const concept = file.replace('.md', '');
        articles.push({ key: `${domain}/${concept}`, content });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          getLog().warn(
            { domain, file, error: (err as Error).message },
            'knowledge.collect_article_failed'
          );
        }
        continue;
      }
    }
  }

  return articles;
}

/**
 * Call Haiku to identify which articles are stale based on git diff.
 */
export async function identifyStaleArticles(
  articles: CollectedArticle[],
  diffOutput: string,
  captureModel: string
): Promise<string[]> {
  const client = getAssistantClient('claude');

  const articlesSummary = articles.map(a => `### ${a.key}\n\n${a.content}`).join('\n\n---\n\n');

  const prompt = `${STALENESS_PROMPT}## Changed Files\n\n${diffOutput}\n\n## Articles to Check\n\n${articlesSummary}`;

  const chunks: string[] = [];
  const generator = client.sendQuery(prompt, process.cwd(), undefined, {
    model: captureModel,
    tools: [],
  });

  for await (const chunk of generator) {
    if (chunk.type === 'assistant') {
      chunks.push(chunk.content);
    }
  }

  const rawResponse = chunks.join('');
  const jsonStr = rawResponse.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '');

  try {
    const result = JSON.parse(jsonStr) as unknown;
    if (!Array.isArray(result)) return [];
    return result.filter((item): item is string => typeof item === 'string');
  } catch (e) {
    getLog().warn(
      { rawResponseLength: rawResponse.length, error: (e as Error).message },
      'knowledge.staleness_json_parse_failed'
    );
    return [];
  }
}

/**
 * Add a staleness warning marker to an article file.
 * Idempotent — won't add if already present.
 */
async function addStalenessMarker(articlePath: string): Promise<void> {
  const STALENESS_MARKER =
    '> [!WARNING] This article may be stale — referenced code has changed since last validation.';

  try {
    let content = await readFile(articlePath, 'utf-8');
    if (content.includes('> [!WARNING] This article may be stale')) {
      return; // Already marked
    }

    // Remove any existing staleness markers before adding fresh one
    // Insert after the first heading line
    const lines = content.split('\n');
    const headingIdx = lines.findIndex(l => l.startsWith('# '));
    if (headingIdx !== -1) {
      lines.splice(headingIdx + 1, 0, '', STALENESS_MARKER, '');
      content = lines.join('\n');
    } else {
      content = STALENESS_MARKER + '\n\n' + content;
    }

    await writeFile(articlePath, content);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      getLog().warn(
        { articlePath, error: (err as Error).message },
        'knowledge.staleness_marker_write_failed'
      );
    }
  }
}

/**
 * Check for broken [[wikilink]] cross-references between articles.
 * Returns list of broken links with source article and target reference.
 */
export function checkBrokenWikilinks(
  articles: CollectedArticle[]
): { source: string; target: string }[] {
  const articleKeys = new Set(articles.map(a => a.key));
  const brokenLinks: { source: string; target: string }[] = [];

  const wikilinkPattern = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

  for (const article of articles) {
    let match: RegExpExecArray | null;
    // Reset lastIndex for each article
    wikilinkPattern.lastIndex = 0;

    while ((match = wikilinkPattern.exec(article.content)) !== null) {
      const target = match[1];
      if (!target) continue;

      // Skip links to _index files (domain-level links)
      if (target.includes('_index')) continue;

      // Normalize: strip domains/ prefix if present
      const normalizedTarget = target.replace(/^domains\//, '');

      // Check if target article exists
      if (normalizedTarget.includes('/') && !articleKeys.has(normalizedTarget)) {
        brokenLinks.push({ source: article.key, target: normalizedTarget });
      }
    }
  }

  return brokenLinks;
}

/**
 * Convert kebab-case concept name to Title Case.
 */
function formatConceptTitle(concept: string): string {
  return concept
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
