/**
 * Orchestrator prompt builder
 * Constructs the system prompt for the orchestrator agent with all
 * registered projects and available workflows.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createLogger,
  getGlobalKnowledgePath,
  getProjectKnowledgePath,
  parseOwnerRepo,
} from '@archon/paths';
import type { Codebase } from '../types';
import type { WorkflowDefinition } from '@archon/workflows/schemas/workflow';

// Lazy logger per orchestrator conventions — never initialize at module scope.
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('orchestrator.prompt-builder');
  return cachedLog;
}

/**
 * Format a single project for the orchestrator prompt.
 */
export function formatProjectSection(codebase: Codebase): string {
  let section = `### ${codebase.name}\n`;
  if (codebase.repository_url) {
    section += `- Repository: ${codebase.repository_url}\n`;
  }
  section += `- Directory: ${codebase.default_cwd}\n`;
  section += `- AI Provider: ${codebase.ai_assistant_type}\n`;
  return section;
}

/**
 * Format workflow list for the orchestrator prompt.
 */
export function formatWorkflowSection(workflows: readonly WorkflowDefinition[]): string {
  if (workflows.length === 0) {
    return 'No workflows available. Users can create workflows in `.archon/workflows/` as YAML files.\n';
  }

  let section = '';
  for (const w of workflows) {
    section += `**${w.name}**\n`;
    section += `  ${w.description}\n`;
    section += `  Type: DAG (${String(w.nodes.length)} nodes)\n`;
    section += '\n';
  }
  return section;
}

/**
 * Build the routing rules section of the prompt.
 */
export function buildRoutingRules(): string {
  return buildRoutingRulesWithProject();
}

/**
 * Build the routing rules section, optionally scoped to a specific project.
 * When projectName is provided, rule #4 defaults to that project instead of asking.
 */
export function buildRoutingRulesWithProject(projectName?: string): string {
  const rule4 = projectName
    ? `4. If ambiguous which project → use **${projectName}** (the active project)`
    : '4. If ambiguous which project → ask the user';

  return `## Routing Rules

1. If the user asks a question, wants to explore code, or needs help → answer directly
2. If the user wants structured development work → invoke the appropriate workflow
3. If the user mentions a specific project → use that project's name
${rule4}
5. If no project needed (general question) → answer directly without workflow
6. If the user wants to add a new project → clone it, then register it (see below)

## Workflow Invocation Format

When invoking a workflow, output the command as the VERY LAST line of your response:
/invoke-workflow {workflow-name} --project {project-name} --prompt "{task description}"

Rules:
- Use the project NAME (e.g., "my-project"), not an ID or path.
- The --prompt MUST be a complete, self-contained task description that fully captures the user's intent.
- Synthesize the prompt from conversation context — do NOT use vague references like "do what we discussed" or "yes, go ahead."
- The prompt should make sense to someone with NO knowledge of the conversation history.
- You may include a brief explanation before the command. The user will see this text.
- /invoke-workflow MUST be the absolute last thing in your response. Do NOT use any tools or generate additional text after it.

Routing behavior:
- If the user clearly wants work done (e.g., "create a plan for X", "implement Y", "fix Z") → include a brief explanation of what you're doing, then invoke the workflow.
- If the user is asking a question or it's unclear whether they want a workflow → answer their question directly. You may suggest a workflow by name (e.g., "I can run the **archon-assist** workflow for this if you'd like"), but do NOT include /invoke-workflow in your response.

Example (clear intent):
I'll analyze the orchestrator module architecture for you.
/invoke-workflow archon-assist --project my-project --prompt "Analyze the orchestrator module architecture: explain how it routes messages, manages sessions, and dispatches workflows to AI clients"

Example (ambiguous — answer directly):
User: "What do you think about adding dark mode?"
Response: "Adding dark mode would involve... [answer the question]. If you'd like me to create a plan for this, I can run the **archon-idea-to-pr** workflow."

## Project Setup

When a user asks to add a new project:
1. Clone the repository into ~/.archon/workspaces/:
   git clone https://github.com/{owner}/{repo} ~/.archon/workspaces/{owner}/{repo}/source
2. Register it by emitting this command on its own line:
   /register-project {project-name} {path-to-source}

Example:
   /register-project my-new-app /home/user/.archon/workspaces/user/my-new-app/source

To update a project's path:
   /update-project {project-name} {new-path}

To remove a registered project:
   /remove-project {project-name}

IMPORTANT: Always clone into ~/.archon/workspaces/{owner}/{repo}/source unless the user specifies a different location.`;
}

/**
 * Maximum character budget for the knowledge index (~4K tokens ≈ ~16KB).
 *
 * The index is injected into the agent system prompt on every workflow run,
 * so every byte costs tokens on every call. This ceiling is sized for a
 * mature multi-year project: 10-15 top-level domains with short summaries
 * should realistically land around 4-8KB, and 16KB gives comfortable
 * headroom for organic drift without needing revisits.
 *
 * If truncation fires in practice, the right fix is to audit why the index
 * grew (almost always the compile prompt getting chatty), not to raise the
 * cap again. The index is a navigation map, not the content itself.
 */
const KNOWLEDGE_INDEX_MAX_CHARS = 16384;

/**
 * Maximum character budget for raw unprocessed logs (~16K tokens ≈ ~64KB).
 *
 * Logs are only injected when the KB has captures since the last flush.
 * Auto-flush (10-min debounce) normally keeps volume much lower, so this
 * cap is a safety net for flush gaps rather than a per-run budget.
 *
 * Sizing: heavy capture rate is ~10 captures/day × ~2KB each = 20KB/day,
 * so 64KB comfortably handles a 3-day flush gap. A gap longer than that
 * is a broken-flush signal, not normal operation — the cap is deliberately
 * tight enough to truncate eventually rather than let a runaway log grow
 * unbounded.
 */
const KNOWLEDGE_LOGS_MAX_CHARS = 65536;

/**
 * Load a knowledge index.md file, returning its content or empty string if not found.
 * Gracefully handles ENOENT (empty KB state).
 */
export async function loadKnowledgeIndex(knowledgePath: string): Promise<string> {
  try {
    const indexPath = join(knowledgePath, 'index.md');
    const content = await readFile(indexPath, 'utf-8');
    // Truncate to stay within the token budget
    if (content.length > KNOWLEDGE_INDEX_MAX_CHARS) {
      getLog().warn(
        {
          indexPath,
          actualChars: content.length,
          maxChars: KNOWLEDGE_INDEX_MAX_CHARS,
          overflowChars: content.length - KNOWLEDGE_INDEX_MAX_CHARS,
        },
        'knowledge.index_truncated'
      );
      return content.slice(0, KNOWLEDGE_INDEX_MAX_CHARS) + '\n\n*(index truncated)*\n';
    }
    return content;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return '';
    }
    throw err;
  }
}

/**
 * Load unprocessed daily logs newer than the last flush timestamp.
 * If no last-flush.json exists, includes all daily logs (pre-first-flush state).
 * Returns concatenated log content truncated to the token budget.
 */
export async function loadUnprocessedLogs(knowledgePath: string): Promise<string> {
  const logsDir = join(knowledgePath, 'logs');
  const metaPath = join(knowledgePath, 'meta', 'last-flush.json');

  // Read the last-flush timestamp (if any)
  let lastFlushTimestamp: string | null = null;
  try {
    const metaContent = await readFile(metaPath, 'utf-8');
    const meta = JSON.parse(metaContent) as { timestamp?: string };
    if (meta.timestamp) {
      lastFlushTimestamp = meta.timestamp;
    }
  } catch {
    // No last-flush.json — include all logs
  }

  // List log files
  let logFiles: string[];
  try {
    const entries = await readdir(logsDir);
    logFiles = entries.filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();
  } catch {
    // No logs directory — nothing to include
    return '';
  }

  // Filter to only logs newer than last flush
  if (lastFlushTimestamp) {
    const flushDate = lastFlushTimestamp.slice(0, 10); // Extract YYYY-MM-DD
    logFiles = logFiles.filter(f => f.replace('.md', '') > flushDate);
  }

  if (logFiles.length === 0) return '';

  // Read and concatenate logs (newest first), respecting token budget
  let combined = '';
  let truncated = false;
  let truncatedFile: string | undefined;
  let droppedFileCount = 0;
  for (const file of logFiles.reverse()) {
    try {
      const content = await readFile(join(logsDir, file), 'utf-8');
      if (combined.length + content.length > KNOWLEDGE_LOGS_MAX_CHARS) {
        // Include partial content if we have room
        const remaining = KNOWLEDGE_LOGS_MAX_CHARS - combined.length;
        if (remaining > 200) {
          combined += content.slice(0, remaining) + '\n\n*(log truncated)*\n';
        }
        truncated = true;
        truncatedFile = file;
        break;
      }
      combined += content + '\n';
    } catch {
      // Skip unreadable files
    }
  }

  // Count log files that were skipped entirely because truncation fired
  // mid-iteration. After reverse(), logFiles is newest-first. Files after
  // the truncation point (older ones) are completely absent from the output.
  if (truncated && truncatedFile) {
    const truncatedIdx = logFiles.indexOf(truncatedFile);
    droppedFileCount = truncatedIdx >= 0 ? logFiles.length - truncatedIdx - 1 : 0;
  }

  if (truncated) {
    getLog().warn(
      {
        logsDir,
        maxChars: KNOWLEDGE_LOGS_MAX_CHARS,
        includedChars: combined.length,
        truncatedAtFile: truncatedFile,
        droppedOlderFiles: droppedFileCount,
        totalLogFiles: logFiles.length,
      },
      'knowledge.logs_truncated'
    );
  }

  return combined;
}

/**
 * Format knowledge base content as a prompt section.
 * Combines global and project indexes with project taking precedence.
 */
export function formatKnowledgeSection(
  globalIndex: string,
  projectIndex: string,
  unprocessedLogs?: string
): string {
  if (!globalIndex && !projectIndex && !unprocessedLogs) return '';

  let section = '\n## Knowledge Base\n\n';
  if (globalIndex) {
    section += '### Global Knowledge\n\n' + globalIndex.trim() + '\n\n';
  }
  if (projectIndex) {
    section += '### Project Knowledge\n\n' + projectIndex.trim() + '\n\n';
  }
  if (unprocessedLogs) {
    section += '### Recent Knowledge (unprocessed)\n\n' + unprocessedLogs.trim() + '\n\n';
  }
  return section;
}

/**
 * Build the full orchestrator system prompt.
 * Includes all registered projects, available workflows, and routing instructions.
 */
export async function buildOrchestratorPrompt(
  codebases: readonly Codebase[],
  workflows: readonly WorkflowDefinition[]
): Promise<string> {
  let prompt = `# Archon Orchestrator

You are Archon, an intelligent coding assistant that manages multiple projects.
Your working directory is ~/.archon/workspaces/ where all projects live.
You can answer questions directly or invoke workflows for structured development tasks.

## Registered Projects

`;

  if (codebases.length === 0) {
    prompt +=
      'No projects registered yet. Ask the user to add a project or clone a repository.\n\n';
  } else {
    for (const codebase of codebases) {
      prompt += formatProjectSection(codebase);
      prompt += '\n';
    }
  }

  prompt += '## Available Workflows\n\n';
  prompt += formatWorkflowSection(workflows);

  // Load global knowledge index and unprocessed logs
  const globalKnowledgePath = getGlobalKnowledgePath();
  const globalIndex = await loadKnowledgeIndex(globalKnowledgePath);
  const globalLogs = await loadUnprocessedLogs(globalKnowledgePath);
  const knowledgeSection = formatKnowledgeSection(globalIndex, '', globalLogs);
  if (knowledgeSection) {
    prompt += knowledgeSection;
  }

  prompt += buildRoutingRules();

  return prompt;
}

/**
 * Build a project-scoped orchestrator system prompt.
 * The scoped project is shown prominently; other projects are listed separately.
 * Routing rules default to the scoped project when ambiguous.
 */
export async function buildProjectScopedPrompt(
  scopedCodebase: Codebase,
  allCodebases: readonly Codebase[],
  workflows: readonly WorkflowDefinition[]
): Promise<string> {
  const otherCodebases = allCodebases.filter(c => c.id !== scopedCodebase.id);

  let prompt = `# Archon Orchestrator

You are Archon, an intelligent coding assistant that manages multiple projects.
Your working directory is ~/.archon/workspaces/ where all projects live.
You can answer questions directly or invoke workflows for structured development tasks.

This conversation is scoped to **${scopedCodebase.name}**. Use this project for all workflow invocations unless the user explicitly mentions a different project.

## Active Project

${formatProjectSection(scopedCodebase)}
`;

  if (otherCodebases.length > 0) {
    prompt += '## Other Registered Projects\n\n';
    for (const codebase of otherCodebases) {
      prompt += formatProjectSection(codebase);
      prompt += '\n';
    }
  }

  prompt += '## Available Workflows\n\n';
  prompt += formatWorkflowSection(workflows);

  // Load global and project knowledge indexes + unprocessed logs
  const globalKnowledgePath = getGlobalKnowledgePath();
  const globalIndex = await loadKnowledgeIndex(globalKnowledgePath);
  let projectIndex = '';
  let projectLogs = '';
  const parsed = parseOwnerRepo(scopedCodebase.name);
  if (parsed) {
    const projectKnowledgePath = getProjectKnowledgePath(parsed.owner, parsed.repo);
    projectIndex = await loadKnowledgeIndex(projectKnowledgePath);
    projectLogs = await loadUnprocessedLogs(projectKnowledgePath);
  }
  // Prefer project logs over global logs for the supplementary context
  const globalLogs = !projectLogs ? await loadUnprocessedLogs(globalKnowledgePath) : '';
  const unprocessedLogs = projectLogs || globalLogs;
  const knowledgeSection = formatKnowledgeSection(globalIndex, projectIndex, unprocessedLogs);
  if (knowledgeSection) {
    prompt += knowledgeSection;
  }

  prompt += buildRoutingRulesWithProject(scopedCodebase.name);

  return prompt;
}
