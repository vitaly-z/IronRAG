import { afterEach, describe, expect, it, vi } from 'vitest';

import { Query } from './generated';
import { queryApi } from './query';

function streamThatFailsAfterActivity(): ReadableStream<Uint8Array> {
  let pulled = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!pulled) {
        pulled = true;
        controller.enqueue(
          new TextEncoder().encode(
            'event: assistant_turn\n' +
              'data: {"type":"activity","event":{"type":"started"}}\n\n',
          ),
        );
        return;
      }
      throw new Error('Error in input stream');
    },
  });
}

function streamWithBackendFailureEvent(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          'event: assistant_turn\n' +
            'data: {"type":"activity","event":{"type":"started"}}\n\n' +
            'event: assistant_turn\n' +
            'data: {"type":"failed","message":"Error in input stream"}\n\n',
        ),
      );
      controller.close();
    },
  });
}

describe('queryApi.createTurnStream', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('recovers a completed turn from the durable session when SSE transport fails mid-stream', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(streamThatFailsAfterActivity(), { status: 200 }),
    );
    vi.spyOn(Query, 'getQuerySession')
      .mockResolvedValueOnce({
        data: {
          session: {
            conversationState: 'active',
            createdAt: '2026-05-13T00:00:00.000Z',
            id: 'session-1',
            libraryId: 'library-1',
            title: 'Question',
          turnCount: 2,
          updatedAt: '2026-05-13T00:00:00.000Z',
          workspaceId: 'workspace-1',
        },
          messages: [
            {
              content: 'Question',
              id: 'old-user',
              role: 'user',
              timestamp: '2026-05-13T00:00:00.000Z',
            },
            {
              content: 'Old answer',
              executionId: 'old-execution',
              id: 'old-assistant',
              role: 'assistant',
              timestamp: '2026-05-13T00:00:01.000Z',
            },
          ],
        },
      } as never)
      .mockResolvedValue({
      data: {
        session: {
          conversationState: 'active',
          createdAt: '2026-05-13T00:00:00.000Z',
          id: 'session-1',
          libraryId: 'library-1',
          title: 'Question',
          turnCount: 2,
          updatedAt: '2026-05-13T00:00:01.000Z',
          workspaceId: 'workspace-1',
        },
        messages: [
          {
            content: 'Question',
            id: 'old-user',
            role: 'user',
            timestamp: '2026-05-13T00:00:00.000Z',
          },
          {
            content: 'Old answer',
            executionId: 'old-execution',
            id: 'old-assistant',
            role: 'assistant',
            timestamp: '2026-05-13T00:00:01.000Z',
          },
          {
            content: 'Question',
            id: 'turn-user',
            role: 'user',
            timestamp: '2026-05-13T00:00:00.000Z',
          },
          {
            content: 'Answer',
            executionId: 'execution-1',
            id: 'turn-assistant',
            role: 'assistant',
            timestamp: '2026-05-13T00:00:01.000Z',
          },
        ],
      },
    } as never);
    vi.spyOn(Query, 'getQueryExecution').mockResolvedValue({
      data: {
        chunkReferences: [],
        contextBundleId: 'bundle-1',
        entityReferences: [],
        execution: {
          contextBundleId: 'bundle-1',
          conversationId: 'session-1',
          id: 'execution-1',
          libraryId: 'library-1',
          lifecycleState: 'succeeded',
          queryText: 'Question',
          startedAt: '2026-05-13T00:00:00.000Z',
          workspaceId: 'workspace-1',
        },
        preparedSegmentReferences: [],
        relationReferences: [],
        requestTurn: null,
        responseTurn: {
          authorPrincipalId: null,
          contentText: 'Answer',
          conversationId: 'session-1',
          createdAt: '2026-05-13T00:00:01.000Z',
          executionId: 'execution-1',
          id: 'turn-assistant',
          turnIndex: 2,
          turnKind: 'assistant',
        },
        runtimeStageSummaries: [],
        runtimeSummary: {
          acceptedAt: '2026-05-13T00:00:00.000Z',
          lifecycleState: 'succeeded',
          parallelActionLimit: 1,
          policySummary: {
            allowCount: 0,
            recentDecisions: [],
            rejectCount: 0,
            terminateCount: 0,
          },
          runtimeExecutionId: 'runtime-1',
          turnBudget: 1,
          turnCount: 1,
        },
        technicalFactReferences: [],
        verificationState: 'verified',
        verificationWarnings: [],
      },
    } as never);

    const result = await queryApi.createTurnStream('session-1', 'Question');

    expect(result.responseTurn?.contentText).toBe('Answer');
    expect(Query.getQuerySession).toHaveBeenCalledWith({ path: { sessionId: 'session-1' } });
    expect(Query.getQueryExecution).toHaveBeenCalledWith({ path: { executionId: 'execution-1' } });
    expect(Query.getQueryExecution).not.toHaveBeenCalledWith({ path: { executionId: 'old-execution' } });
  });

  it('does not hide backend failure events behind durable-session recovery', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(streamWithBackendFailureEvent(), { status: 200 }),
    );
    const getSession = vi.spyOn(Query, 'getQuerySession').mockResolvedValue({
      data: {
        session: {
          conversationState: 'active',
          createdAt: '2026-05-13T00:00:00.000Z',
          id: 'session-1',
          libraryId: 'library-1',
          title: 'Question',
          turnCount: 0,
          updatedAt: '2026-05-13T00:00:00.000Z',
          workspaceId: 'workspace-1',
        },
        messages: [],
      },
    } as never);

    await expect(queryApi.createTurnStream('session-1', 'Question')).rejects.toThrow(
      'Error in input stream',
    );
    expect(getSession).toHaveBeenCalledTimes(1);
  });
});
