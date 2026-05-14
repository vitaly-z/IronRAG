import { memo, useEffect, useMemo, useState } from 'react';
import type { TFunction } from 'i18next';
import { Bug, BrainCircuit, CheckCircle2, Loader2, Wrench } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import type { AssistantAgentActivityEvent, AssistantMessage } from '@/shared/types';
import { VERIFICATION_CONFIG, verificationLabel } from "../model/verificationConfig";

type ChatMessageProps = {
  t: TFunction;
  message: AssistantMessage;
  onOpenDebug?: (executionId: string) => void;
};

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function eventLabel(event: AssistantAgentActivityEvent, t: TFunction): string {
  switch (event.type) {
    case 'started':
      return t('assistant.activity.started');
    case 'model_request':
      return t('assistant.activity.modelRequest', {
        model: event.model_name ?? t('assistant.activity.modelUnknown'),
        iteration: event.iteration ?? 1,
      });
    case 'model_response':
      return event.has_final_answer
        ? t('assistant.activity.modelFinal')
        : t('assistant.activity.modelToolPlan', {
            count: event.tool_call_count ?? 0,
          });
    case 'tool_call_started':
      return t('assistant.activity.toolStarted', {
        tool: event.tool_name ?? t('assistant.activity.toolUnknown'),
      });
    case 'tool_call_progress':
      return t('assistant.activity.toolProgress', {
        elapsed: formatElapsed(event.elapsed_ms ?? 0),
        tool: event.tool_name ?? t('assistant.activity.toolUnknown'),
      });
    case 'tool_call_finished':
      return event.is_error
        ? t('assistant.activity.toolFailed', {
            tool: event.tool_name ?? t('assistant.activity.toolUnknown'),
          })
        : t('assistant.activity.toolFinished', {
            tool: event.tool_name ?? t('assistant.activity.toolUnknown'),
          });
    case 'final_synthesis_started':
      return t('assistant.activity.finalSynthesis');
    case 'persisting':
      return t('assistant.activity.persisting');
    default:
      return t('assistant.activity.working');
  }
}

function renderActivityIcon(event: AssistantAgentActivityEvent | undefined, live: boolean) {
  const className = `h-4 w-4 ${event?.type === 'persisting' ? 'text-emerald-600' : 'text-primary'} ${
    live && event?.type !== 'persisting' ? 'animate-pulse' : ''
  }`;
  if (event?.type?.startsWith('tool_call')) return <Wrench className={className} />;
  if (event?.type === 'model_request' || event?.type === 'model_response') {
    return <BrainCircuit className={className} />;
  }
  if (event?.type === 'persisting') return <CheckCircle2 className={className} />;
  return <Loader2 className={className} />;
}

function PendingAssistantActivity({
  events = [],
  live = true,
  startedAt,
  t,
}: {
  events?: AssistantAgentActivityEvent[];
  live?: boolean;
  startedAt: string;
  t: TFunction;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);

  const startedAtMs = Date.parse(startedAt);
  const elapsed = Number.isFinite(startedAtMs) ? now - startedAtMs : 0;
  const latest = events.at(-1);
  const visibleEvents = useMemo(() => events.slice(-5), [events]);

  return (
    <div className="w-[min(520px,calc(100vw-3rem))] rounded-xl border bg-muted/30 p-3 text-xs">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 font-semibold text-foreground">
          {renderActivityIcon(latest, live)}
          <span>{eventLabel(latest ?? { type: 'started' }, t)}</span>
        </div>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {formatElapsed(elapsed)}
        </span>
      </div>

      <div className="mt-3 space-y-1.5">
        {visibleEvents.length === 0 ? (
          <div className="rounded-md bg-background/70 px-2 py-1.5 text-muted-foreground">
            {t('assistant.activity.waitingForRuntime')}
          </div>
        ) : (
          visibleEvents.map((event, index) => (
            <div
              key={`${event.type}-${event.iteration ?? 0}-${event.tool_name ?? ''}-${index}`}
              className="flex items-start justify-between gap-2 rounded-md bg-background/70 px-2 py-1.5"
            >
              <span className="min-w-0 truncate">{eventLabel(event, t)}</span>
              {event.result_preview && (
                <span className="max-w-[45%] truncate text-right text-muted-foreground">
                  {event.result_preview}
                </span>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

const markdownComponents = {
  code: ({ className, children, ...props }: React.HTMLAttributes<HTMLElement>) => {
    const isInline = !className;
    return isInline ? (
      <code className="bg-muted px-1 py-0.5 rounded text-xs" {...props}>
        {children}
      </code>
    ) : (
      <pre className="bg-muted rounded-md p-3 overflow-x-auto text-xs">
        <code className={className} {...props}>
          {children}
        </code>
      </pre>
    );
  },
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="overflow-x-auto">
      <table className="min-w-full text-xs border-collapse">{children}</table>
    </div>
  ),
  th: ({ children }: { children?: React.ReactNode }) => (
    <th className="border border-border px-2 py-1 bg-muted font-medium text-left">
      {children}
    </th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td className="border border-border px-2 py-1">{children}</td>
  ),
};

function ChatMessageImpl({ t, message, onOpenDebug }: ChatMessageProps) {
  const isUser = message.role === 'user';
  const vcState = message.evidence?.verificationState;
  const vc = vcState && vcState !== 'not_run' ? VERIFICATION_CONFIG[vcState] : null;
  const vcLabel = vcState && vcState !== 'not_run' ? verificationLabel(vcState, t) : null;
  const hasActivityTrace = !isUser && (message.activityEvents?.length ?? 0) > 0;

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} animate-fade-in`}>
      <div
        className={`max-w-[80%] ${
          isUser ? 'text-primary-foreground rounded-2xl rounded-br-sm px-4 py-3' : 'space-y-2'
        }`}
        style={
          isUser
            ? {
                background:
                  'linear-gradient(135deg, hsl(var(--primary)), hsl(224 76% 42%))',
                boxShadow: '0 2px 8px -2px hsl(var(--primary) / 0.4)',
              }
            : undefined
        }
      >
        {vc && (
          <div className="flex items-center gap-2 text-xs">
            <vc.icon className={`h-3 w-3 ${vc.cls}`} />
            <span className={`font-semibold ${vc.cls}`}>{vcLabel}</span>
          </div>
        )}
        <div
          className={`text-sm leading-relaxed ${
            !isUser ? 'bg-card border rounded-2xl rounded-bl-sm px-4 py-3 shadow-soft' : ''
          }`}
        >
          {!isUser && message.executionId && onOpenDebug && (
            <button
              type="button"
              onClick={() => message.executionId && onOpenDebug(message.executionId)}
              className="float-right ml-2 -mt-1 text-muted-foreground/50 hover:text-muted-foreground transition-colors"
              title={t('assistant.showLlmContext')}
              aria-label={t('assistant.showLlmContext')}
            >
              <Bug className="h-3 w-3" />
            </button>
          )}
          {!isUser && !message.content && (
            <PendingAssistantActivity
              events={message.activityEvents}
              startedAt={message.timestamp}
              t={t}
            />
          )}
          {!isUser ? (
            <div className="prose prose-sm dark:prose-invert max-w-none">
              <ReactMarkdown components={markdownComponents}>
                {message.content}
              </ReactMarkdown>
            </div>
          ) : (
            message.content.split('\n').map((line, i) => (
              <p key={i} className={i > 0 ? 'mt-2' : ''}>
                {line}
              </p>
            ))
          )}
          {!isUser && message.content && hasActivityTrace && !message.executionId && (
            <div className="mt-3">
              <PendingAssistantActivity
                events={message.activityEvents}
                live={false}
                startedAt={message.timestamp}
                t={t}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Memoized per-message renderer. During streaming the parent creates a new
 * messages array every chunk, but React.memo's shallow compare on the
 * individual `message` object reference means only the message that the
 * streaming delta actually touched re-renders (and re-runs ReactMarkdown).
 * Historical messages skip reconciliation entirely.
 */
export const ChatMessage = memo(ChatMessageImpl);
