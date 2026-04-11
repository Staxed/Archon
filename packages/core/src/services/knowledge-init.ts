import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getProjectKnowledgePath, getGlobalKnowledgePath } from '@archon/paths';

/** Default domain subdirectories created during KB initialization */
const DEFAULT_DOMAINS = [
  'architecture',
  'decisions',
  'patterns',
  'lessons',
  'connections',
] as const;

/**
 * Initialize the knowledge base directory tree for a project.
 * Creates: knowledge/, meta/, logs/, domains/, and starting domain subdirs.
 * Idempotent — safe to call multiple times.
 */
export async function initKnowledgeDir(owner: string, repo: string): Promise<void> {
  const knowledgePath = getProjectKnowledgePath(owner, repo);
  await createKnowledgeTree(knowledgePath, owner, repo);
}

/**
 * Initialize the global knowledge base directory tree.
 * Creates: knowledge/, meta/, logs/, domains/, and starting domain subdirs.
 * Idempotent — safe to call multiple times.
 */
export async function initGlobalKnowledgeDir(): Promise<void> {
  const knowledgePath = getGlobalKnowledgePath();
  await createKnowledgeTreeGlobal(knowledgePath);
}

/**
 * Create the full KB directory tree at the given base path (project variant).
 */
async function createKnowledgeTree(basePath: string, _owner: string, _repo: string): Promise<void> {
  await createDirectoryStructure(basePath);
}

/**
 * Create the full KB directory tree at the given base path (global variant).
 */
async function createKnowledgeTreeGlobal(basePath: string): Promise<void> {
  await createDirectoryStructure(basePath);
}

/**
 * Shared implementation: creates the directory structure under a knowledge base path.
 */
async function createDirectoryStructure(basePath: string): Promise<void> {
  // Create top-level directories
  await mkdir(basePath, { recursive: true });
  await mkdir(join(basePath, 'meta'), { recursive: true });
  await mkdir(join(basePath, 'logs'), { recursive: true });

  // Create domains/ and each default domain subdirectory
  const domainsPath = join(basePath, 'domains');
  await mkdir(domainsPath, { recursive: true });

  for (const domain of DEFAULT_DOMAINS) {
    await mkdir(join(domainsPath, domain), { recursive: true });
  }
}

export { DEFAULT_DOMAINS };
