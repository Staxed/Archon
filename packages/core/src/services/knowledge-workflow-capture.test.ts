import { describe, test, expect, mock, beforeEach } from 'bun:test';

// Mocks must be set up before importing the module under test
const mockSubscribe = mock((_listener: (event: unknown) => void) => mock(() => {}));
const mockGetConversationId = mock((_runId: string) => 'conv-123' as string | undefined);

mock.module('@archon/workflows/event-emitter', () => ({
  getWorkflowEventEmitter: () => ({
    subscribe: mockSubscribe,
    getConversationId: mockGetConversationId,
  }),
}));

const mockGetWorkflowRun = mock((_id: string) =>
  Promise.resolve({
    id: 'run-1',
    codebase_id: 'codebase-1',
    conversation_id: 'conv-123',
    workflow_name: 'test-workflow',
    status: 'completed',
  })
);

mock.module('../db/workflows', () => ({
  getWorkflowRun: mockGetWorkflowRun,
}));

const mockGetCodebase = mock((_id: string) =>
  Promise.resolve({ id: 'codebase-1', name: 'acme/widget', path: '/path' })
);

mock.module('../db/codebases', () => ({
  getCodebase: mockGetCodebase,
}));

const mockCaptureKnowledge = mock(
  (
    _conversationId: string,
    _owner: string,
    _repo: string,
    _config?: unknown,
    _additionalTranscript?: string
  ) =>
    Promise.resolve({
      logFile: '/path/to/log.md',
      extractedContent: 'some content',
      skipped: false,
    })
);

mock.module('./knowledge-capture', () => ({
  captureKnowledge: mockCaptureKnowledge,
}));

const mockReadFile = mock((_path: string, _encoding: string) =>
  Promise.resolve(
    '{"type":"workflow_start","workflow_name":"test","workflow_id":"run-1","ts":"2026-04-11T00:00:00Z"}\n' +
      '{"type":"assistant","content":"Hello world","workflow_id":"run-1","ts":"2026-04-11T00:00:01Z"}\n' +
      '{"type":"tool","tool_name":"Read","workflow_id":"run-1","ts":"2026-04-11T00:00:02Z"}\n'
  )
);

mock.module('node:fs/promises', () => ({
  readFile: mockReadFile,
}));

mock.module('@archon/paths', () => ({
  createLogger: () => ({
    info: () => {},
    debug: () => {},
    error: () => {},
    warn: () => {},
  }),
  getRunLogPath: (_owner: string, _repo: string, runId: string) =>
    `/home/.archon/workspaces/acme/widget/logs/${runId}.jsonl`,
  parseOwnerRepo: (name: string) => {
    const parts = name.split('/');
    if (parts.length !== 2) return null;
    return { owner: parts[0], repo: parts[1] };
  },
}));

// Import after mocks
import {
  subscribeToWorkflowCapture,
  resetWorkflowCaptureSubscription,
} from './knowledge-workflow-capture';

describe('knowledge-workflow-capture', () => {
  let capturedListener: ((event: unknown) => void) | null = null;

  beforeEach(() => {
    resetWorkflowCaptureSubscription();
    capturedListener = null;
    mockSubscribe.mockReset();
    mockSubscribe.mockImplementation((listener: (event: unknown) => void) => {
      capturedListener = listener;
      return mock(() => {});
    });
    mockGetConversationId.mockReset();
    mockGetConversationId.mockImplementation(() => 'conv-123');
    mockGetWorkflowRun.mockReset();
    mockGetWorkflowRun.mockImplementation(() =>
      Promise.resolve({
        id: 'run-1',
        codebase_id: 'codebase-1',
        conversation_id: 'conv-123',
        workflow_name: 'test-workflow',
        status: 'completed',
      })
    );
    mockGetCodebase.mockReset();
    mockGetCodebase.mockImplementation(() =>
      Promise.resolve({ id: 'codebase-1', name: 'acme/widget', path: '/path' })
    );
    mockCaptureKnowledge.mockReset();
    mockCaptureKnowledge.mockImplementation(() =>
      Promise.resolve({
        logFile: '/path/to/log.md',
        extractedContent: 'some content',
        skipped: false,
      })
    );
    mockReadFile.mockReset();
    mockReadFile.mockImplementation(() =>
      Promise.resolve(
        '{"type":"workflow_start","workflow_name":"test","workflow_id":"run-1","ts":"2026-04-11T00:00:00Z"}\n' +
          '{"type":"assistant","content":"Hello world","workflow_id":"run-1","ts":"2026-04-11T00:00:01Z"}\n' +
          '{"type":"tool","tool_name":"Read","workflow_id":"run-1","ts":"2026-04-11T00:00:02Z"}\n'
      )
    );
  });

  test('subscribes to workflow event emitter', () => {
    subscribeToWorkflowCapture();
    expect(mockSubscribe).toHaveBeenCalledTimes(1);
    expect(capturedListener).toBeFunction();
  });

  test('triggers capture on workflow_completed event', async () => {
    subscribeToWorkflowCapture();

    // Emit a workflow_completed event
    capturedListener!({
      type: 'workflow_completed',
      runId: 'run-1',
      workflowName: 'test-workflow',
      duration: 5000,
    });

    // Wait for async fire-and-forget
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(mockGetConversationId).toHaveBeenCalledWith('run-1');
    expect(mockGetWorkflowRun).toHaveBeenCalledWith('run-1');
    expect(mockGetCodebase).toHaveBeenCalledWith('codebase-1');
    expect(mockCaptureKnowledge).toHaveBeenCalledTimes(1);
    expect(mockCaptureKnowledge.mock.calls[0][0]).toBe('conv-123');
    expect(mockCaptureKnowledge.mock.calls[0][1]).toBe('acme');
    expect(mockCaptureKnowledge.mock.calls[0][2]).toBe('widget');
    // Should include workflow log content
    expect(mockCaptureKnowledge.mock.calls[0][4]).toContain('WORKFLOW EXECUTION LOG');
    expect(mockCaptureKnowledge.mock.calls[0][4]).toContain('Hello world');
    expect(mockCaptureKnowledge.mock.calls[0][4]).toContain('TOOL: Read');
  });

  test('ignores non-workflow_completed events', () => {
    subscribeToWorkflowCapture();

    capturedListener!({
      type: 'workflow_started',
      runId: 'run-1',
      workflowName: 'test-workflow',
      conversationId: 'conv-123',
    });

    expect(mockGetWorkflowRun).not.toHaveBeenCalled();
  });

  test('skips when no conversationId found', async () => {
    mockGetConversationId.mockImplementation(() => undefined);
    subscribeToWorkflowCapture();

    capturedListener!({
      type: 'workflow_completed',
      runId: 'run-unknown',
      workflowName: 'test-workflow',
      duration: 5000,
    });

    await new Promise(resolve => setTimeout(resolve, 50));
    expect(mockGetWorkflowRun).not.toHaveBeenCalled();
    expect(mockCaptureKnowledge).not.toHaveBeenCalled();
  });

  test('skips when workflow run has no codebase_id', async () => {
    mockGetWorkflowRun.mockImplementation(() =>
      Promise.resolve({
        id: 'run-1',
        codebase_id: null,
        conversation_id: 'conv-123',
        workflow_name: 'test-workflow',
        status: 'completed',
      })
    );
    subscribeToWorkflowCapture();

    capturedListener!({
      type: 'workflow_completed',
      runId: 'run-1',
      workflowName: 'test-workflow',
      duration: 5000,
    });

    await new Promise(resolve => setTimeout(resolve, 50));
    expect(mockCaptureKnowledge).not.toHaveBeenCalled();
  });

  test('skips when codebase name is not owner/repo format', async () => {
    mockGetCodebase.mockImplementation(() =>
      Promise.resolve({ id: 'codebase-1', name: 'local-project', path: '/path' })
    );
    subscribeToWorkflowCapture();

    capturedListener!({
      type: 'workflow_completed',
      runId: 'run-1',
      workflowName: 'test-workflow',
      duration: 5000,
    });

    await new Promise(resolve => setTimeout(resolve, 50));
    expect(mockCaptureKnowledge).not.toHaveBeenCalled();
  });

  test('handles missing JSONL log gracefully', async () => {
    mockReadFile.mockImplementation(() => Promise.reject(new Error('ENOENT')));
    subscribeToWorkflowCapture();

    capturedListener!({
      type: 'workflow_completed',
      runId: 'run-1',
      workflowName: 'test-workflow',
      duration: 5000,
    });

    await new Promise(resolve => setTimeout(resolve, 50));
    // Capture still called, but with empty additional transcript
    expect(mockCaptureKnowledge).toHaveBeenCalledTimes(1);
    expect(mockCaptureKnowledge.mock.calls[0][4]).toBe('');
  });

  test('does not block on capture errors', async () => {
    mockCaptureKnowledge.mockImplementation(() => Promise.reject(new Error('capture failed')));
    subscribeToWorkflowCapture();

    // Should not throw
    capturedListener!({
      type: 'workflow_completed',
      runId: 'run-1',
      workflowName: 'test-workflow',
      duration: 5000,
    });

    await new Promise(resolve => setTimeout(resolve, 50));
    // No assertion needed — just verify it doesn't throw
    expect(mockCaptureKnowledge).toHaveBeenCalled();
  });
});
