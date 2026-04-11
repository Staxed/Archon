/**
 * Knowledge commands — manage the persistent knowledge base.
 */
import { createLogger, parseOwnerRepo } from '@archon/paths';
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
