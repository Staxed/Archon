/**
 * Tests for knowledge-extract DAG node type.
 *
 * Uses a separate test batch to avoid mock.module pollution with dag-executor.test.ts.
 */
import { describe, test, expect, beforeEach, mock, type Mock } from 'bun:test';

// --- Mock logger (MUST come before imports) ---
const mockLogFn = mock(() => {});
const mockLogger = {
  info: mockLogFn,
  warn: mockLogFn,
  error: mockLogFn,
  debug: mockLogFn,
  trace: mockLogFn,
  fatal: mockLogFn,
  child: mock(() => mockLogger),
};
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  getCommandFolderSearchPaths: (folder?: string) => {
    const paths = ['.archon/commands'];
    if (folder) paths.unshift(folder);
    return paths;
  },
  getDefaultCommandsPath: () => '/nonexistent/defaults',
}));

// --- Imports (after mocks) ---
import { executeDagWorkflow } from './dag-executor';
import type { DagNode, KnowledgeExtractNode, NodeOutput, WorkflowRun } from './schemas';
import { isKnowledgeExtractNode } from './schemas';
import type { WorkflowDeps, IWorkflowPlatform, WorkflowConfig, KnowledgeExtractFn } from './deps';
import type { IWorkflowStore } from './store';

// --- Test helpers ---

function createMockStore(): IWorkflowStore {
  return {
    createWorkflowRun: mock(() => Promise.resolve({} as WorkflowRun)),
    getWorkflowRun: mock(() => Promise.resolve(null)),
    getActiveWorkflowRunByPath: mock(() => Promise.resolve(null)),
    findResumableRun: mock(() => Promise.resolve(null)),
    failOrphanedRuns: mock(() => Promise.resolve()),
    resumeWorkflowRun: mock(() => Promise.resolve()),
    updateWorkflowRun: mock(() => Promise.resolve()),
    updateWorkflowActivity: mock(() => Promise.resolve()),
    getWorkflowRunStatus: mock(() => Promise.resolve('running' as const)),
    completeWorkflowRun: mock(() => Promise.resolve()),
    failWorkflowRun: mock(() => Promise.resolve()),
    pauseWorkflowRun: mock(() => Promise.resolve()),
    cancelWorkflowRun: mock(() => Promise.resolve()),
    createWorkflowEvent: mock(() => Promise.resolve()),
    getCompletedDagNodeOutputs: mock(() => Promise.resolve([])),
    getCodebase: mock(() => Promise.resolve(null)),
    getCodebaseEnvVars: mock(() => Promise.resolve([])),
  };
}

function createMockPlatform(): IWorkflowPlatform {
  return {
    sendMessage: mock(() => Promise.resolve()),
    getStreamingMode: () => 'batch' as const,
    getPlatformType: () => 'test',
  };
}

function createMockConfig(): WorkflowConfig {
  return {
    assistant: 'claude',
    commands: {},
    assistants: {
      claude: { model: 'sonnet' },
      codex: { model: 'gpt-4' },
    },
  };
}

function createWorkflowRun(overrides?: Partial<WorkflowRun>): WorkflowRun {
  return {
    id: 'run-123',
    workflow_name: 'test-workflow',
    conversation_id: 'conv-123',
    parent_conversation_id: null,
    codebase_id: null,
    status: 'running',
    user_message: 'test',
    metadata: {},
    started_at: new Date(),
    completed_at: null,
    last_activity_at: null,
    working_path: '/tmp/test',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('knowledge-extract node', () => {
  let store: IWorkflowStore;
  let platform: IWorkflowPlatform;
  let config: WorkflowConfig;
  let mockExtractKnowledge: Mock<KnowledgeExtractFn>;

  beforeEach(() => {
    store = createMockStore();
    platform = createMockPlatform();
    config = createMockConfig();
    mockExtractKnowledge = mock(async () => 'Extracted: architecture decision about auth');
    mockLogFn.mockClear();
  });

  test('isKnowledgeExtractNode type guard works', () => {
    const node: KnowledgeExtractNode = {
      id: 'extract',
      knowledge_extract: 'Extract patterns from the analysis',
    };
    expect(isKnowledgeExtractNode(node)).toBe(true);
  });

  test('knowledge-extract node calls extractKnowledge callback', async () => {
    const nodes: DagNode[] = [
      {
        id: 'extract',
        knowledge_extract: 'Extract architecture decisions',
      } as KnowledgeExtractNode,
    ];

    const deps: WorkflowDeps = {
      store,
      getAssistantClient: () => ({
        sendQuery: async function* () {
          /* noop */
        },
        getType: () => 'claude',
      }),
      loadConfig: async () => config,
      extractKnowledge: mockExtractKnowledge,
    };

    const workflowRun = createWorkflowRun();
    (store.getWorkflowRunStatus as Mock<() => Promise<string | null>>).mockResolvedValue('running');

    await executeDagWorkflow(
      deps,
      platform,
      'conv-123',
      '/tmp/test',
      { name: 'test', nodes },
      workflowRun,
      'claude',
      'sonnet',
      '/tmp/artifacts',
      '/tmp/logs',
      'main',
      'docs/',
      config
    );

    expect(mockExtractKnowledge).toHaveBeenCalledTimes(1);
    const call = mockExtractKnowledge.mock.calls[0];
    expect(call[0]).toBe('Extract architecture decisions'); // prompt
    expect(call[2]).toBe('/tmp/test'); // cwd
    expect(call[3]).toEqual({ workflowRunId: 'run-123', nodeId: 'extract' }); // metadata
  });

  test('knowledge-extract node collects upstream outputs as context', async () => {
    // Use priorCompletedNodes to simulate a completed upstream node
    const nodes: DagNode[] = [
      { id: 'analyze', bash: 'echo "Found auth pattern"' } as DagNode,
      {
        id: 'extract',
        knowledge_extract: 'Extract patterns from $analyze.output',
        depends_on: ['analyze'],
      } as KnowledgeExtractNode,
    ];

    const deps: WorkflowDeps = {
      store,
      getAssistantClient: () => ({
        sendQuery: async function* () {
          /* noop */
        },
        getType: () => 'claude',
      }),
      loadConfig: async () => config,
      extractKnowledge: mockExtractKnowledge,
    };

    const workflowRun = createWorkflowRun();
    (store.getWorkflowRunStatus as Mock<() => Promise<string | null>>).mockResolvedValue('running');

    // Simulate 'analyze' node already completed with output
    const priorCompleted = new Map<string, string>();
    priorCompleted.set('analyze', 'Found auth pattern');

    await executeDagWorkflow(
      deps,
      platform,
      'conv-123',
      '/tmp/test',
      { name: 'test', nodes },
      workflowRun,
      'claude',
      'sonnet',
      '/tmp/artifacts',
      '/tmp/logs',
      'main',
      'docs/',
      config,
      undefined,
      undefined,
      priorCompleted
    );

    expect(mockExtractKnowledge).toHaveBeenCalledTimes(1);
    const call = mockExtractKnowledge.mock.calls[0];
    // Prompt should have $analyze.output substituted
    expect(call[0]).toContain('Found auth pattern');
    // Context should include upstream output
    expect(call[1]).toContain("Output from node 'analyze'");
    expect(call[1]).toContain('Found auth pattern');
  });

  test('knowledge-extract node fails if extractKnowledge not provided', async () => {
    const nodes: DagNode[] = [
      {
        id: 'extract',
        knowledge_extract: 'Extract patterns',
      } as KnowledgeExtractNode,
    ];

    const deps: WorkflowDeps = {
      store,
      getAssistantClient: () => ({
        sendQuery: async function* () {
          /* noop */
        },
        getType: () => 'claude',
      }),
      loadConfig: async () => config,
      // extractKnowledge NOT provided
    };

    const workflowRun = createWorkflowRun();
    (store.getWorkflowRunStatus as Mock<() => Promise<string | null>>).mockResolvedValue('running');

    // Should not throw — but the node should fail
    const result = await executeDagWorkflow(
      deps,
      platform,
      'conv-123',
      '/tmp/test',
      { name: 'test', nodes },
      workflowRun,
      'claude',
      'sonnet',
      '/tmp/artifacts',
      '/tmp/logs',
      'main',
      'docs/',
      config
    );

    // Workflow should fail because the node failed
    expect(store.failWorkflowRun).toHaveBeenCalled();
  });

  test('knowledge-extract node returns extracted content as output', async () => {
    mockExtractKnowledge.mockResolvedValue('## Decisions\n- Use JWT for auth');

    const nodes: DagNode[] = [
      {
        id: 'extract',
        knowledge_extract: 'Extract decisions',
      } as KnowledgeExtractNode,
    ];

    const deps: WorkflowDeps = {
      store,
      getAssistantClient: () => ({
        sendQuery: async function* () {
          /* noop */
        },
        getType: () => 'claude',
      }),
      loadConfig: async () => config,
      extractKnowledge: mockExtractKnowledge,
    };

    const workflowRun = createWorkflowRun();
    (store.getWorkflowRunStatus as Mock<() => Promise<string | null>>).mockResolvedValue('running');

    await executeDagWorkflow(
      deps,
      platform,
      'conv-123',
      '/tmp/test',
      { name: 'test', nodes },
      workflowRun,
      'claude',
      'sonnet',
      '/tmp/artifacts',
      '/tmp/logs',
      'main',
      'docs/',
      config
    );

    // The workflow should complete successfully
    expect(store.completeWorkflowRun).toHaveBeenCalled();
  });

  test('existing workflows without knowledge-extract nodes work unchanged', async () => {
    const nodes: DagNode[] = [{ id: 'build', bash: 'echo "built"' } as DagNode];

    const deps: WorkflowDeps = {
      store,
      getAssistantClient: () => ({
        sendQuery: async function* () {
          /* noop */
        },
        getType: () => 'claude',
      }),
      loadConfig: async () => config,
      // extractKnowledge not provided — should be fine for non-knowledge-extract workflows
    };

    const workflowRun = createWorkflowRun();
    (store.getWorkflowRunStatus as Mock<() => Promise<string | null>>).mockResolvedValue('running');

    // Simulate 'build' node already completed
    const priorCompleted = new Map<string, string>();
    priorCompleted.set('build', 'built');

    await executeDagWorkflow(
      deps,
      platform,
      'conv-123',
      '/tmp/test',
      { name: 'test', nodes },
      workflowRun,
      'claude',
      'sonnet',
      '/tmp/artifacts',
      '/tmp/logs',
      'main',
      'docs/',
      config,
      undefined,
      undefined,
      priorCompleted
    );

    // Should complete without issues
    expect(store.completeWorkflowRun).toHaveBeenCalled();
  });
});
