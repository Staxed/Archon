/**
 * Knowledge commands — manage the persistent knowledge base.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createLogger,
  parseOwnerRepo,
  getProjectKnowledgePath,
  getGlobalKnowledgePath,
} from '@archon/paths';
import * as git from '@archon/git';
import { flushKnowledge } from '@archon/core/services/knowledge-flush';
import { loadConfig } from '@archon/core';
import type { KnowledgeFlushReport } from '@archon/core/services/knowledge-flush';

/** Lazy-initialized logger */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('cli.knowledge');
  return cachedLog;
}

/**
 * Resolve owner/repo from --project flag or current git repo remote URL.
 * Returns null if resolution fails.
 */
async function resolveOwnerRepo(
  cwd: string,
  project?: string
): Promise<{ owner: string; repo: string } | null> {
  // If --project flag provided, parse it directly
  if (project) {
    const parsed = parseOwnerRepo(project);
    if (!parsed) {
      console.error(`Error: Invalid --project format: "${project}". Expected "owner/repo".`);
      return null;
    }
    return parsed;
  }

  // Fall back to git remote URL
  try {
    const repoPath = git.toRepoPath(cwd);
    const remoteUrl = await git.getRemoteUrl(repoPath);
    if (!remoteUrl) {
      console.error('Error: No git remote found. Use --project owner/repo to specify the project.');
      return null;
    }

    // Parse owner/repo from remote URL (handles both HTTPS and SSH)
    const urlParts = remoteUrl.replace(/\.git$/, '').split(/[/:]/);
    const repo = urlParts.pop();
    const owner = urlParts.pop();
    if (!owner || !repo) {
      console.error(
        `Error: Could not parse owner/repo from remote URL: ${remoteUrl}. Use --project owner/repo.`
      );
      return null;
    }
    return { owner, repo };
  } catch {
    console.error(
      'Error: Could not resolve project from git remote. Use --project owner/repo to specify.'
    );
    return null;
  }
}

/**
 * `knowledge flush` — manually trigger a knowledge flush (compile daily logs into articles).
 */
export async function knowledgeFlushCommand(
  cwd: string,
  project?: string,
  quiet?: boolean
): Promise<number> {
  const log = getLog();
  const ownerRepo = await resolveOwnerRepo(cwd, project);
  if (!ownerRepo) return 1;

  const { owner, repo } = ownerRepo;

  if (!quiet) {
    process.stderr.write(`Flushing knowledge base for ${owner}/${repo}...\n`);
  }

  try {
    const config = await loadConfig();
    const report = await flushKnowledge(owner, repo, config);
    renderFlushReport(report, quiet);
    return 0;
  } catch (error) {
    const err = error as Error;
    log.error({ err, owner, repo }, 'knowledge.flush_command_failed');
    console.error(`Error: Flush failed — ${err.message}`);
    return 1;
  }
}

/** Stats for a single knowledge base tier (project or global) */
interface KBStats {
  totalArticles: number;
  articlesPerDomain: Record<string, number>;
  lastFlushTimestamp: string | null;
  unprocessedLogCount: number;
  staleArticleCount: number;
}

/**
 * Gather knowledge base stats from a knowledge directory.
 * Pure filesystem inspection — no AI calls.
 */
async function gatherKBStats(knowledgePath: string): Promise<KBStats> {
  const stats: KBStats = {
    totalArticles: 0,
    articlesPerDomain: {},
    lastFlushTimestamp: null,
    unprocessedLogCount: 0,
    staleArticleCount: 0,
  };

  // Read last-flush.json
  let lastFlushDate: string | null = null;
  try {
    const metaContent = await readFile(join(knowledgePath, 'meta', 'last-flush.json'), 'utf-8');
    const meta = JSON.parse(metaContent) as { timestamp: string };
    stats.lastFlushTimestamp = meta.timestamp;
    lastFlushDate = meta.timestamp.slice(0, 10); // YYYY-MM-DD
  } catch {
    // No last-flush.json — KB hasn't been flushed yet
  }

  // Count unprocessed logs
  try {
    const logFiles = await readdir(join(knowledgePath, 'logs'));
    const dailyLogs = logFiles.filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f));
    if (lastFlushDate) {
      stats.unprocessedLogCount = dailyLogs.filter(
        f => f.replace('.md', '') > lastFlushDate
      ).length;
    } else {
      stats.unprocessedLogCount = dailyLogs.length;
    }
  } catch {
    // No logs directory
  }

  // Count articles per domain and staleness
  try {
    const domains = await readdir(join(knowledgePath, 'domains'));
    for (const domain of domains) {
      try {
        const files = await readdir(join(knowledgePath, 'domains', domain));
        const articles = files.filter(f => f.endsWith('.md') && f !== '_index.md');
        stats.articlesPerDomain[domain] = articles.length;
        stats.totalArticles += articles.length;

        // Check each article for staleness marker
        for (const file of articles) {
          try {
            const content = await readFile(join(knowledgePath, 'domains', domain, file), 'utf-8');
            if (content.includes('> [!WARNING] This article may be stale')) {
              stats.staleArticleCount++;
            }
          } catch {
            // Skip unreadable articles
          }
        }
      } catch {
        // Skip unreadable domains
      }
    }
  } catch {
    // No domains directory
  }

  return stats;
}

/**
 * `knowledge status` — display KB statistics.
 */
export async function knowledgeStatusCommand(
  cwd: string,
  project?: string,
  jsonFlag?: boolean,
  quiet?: boolean
): Promise<number> {
  const ownerRepo = await resolveOwnerRepo(cwd, project);
  if (!ownerRepo) return 1;

  const { owner, repo } = ownerRepo;

  const projectPath = getProjectKnowledgePath(owner, repo);
  const globalPath = getGlobalKnowledgePath();

  const projectStats = await gatherKBStats(projectPath);
  const globalStats = await gatherKBStats(globalPath);

  if (jsonFlag) {
    console.log(
      JSON.stringify(
        {
          project: { path: projectPath, owner, repo, ...projectStats },
          global: { path: globalPath, ...globalStats },
        },
        null,
        2
      )
    );
    return 0;
  }

  if (quiet) return 0;

  renderKBStats(`Project KB (${owner}/${repo})`, projectStats);
  process.stderr.write('\n');
  renderKBStats('Global KB', globalStats);

  return 0;
}

/**
 * Render KB stats to stderr.
 */
function renderKBStats(label: string, stats: KBStats): void {
  process.stderr.write(`${label}:\n`);
  process.stderr.write(`  Total articles:       ${stats.totalArticles}\n`);

  if (Object.keys(stats.articlesPerDomain).length > 0) {
    process.stderr.write('  Articles per domain:\n');
    for (const [domain, count] of Object.entries(stats.articlesPerDomain).sort()) {
      process.stderr.write(`    ${domain}: ${count}\n`);
    }
  }

  process.stderr.write(`  Last flush:           ${stats.lastFlushTimestamp ?? 'never'}\n`);
  process.stderr.write(`  Unprocessed logs:     ${stats.unprocessedLogCount}\n`);
  process.stderr.write(`  Stale articles:       ${stats.staleArticleCount}\n`);
}

/**
 * Render flush results to stderr/stdout.
 */
function renderFlushReport(report: KnowledgeFlushReport, quiet?: boolean): void {
  if (report.skipped) {
    if (!quiet) {
      process.stderr.write(`Skipped: ${report.skipReason ?? 'unknown reason'}\n`);
    }
    return;
  }

  if (quiet) return;

  const domains = report.domainsCreated.length > 0 ? report.domainsCreated.join(', ') : 'none';
  process.stderr.write(
    `\nFlush complete:\n  Articles created:  ${report.articlesCreated}\n  Articles updated:  ${report.articlesUpdated}\n  Articles stale:    ${report.articlesStale}\n  Domains created:   ${domains}\n  Logs processed:    ${report.logsProcessed.length}\n`
  );
}
