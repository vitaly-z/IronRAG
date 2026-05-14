import type { SetStateAction } from 'react';
import type { AssistantMessage, EvidenceBundle } from '@/shared/types';
import type { AssistantTurnExecutionResponse } from '@/shared/api/query';
import { mapAssistantTurnToEvidence } from '@/features/assistant/model/assistantAdapter';

export const STARTER_PROMPT_IDS = [
  'technologies',
  'deployment',
  'security',
  'storage',
] as const;

export const EMPTY_MESSAGES: AssistantMessage[] = [];

export type RetryableAssistantTurn = {
  question: string;
  diagnosis: string;
};

export function resolveStateAction<T>(action: SetStateAction<T>, previous: T): T {
  return typeof action === 'function'
    ? (action as (previousValue: T) => T)(previous)
    : action;
}

export function isTransientNetworkReject(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('networkerror') ||
    lower.includes('input stream') ||
    lower.includes('failed to fetch') ||
    lower.includes('load failed') ||
    lower.includes('body stream') ||
    lower.includes('timeout') ||
    lower.includes('abort')
  );
}

const TURN_RETRY_MAX_ATTEMPTS = 3;
const TURN_RETRY_BASE_DELAY_MS = 1000;
const TURN_RETRY_BACKOFF_FACTOR = 3;

/** Calls `createTurn` with exponential-backoff retry for transient
 *  network errors (timeout, connection reset, etc.).  Non-transient
 *  errors (4xx, 5xx) are re-thrown immediately. */
export async function createTurnWithRetry(
  sessionId: string,
  questionText: string,
  createTurn: (sessionId: string, contentText: string) => Promise<AssistantTurnExecutionResponse>,
): Promise<AssistantTurnExecutionResponse> {
  for (let attempt = 0; attempt <= TURN_RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      return await createTurn(sessionId, questionText);
    } catch (err: unknown) {
      const msg = typeof err === 'object' && err !== null && 'message' in err
        ? String(err.message)
        : String(err);
      if (!isTransientNetworkReject(msg) || attempt >= TURN_RETRY_MAX_ATTEMPTS) {
        throw err;
      }
      // Exponential backoff: 1s, 3s, 9s
      const delay = TURN_RETRY_BASE_DELAY_MS * TURN_RETRY_BACKOFF_FACTOR ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error('unreachable');
}

export function createUserMessage(question: string, now: number): AssistantMessage {
  return {
    id: `m-${now}`,
    role: 'user',
    content: question,
    timestamp: new Date(now).toISOString(),
  };
}

export function createPendingAssistantMessage(now: number): AssistantMessage {
  return {
    id: `m-pending-${now}`,
    role: 'assistant',
    content: '',
    timestamp: new Date(now).toISOString(),
  };
}

export function createErrorAssistantMessage(content: string): AssistantMessage {
  return {
    id: `m-err-${Date.now()}`,
    role: 'assistant',
    content,
    timestamp: new Date().toISOString(),
  };
}

export function applyTurnResultToMessages(
  messages: AssistantMessage[],
  pendingId: string,
  result: AssistantTurnExecutionResponse,
  emptyAnswerText: string,
): AssistantMessage[] {
  const answerText = result.responseTurn?.contentText ?? emptyAnswerText;
  const evidence = mapAssistantTurnToEvidence(result);

  return messages.map((message) =>
    message.id === pendingId
      ? {
          id: result.responseTurn?.id ?? pendingId,
          role: 'assistant',
          content: answerText,
          timestamp: result.responseTurn?.createdAt ?? message.timestamp,
          executionId: result.responseTurn?.executionId ?? null,
          evidence,
        }
      : message,
  );
}

export function latestEvidenceFromMessages(
  messages: AssistantMessage[],
): EvidenceBundle | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === 'assistant' && message.evidence) {
      return message.evidence;
    }
  }
  return undefined;
}
