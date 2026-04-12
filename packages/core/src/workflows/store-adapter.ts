/**
 * WorkflowStore adapter — bridges @archon/core DB modules to the
 * IWorkflowStore trait defined in @archon/workflows.
 */
import type { IWorkflowStore } from '@archon/workflows/store';
import type { WorkflowConfig, WorkflowDeps } from '@archon/workflows/deps';
import type { WorkflowRunStatus } from '@archon/workflows/schemas/workflow-run';
import type { MergedConfig } from '../config/config-types';
import * as workflowDb from '../db/workflows';
import * as workflowEventDb from '../db/workflow-events';
import * as tokenUsageDb from '../db/token-usage';
import * as codebaseDb from '../db/codebases';
import * as envVarDb from '../db/env-vars';
import { getAssistantClient } from '../clients/factory';
import { loadConfig as loadMergedConfig } from '../config/config-loader';
import { extractKnowledgeFromContext } from '../services/knowledge-capture';
import {
  createLogger,
  getGlobalKnowledgePath,
  getProjectKnowledgePath,
  parseOwnerRepo,
} from '@archon/paths';
import {
  loadKnowledgeIndex,
  loadUnprocessedLogs,
  formatKnowledgeSection,
} from '../orchestrator/prompt-builder';
import * as git from '@archon/git';

// Compile-time assertion: MergedConfig must remain a structural subtype of WorkflowConfig.
// If MergedConfig drifts from WorkflowConfig, this line becomes a type error.
const assertConfigCompat: WorkflowConfig = {} as MergedConfig;
void assertConfigCompat;

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.store-adapter');
  return cachedLog;
}

export function createWorkflowStore(): IWorkflowStore {
  return {
    createWorkflowRun: workflowDb.createWorkflowRun,
    getWorkflowRun: workflowDb.getWorkflowRun,
    getActiveWorkflowRunByPath: workflowDb.getActiveWorkflowRunByPath,
    findResumableRun: workflowDb.findResumableRun,
    failOrphanedRuns: workflowDb.failOrphanedRuns,
    resumeWorkflowRun: workflowDb.resumeWorkflowRun,
    updateWorkflowRun: workflowDb.updateWorkflowRun,
    updateWorkflowActivity: workflowDb.updateWorkflowActivity,
    // DB returns string | null; IWorkflowStore declares WorkflowRunStatus | null.
    // The remote_agent_workflow_runs.status column is constrained to valid enum values
    // in SQL, so this cast is safe as long as the column constraint matches WorkflowRunStatus.
    getWorkflowRunStatus: id =>
      workflowDb.getWorkflowRunStatus(id) as Promise<WorkflowRunStatus | null>,
    completeWorkflowRun: workflowDb.completeWorkflowRun,
    failWorkflowRun: workflowDb.failWorkflowRun,
    pauseWorkflowRun: workflowDb.pauseWorkflowRun,
    cancelWorkflowRun: workflowDb.cancelWorkflowRun,
    createWorkflowEvent: async (data): Promise<void> => {
      try {
        await workflowEventDb.createWorkflowEvent(data);
      } catch (err) {
        // Belt-and-suspenders: workflowEventDb.createWorkflowEvent already catches internally,
        // but this wrapper guarantees the IWorkflowStore non-throwing contract at the boundary.
        getLog().error(
          { err: err as Error, eventType: data.event_type, runId: data.workflow_run_id },
          'workflow_event_create_unexpected_throw'
        );
      }
    },
    getCompletedDagNodeOutputs: workflowEventDb.getCompletedDagNodeOutputs,
    recordTokenUsage: async (data): Promise<void> => {
      try {
        await tokenUsageDb.recordTokenUsage(data);
      } catch (err) {
        getLog().error(
          { err: err as Error, provider: data.provider, model: data.model, nodeId: data.node_id },
          'token_usage.record_failed'
        );
      }
    },
    getCodebase: codebaseDb.getCodebase,
    getCodebaseEnvVars: envVarDb.getCodebaseEnvVars,
  };
}

/**
 * Load knowledge context for a project from its knowledge base.
 * Resolves owner/repo from cwd via git remote, then loads the knowledge index
 * and any unprocessed daily logs. Returns formatted string or empty on failure.
 */
async function loadKnowledgeContext(cwd: string, codebaseId?: string): Promise<string> {
  try {
    // Try to resolve owner/repo from codebase DB record first, then fall back to git remote
    let owner: string | undefined;
    let repo: string | undefined;

    if (codebaseId) {
      const codebase = await codebaseDb.getCodebase(codebaseId);
      if (codebase) {
        const parsed = parseOwnerRepo(codebase.name);
        if (parsed) {
          owner = parsed.owner;
          repo = parsed.repo;
        }
      }
    }

    if (!owner || !repo) {
      try {
        const repoPath = git.toRepoPath(cwd);
        const remoteUrl = await git.getRemoteUrl(repoPath);
        if (remoteUrl) {
          const urlParts = remoteUrl.replace(/\.git$/, '').split(/[/:]/);
          repo = urlParts.pop();
          owner = urlParts.pop();
        }
      } catch {
        // Git remote resolution failed — fall through to global-only
      }
    }

    // Load global knowledge
    const globalKnowledgePath = getGlobalKnowledgePath();
    const globalIndex = await loadKnowledgeIndex(globalKnowledgePath);

    // Load project knowledge if owner/repo resolved
    let projectIndex = '';
    let projectLogs = '';
    if (owner && repo) {
      const projectKnowledgePath = getProjectKnowledgePath(owner, repo);
      projectIndex = await loadKnowledgeIndex(projectKnowledgePath);
      projectLogs = await loadUnprocessedLogs(projectKnowledgePath);
    }

    // Prefer project logs over global logs
    const globalLogs = !projectLogs ? await loadUnprocessedLogs(globalKnowledgePath) : '';
    const unprocessedLogs = projectLogs || globalLogs;

    return formatKnowledgeSection(globalIndex, projectIndex, unprocessedLogs);
  } catch (err) {
    getLog().warn({ err: err as Error, cwd, codebaseId }, 'knowledge.context_load_failed');
    return '';
  }
}

/**
 * Create the canonical WorkflowDeps for the workflow engine.
 * Single construction point — avoids duplicating the wiring across callers.
 */
export function createWorkflowDeps(): WorkflowDeps {
  return {
    store: createWorkflowStore(),
    getAssistantClient,
    loadConfig: loadMergedConfig,
    extractKnowledge: extractKnowledgeFromContext,
    loadKnowledgeContext,
  };
}
