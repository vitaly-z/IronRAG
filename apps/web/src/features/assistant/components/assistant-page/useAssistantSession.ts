import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type SetStateAction,
} from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { toast } from 'sonner';
import {
  mapAssistantMessage,
  mapAssistantSession,
} from '@/features/assistant/model/assistantAdapter';
import { queryApi, queries } from '@/shared/api';
import type {
  AssistantSessionListItem,
  QueryConversation,
} from '@/shared/api/generated';
import type {
  AssistantTurnExecutionResponse,
  LlmContextDebugResponse,
} from '@/shared/api/query';
import { errorMessage } from '@/shared/lib/errorMessage';
import type {
  AssistantAgentActivityEvent,
  AssistantMessage,
  AssistantSession,
} from '@/shared/types';
import {
  applyTurnResultToMessages,
  createPendingAssistantMessage,
  createUserMessage,
  EMPTY_MESSAGES,
  latestEvidenceFromMessages,
  resolveStateAction,
  type RetryableAssistantTurn,
} from './assistantPageState';

type UseAssistantSessionParams = {
  workspaceId: string | undefined;
  libraryId: string | undefined;
  t: TFunction;
};

type SendQuestionVariables = {
  existingSessionId: string | null;
  libraryId: string;
  optimisticSessionId: string | null;
  pendingMessage: AssistantMessage;
  questionText: string;
  requestScope: string;
  sessionsQueryKey: QueryKey;
  userMessage: AssistantMessage;
  workspaceId: string;
};

type SendQuestionResult = {
  pendingMessageId: string;
  result: AssistantTurnExecutionResponse;
  sessionId: string;
};

type SendQuestionContext = {
  previousActiveSession: string | null;
  previousMessages: AssistantMessage[];
  previousSessions: AssistantSessionListItem[] | undefined;
};

function useScopedState<T>(
  scopeKey: string | null,
  initialValue: T,
): [T, (action: SetStateAction<T>) => void] {
  const [state, setState] = useState<{ scopeKey: string | null; value: T }>(() => ({
    scopeKey,
    value: initialValue,
  }));
  const value = state.scopeKey === scopeKey ? state.value : initialValue;
  const setScopedState = useCallback(
    (action: SetStateAction<T>) => {
      setState((current) => {
        const previous = current.scopeKey === scopeKey ? current.value : initialValue;
        return {
          scopeKey,
          value: resolveStateAction(action, previous),
        };
      });
    },
    [initialValue, scopeKey],
  );
  return [value, setScopedState];
}

function sessionListItemFromConversation(
  session: QueryConversation,
  fallbackTitle: string,
  turnCount: number,
): AssistantSessionListItem {
  return {
    conversationState: session.conversation_state,
    createdAt: session.created_at,
    id: session.id,
    libraryId: session.library_id,
    title: session.title ?? fallbackTitle,
    turnCount,
    updatedAt: session.updated_at,
    workspaceId: session.workspace_id,
  };
}

function appendPendingActivity(
  message: AssistantMessage,
  event: AssistantAgentActivityEvent,
): AssistantMessage {
  return {
    ...message,
    activityEvents: [...(message.activityEvents ?? []), event].slice(-24),
  };
}

export function useAssistantSession({
  workspaceId,
  libraryId,
  t,
}: UseAssistantSessionParams) {
  const queryClient = useQueryClient();
  const [isExecuting, setIsExecuting] = useState(false);
  const libraryScopeKey =
    workspaceId && libraryId ? `${workspaceId}:${libraryId}` : null;
  const [activeSession, setActiveSession] = useScopedState<string | null>(
    libraryScopeKey,
    null,
  );
  const [messages, setMessages] = useScopedState<AssistantMessage[]>(
    libraryScopeKey,
    EMPTY_MESSAGES,
  );
  const [retryable, setRetryable] =
    useScopedState<RetryableAssistantTurn | null>(libraryScopeKey, null);
  const [sessionSearch, setSessionSearch] = useScopedState(libraryScopeKey, '');
  const [debugContext, setDebugContext] =
    useScopedState<LlmContextDebugResponse | null>(libraryScopeKey, null);
  const [debugLoadingId, setDebugLoadingId] = useScopedState<string | null>(
    libraryScopeKey,
    null,
  );
  const [debugError, setDebugError] = useScopedState<string | null>(
    libraryScopeKey,
    null,
  );
  const libraryScopeRef = useRef<string | null>(libraryScopeKey);
  const activeSessionRef = useRef<string | null>(activeSession);
  const debugRequestRef = useRef(0);
  const executingRef = useRef(false);
  const hydratedSessionRef = useRef<string | null>(null);
  const [optimisticSessionId, setOptimisticSessionId] = useState<string | null>(null);

  useEffect(() => {
    libraryScopeRef.current = libraryScopeKey;
  }, [libraryScopeKey]);

  useEffect(() => {
    activeSessionRef.current = activeSession;
    debugRequestRef.current += 1;
    setDebugContext(null);
    setDebugError(null);
    setDebugLoadingId(null);
  }, [activeSession, setDebugContext, setDebugError, setDebugLoadingId]);

  const sessionsQueryOptions = queries.listQuerySessionsOptions(
    libraryId ? { query: { libraryId } } : undefined,
  );

  const {
    data: sessionsData,
    error: sessionsError,
    refetch: refetchSessions,
  } = useQuery({
    ...sessionsQueryOptions,
    enabled: !!libraryId && !!libraryScopeKey,
  });

  useEffect(() => {
    if (sessionsError) {
      toast.error(errorMessage(sessionsError, t('assistant.loadSessionsFailed')));
    }
  }, [sessionsError, t]);

  const activeSessionIsOptimistic =
    activeSession !== null && activeSession === optimisticSessionId;

  const { data: sessionData, error: sessionError } = useQuery({
    ...queries.getQuerySessionOptions({
      path: { sessionId: activeSession ?? '' },
    }),
    enabled: !!activeSession && !activeSessionIsOptimistic && !!libraryScopeKey,
  });

  useEffect(() => {
    if (!activeSession) {
      hydratedSessionRef.current = null;
      return;
    }
    if (hydratedSessionRef.current === activeSession) return;
    if (!sessionData) {
      if (sessionError) {
        hydratedSessionRef.current = activeSession;
        const sessionId = activeSession;
        queueMicrotask(() => {
          if (hydratedSessionRef.current === sessionId) {
            setMessages(EMPTY_MESSAGES);
          }
        });
      }
      return;
    }
    const data = sessionData;
    if (data.session.libraryId !== libraryId) return;
    hydratedSessionRef.current = activeSession;
    const sessionId = activeSession;
    const nextMessages = data.messages.map(mapAssistantMessage);
    queueMicrotask(() => {
      if (hydratedSessionRef.current === sessionId) {
        setMessages(nextMessages);
      }
    });
  }, [activeSession, libraryId, sessionData, sessionError, setMessages]);

  const sessions = useMemo<AssistantSession[]>(() => {
    if (!sessionsData || !libraryId) return [];
    return sessionsData
      .map(mapAssistantSession)
      .filter((session) => session.libraryId === libraryId);
  }, [libraryId, sessionsData]);

  const sendQuestionMutation = useMutation<
    SendQuestionResult,
    unknown,
    SendQuestionVariables,
    SendQuestionContext
  >({
    mutationKey: ['assistant', 'send-turn', libraryId],
    scope: { id: `assistant:send-turn:${libraryScopeKey ?? 'none'}` },
    mutationFn: async (variables) => {
      let sessionId = variables.existingSessionId;
      if (!sessionId) {
        const session = await queryApi.createSession(
          variables.workspaceId,
          variables.libraryId,
        );
        sessionId = session.id;
        hydratedSessionRef.current = sessionId;
        setOptimisticSessionId(null);
        const sessionItem = sessionListItemFromConversation(
          session,
          variables.questionText,
          1,
        );
        if (libraryScopeRef.current === variables.requestScope) {
          activeSessionRef.current = sessionId;
          setActiveSession(sessionId);
        }
        queryClient.setQueryData<AssistantSessionListItem[]>(
          variables.sessionsQueryKey,
          (current = []) => [
            sessionItem,
            ...current.filter(
              (candidate) =>
                candidate.id !== variables.optimisticSessionId &&
                candidate.id !== sessionItem.id,
            ),
          ],
        );
      }

      const result = await queryApi.createTurnStream(
        sessionId,
        variables.questionText,
        (event) => {
          if (
            libraryScopeRef.current !== variables.requestScope ||
            activeSessionRef.current !== sessionId
          ) {
            return;
          }
          setMessages((current) =>
            current.map((message) =>
              message.id === variables.pendingMessage.id
                ? appendPendingActivity(message, event)
                : message,
            ),
          );
        },
      );

      return {
        pendingMessageId: variables.pendingMessage.id,
        result,
        sessionId,
      };
    },
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: variables.sessionsQueryKey });
      const previousSessions =
        queryClient.getQueryData<AssistantSessionListItem[]>(
          variables.sessionsQueryKey,
        );
      const previousActiveSession = activeSessionRef.current;
      const previousMessages = messages;

      if (libraryScopeRef.current !== variables.requestScope) {
        return {
          previousActiveSession,
          previousMessages,
          previousSessions,
        };
      }

      if (variables.optimisticSessionId) {
        setOptimisticSessionId(variables.optimisticSessionId);
        activeSessionRef.current = variables.optimisticSessionId;
        setActiveSession(variables.optimisticSessionId);
        queryClient.setQueryData<AssistantSessionListItem[]>(
          variables.sessionsQueryKey,
          (current = []) => [
            {
              conversationState: 'active',
              createdAt: variables.userMessage.timestamp,
              id: variables.optimisticSessionId as string,
              libraryId: variables.libraryId,
              title: variables.questionText,
              turnCount: 1,
              updatedAt: variables.userMessage.timestamp,
              workspaceId: variables.workspaceId,
            },
            ...current,
          ],
        );
      }

      setMessages((current) => [
        ...current,
        variables.userMessage,
        variables.pendingMessage,
      ]);
      setRetryable(null);
      setIsExecuting(true);
      return {
        previousActiveSession,
        previousMessages,
        previousSessions,
      };
    },
    onSuccess: ({ pendingMessageId, result, sessionId }, variables) => {
      if (
        libraryScopeRef.current === variables.requestScope &&
        activeSessionRef.current === sessionId
      ) {
        setMessages((current) =>
          applyTurnResultToMessages(
            current,
            pendingMessageId,
            result,
            t('assistant.noResponseGenerated'),
          ),
        );
        setRetryable(null);
      }
    },
    onError: (err, variables, context) => {
      const rawMessage = errorMessage(err, t('assistant.unknownError'));
      const inlineError = t('assistant.turnFailedInline', { error: rawMessage });
      if (context) {
        if (libraryScopeRef.current === variables.requestScope) {
          const activeIsUnresolvedOptimistic =
            variables.optimisticSessionId !== null &&
            activeSessionRef.current === variables.optimisticSessionId;
          if (activeIsUnresolvedOptimistic) {
            queryClient.setQueryData(
              variables.sessionsQueryKey,
              context.previousSessions,
            );
            setOptimisticSessionId(null);
            activeSessionRef.current = context.previousActiveSession;
            setActiveSession(context.previousActiveSession);
          }
          setMessages((current) => {
            const hasPendingMessage = current.some(
              (message) => message.id === variables.pendingMessage.id,
            );
            if (!hasPendingMessage) return context.previousMessages;
            return current.map((message) =>
              message.id === variables.pendingMessage.id
                ? {
                    ...message,
                    content: inlineError,
                  }
                : message,
            );
          });
          setRetryable({
            question: variables.questionText,
            diagnosis: rawMessage,
          });
        }
      }
      toast.error(
        t('assistant.mutations.sendTurn.failed', { error: rawMessage }),
      );
    },
    onSettled: (_data, _err, variables) => {
      executingRef.current = false;
      setIsExecuting(false);
      if (variables) {
        void queryClient.invalidateQueries({ queryKey: variables.sessionsQueryKey });
      }
      if (!variables || libraryScopeRef.current === variables.requestScope) {
        void refetchSessions();
      }
    },
  });
  const { mutate: mutateSendQuestion } = sendQuestionMutation;

  const selectSession = useCallback(
    (sessionId: string) => {
      if (executingRef.current) return;
      const session = sessions.find(
        (candidate) =>
          candidate.id === sessionId && candidate.libraryId === libraryId,
      );
      if (!session) return;
      activeSessionRef.current = sessionId;
      setActiveSession(sessionId);
    },
    [libraryId, sessions, setActiveSession],
  );

  const newSession = useCallback(() => {
    if (executingRef.current) return;
    activeSessionRef.current = null;
    setActiveSession(null);
    setMessages([]);
    setRetryable(null);
    setDebugContext(null);
    setDebugError(null);
  }, [setActiveSession, setDebugContext, setDebugError, setMessages, setRetryable]);

  const openDebugFor = useCallback(
    async (executionId: string) => {
      const requestId = debugRequestRef.current + 1;
      debugRequestRef.current = requestId;
      const requestSession = activeSessionRef.current;
      setDebugLoadingId(executionId);
      setDebugError(null);
      try {
        const snapshot = await queryApi.getExecutionLlmContext(executionId);
        if (
          debugRequestRef.current === requestId &&
          activeSessionRef.current === requestSession
        ) {
          setDebugContext(snapshot);
        }
      } catch (err: unknown) {
        if (
          debugRequestRef.current === requestId &&
          activeSessionRef.current === requestSession
        ) {
          const message = errorMessage(err, t('assistant.llmContextUnavailable'));
          setDebugError(message);
          toast.error(message);
        }
      } finally {
        if (
          debugRequestRef.current === requestId &&
          activeSessionRef.current === requestSession
        ) {
          setDebugLoadingId(null);
        }
      }
    },
    [setDebugContext, setDebugError, setDebugLoadingId, t],
  );

  const sendQuestion = useCallback(
    (rawQuestion: string): boolean => {
      const questionText = rawQuestion.trim();
      if (
        !questionText ||
        !workspaceId ||
        !libraryId ||
        !libraryScopeKey ||
        executingRef.current
      ) {
        return false;
      }

      executingRef.current = true;
      const requestScope = libraryScopeKey;
      const now = Date.now();
      const pendingMessage = createPendingAssistantMessage(now);
      const currentSessionId = activeSessionRef.current;
      const existingSessionId =
        sessions.some(
          (session) =>
            session.id === currentSessionId && session.libraryId === libraryId,
        )
          ? currentSessionId
          : null;

      mutateSendQuestion({
        existingSessionId,
        libraryId,
        optimisticSessionId: existingSessionId
          ? null
          : `optimistic-session-${now}`,
        pendingMessage,
        questionText,
        requestScope,
        sessionsQueryKey: sessionsQueryOptions.queryKey,
        userMessage: createUserMessage(questionText, now),
        workspaceId,
      });

      return true;
    },
    [
      libraryId,
      libraryScopeKey,
      mutateSendQuestion,
      sessions,
      sessionsQueryOptions.queryKey,
      workspaceId,
    ],
  );

  const prepareRetry = useCallback(() => {
    if (!retryable) return null;
    setRetryable(null);
    return retryable.question;
  }, [retryable, setRetryable]);

  const latestEvidence = useMemo(
    () => latestEvidenceFromMessages(messages),
    [messages],
  );

  return {
    activeSession,
    debugContext,
    debugError,
    debugLoadingId,
    isExecuting,
    latestEvidence,
    messages,
    newSession,
    openDebugFor,
    prepareRetry,
    retryable,
    selectSession,
    sessionSearch,
    sessions,
    setDebugContext,
    setDebugError,
    setSessionSearch,
    sendQuestion,
  };
}
