/**
 * Knowledge flush service — synthesizes daily capture logs into structured
 * domain articles in the knowledge base.
 *
 * Reads unprocessed logs since last flush, calls Sonnet to produce/update
 * concept articles, then updates indexes and the flush timestamp.
 */
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getProjectKnowledgePath } from '@archon/paths';
import { createLogger } from '@archon/paths';
import { getAssistantClient } from '../clients/factory';
import { loadConfig } from '../config/config-loader';
import { initKnowledgeDir } from './knowledge-init';
import type { MergedConfig } from '../config/config-types';

/** Lazy-initialized logger */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('knowledge.flush');
  return cachedLog;
}

/** Shape of meta/last-flush.json */
interface LastFlushMeta {
  timestamp: string;
  gitSha: string;
  logsCaptured: string[];
}

/** AI response structure for flush synthesis */
interface FlushSynthesis {
  articles: {
    domain: string;
    concept: string;
    content: string;
  }[];
  domainSummaries: Record<string, string>;
  indexSummary: string;
}

export interface KnowledgeFlushReport {
  articlesCreated: number;
  articlesUpdated: number;
  articlesStale: number;
  domainsCreated: string[];
  logsProcessed: string[];
  skipped: boolean;
  skipReason?: string;
}

/** Prompt sent to Sonnet to synthesize daily logs into structured articles */
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

/**
 * Flush daily logs into structured domain articles.
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
  const log = getLog();
  const mergedConfig = config ?? (await loadConfig());

  if (!mergedConfig.knowledge.enabled) {
    log.debug({ owner, repo }, 'knowledge.flush_skipped_disabled');
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

  log.info({ owner, repo }, 'knowledge.flush_started');

  try {
    // Ensure KB directory exists
    await initKnowledgeDir(owner, repo);

    const knowledgePath = getProjectKnowledgePath(owner, repo);

    // Read last flush metadata
    const lastFlush = await readLastFlush(knowledgePath);

    // Find unprocessed daily logs
    const unprocessedLogs = await findUnprocessedLogs(knowledgePath, lastFlush?.timestamp);

    if (unprocessedLogs.length === 0) {
      log.info({ owner, repo }, 'knowledge.flush_skipped_no_logs');
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

    // Write articles and collect stats
    const report = await writeFlushResults(knowledgePath, synthesis, unprocessedLogs);

    // Update last-flush metadata
    await updateLastFlush(knowledgePath, unprocessedLogs);

    log.info(
      {
        owner,
        repo,
        articlesCreated: report.articlesCreated,
        articlesUpdated: report.articlesUpdated,
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
        owner,
        repo,
        error: err.message,
        errorType: err.constructor.name,
        err,
      },
      'knowledge.flush_failed'
    );
    throw err;
  }
}

/**
 * Read meta/last-flush.json. Returns null if it doesn't exist.
 */
async function readLastFlush(knowledgePath: string): Promise<LastFlushMeta | null> {
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
  return logFiles.filter(f => f.replace('.md', '') > flushDate);
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
    } catch {
      continue;
    }

    for (const file of files) {
      if (file === '_index.md' || !file.endsWith('.md')) continue;
      try {
        const content = await readFile(join(domainDir, file), 'utf-8');
        articles.push(`### ${domain}/${file}\n\n${content}`);
      } catch {
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
  return JSON.parse(jsonStr) as FlushSynthesis;
}

/**
 * Write synthesized articles, update domain indexes, and top-level index.
 * Returns flush report with stats.
 */
async function writeFlushResults(
  knowledgePath: string,
  synthesis: FlushSynthesis,
  processedLogs: string[]
): Promise<KnowledgeFlushReport> {
  const domainsDir = join(knowledgePath, 'domains');
  let articlesCreated = 0;
  let articlesUpdated = 0;
  const domainsCreated: string[] = [];
  const domainArticles: Record<string, string[]> = {};

  // Write individual articles
  for (const article of synthesis.articles) {
    const domainDir = join(domainsDir, article.domain);

    // Create domain directory if it doesn't exist (organic domain creation)
    try {
      await mkdir(domainDir, { recursive: true });
      // Check if this is a new domain
      const existingDomains = await readdir(domainsDir);
      if (!existingDomains.includes(article.domain)) {
        domainsCreated.push(article.domain);
      }
    } catch {
      // mkdir with recursive won't fail if exists
    }
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

    // Check if article exists (for created vs updated tracking)
    let articleExists = false;
    try {
      await readFile(articlePath, 'utf-8');
      articleExists = true;
    } catch {
      // File doesn't exist
    }

    await writeFile(articlePath, article.content);

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

    // Create domain _index.md if new domain
    if (isNewDomain) {
      const domainTitle = article.domain
        .split('-')
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
      const domainIndexContent = `# ${domainTitle}\n\n${synthesis.domainSummaries[article.domain] ?? ''}\n\n## Articles\n\n${domainArticles[article.domain].map(c => `- [[${article.domain}/${c}|${formatConceptTitle(c)}]]`).join('\n')}\n`;
      await writeFile(indexPath, domainIndexContent);
    }
  }

  // Update existing domain indexes with new articles
  for (const [domain, concepts] of Object.entries(domainArticles)) {
    const indexPath = join(domainsDir, domain, '_index.md');
    try {
      const existingIndex = await readFile(indexPath, 'utf-8');
      // Only update if articles section needs new entries
      const updatedIndex = updateDomainIndex(
        existingIndex,
        domain,
        concepts,
        synthesis.domainSummaries[domain]
      );
      await writeFile(indexPath, updatedIndex);
    } catch {
      // Index was already created above for new domains
    }
  }

  // Update top-level index.md
  if (synthesis.indexSummary || synthesis.articles.length > 0) {
    await updateTopLevelIndex(knowledgePath, synthesis, domainArticles);
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
 * Update the top-level index.md with domain summaries.
 */
async function updateTopLevelIndex(
  knowledgePath: string,
  synthesis: FlushSynthesis,
  domainArticles: Record<string, string[]>
): Promise<void> {
  const indexPath = join(knowledgePath, 'index.md');

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

  const indexContent = `# Knowledge Base Index

> This index is auto-maintained. Navigate to domain indexes for detailed articles.

## Domains

${domainSections.join('\n\n')}
`;

  await writeFile(indexPath, indexContent);
}

/**
 * Update meta/last-flush.json with current timestamp.
 */
async function updateLastFlush(knowledgePath: string, processedLogs: string[]): Promise<void> {
  const metaDir = join(knowledgePath, 'meta');
  await mkdir(metaDir, { recursive: true });

  const meta: LastFlushMeta = {
    timestamp: new Date().toISOString(),
    gitSha: '', // Git SHA tracking deferred to US-011 (staleness validation)
    logsCaptured: processedLogs,
  };

  await writeFile(join(metaDir, 'last-flush.json'), JSON.stringify(meta, null, 2));
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
