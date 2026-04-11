import { mkdir, writeFile } from 'node:fs/promises';
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

/** KB structure description for AI agents — loaded at session start */
const SCHEMA_TEMPLATE = `# Knowledge Base Schema

## Structure

\`\`\`
knowledge/
├── index.md                  # Entry point — start here
├── meta/
│   ├── schema.md             # This file
│   └── last-flush.json       # Last compile timestamp
├── logs/
│   └── YYYY-MM-DD.md         # Daily capture logs (raw)
└── domains/
    ├── architecture/         # System design, components, data flow
    ├── decisions/            # ADRs, trade-offs, rationale
    ├── patterns/             # Recurring code/workflow patterns
    ├── lessons/              # Mistakes, gotchas, debugging insights
    └── connections/          # Cross-domain links, dependency maps
\`\`\`

## Navigation

1. Start at [[index]] for a summary of all domains
2. Each domain has a \`_index.md\` listing its articles
3. Articles use [[wikilinks]] to cross-reference related concepts
4. New domains can be created organically during compilation

## Conventions

- Articles use standard markdown with [[wikilink]] backlinks
- Staleness warnings appear as \`> [!WARNING]\` admonitions
- Daily logs in \`logs/\` are raw capture output — not curated
- Compiled articles in \`domains/\` are synthesized and maintained
`;

/** Top-level index template — the agent's entry point (~500 tokens) */
const INDEX_TEMPLATE = `# Knowledge Base Index

> This index is auto-maintained. Navigate to domain indexes for detailed articles.

## Domains

### [[domains/architecture/_index|Architecture]]
System design, components, data flow, and technical infrastructure.

### [[domains/decisions/_index|Decisions]]
Architectural decision records, trade-offs, and rationale.

### [[domains/patterns/_index|Patterns]]
Recurring code patterns, workflow conventions, and best practices.

### [[domains/lessons/_index|Lessons]]
Mistakes encountered, debugging insights, and gotchas to avoid.

### [[domains/connections/_index|Connections]]
Cross-domain links, dependency maps, and system relationships.
`;

/** Domain-specific _index.md templates */
const DOMAIN_INDEX_TEMPLATES: Record<string, string> = {
  architecture: `# Architecture

System design, components, data flow, and technical infrastructure.

## Articles

_No articles yet. Articles will appear here as knowledge is compiled._
`,
  decisions: `# Decisions

Architectural decision records, trade-offs, and rationale.

## Articles

_No articles yet. Articles will appear here as knowledge is compiled._
`,
  patterns: `# Patterns

Recurring code patterns, workflow conventions, and best practices.

## Articles

_No articles yet. Articles will appear here as knowledge is compiled._
`,
  lessons: `# Lessons

Mistakes encountered, debugging insights, and gotchas to avoid.

## Articles

_No articles yet. Articles will appear here as knowledge is compiled._
`,
  connections: `# Connections

Cross-domain links, dependency maps, and system relationships.

## Articles

_No articles yet. Articles will appear here as knowledge is compiled._
`,
};

/**
 * Initialize the knowledge base directory tree for a project.
 * Creates: knowledge/, meta/, logs/, domains/, starting domain subdirs, and template files.
 * Idempotent — safe to call multiple times. Templates only written if files don't exist.
 */
export async function initKnowledgeDir(owner: string, repo: string): Promise<void> {
  const knowledgePath = getProjectKnowledgePath(owner, repo);
  await createKnowledgeTree(knowledgePath, owner, repo);
}

/**
 * Initialize the global knowledge base directory tree.
 * Creates: knowledge/, meta/, logs/, domains/, starting domain subdirs, and template files.
 * Idempotent — safe to call multiple times. Templates only written if files don't exist.
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
 * Write a file only if it doesn't already exist. Uses 'wx' flag which fails on existing files.
 */
async function writeIfNotExists(filePath: string, content: string): Promise<void> {
  try {
    await writeFile(filePath, content, { flag: 'wx' });
  } catch (err) {
    // EEXIST means file already exists — skip silently (idempotent)
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw err;
    }
  }
}

/**
 * Shared implementation: creates the directory structure and template files under a knowledge base path.
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

  // Write template files (only if they don't already exist)
  await writeIfNotExists(join(basePath, 'meta', 'schema.md'), SCHEMA_TEMPLATE);
  await writeIfNotExists(join(basePath, 'index.md'), INDEX_TEMPLATE);

  for (const domain of DEFAULT_DOMAINS) {
    const template = DOMAIN_INDEX_TEMPLATES[domain];
    if (template) {
      await writeIfNotExists(join(domainsPath, domain, '_index.md'), template);
    }
  }
}

export { DEFAULT_DOMAINS, SCHEMA_TEMPLATE, INDEX_TEMPLATE, DOMAIN_INDEX_TEMPLATES };
