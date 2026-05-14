import { memo } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Cpu, FileJson, MessageSquare, ReceiptText, X as IconX } from 'lucide-react';
import type { LlmContextDebugResponse } from '@/shared/api/query';

type LlmContextDebugDialogProps = {
  snapshot: LlmContextDebugResponse;
  onClose: () => void;
};

function stringifyJson(value: unknown): string {
  if (value == null) return 'null';
  return JSON.stringify(value, null, 2);
}

function hasJsonPayload(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value !== 'object') return true;
  if (Array.isArray(value)) return value.length > 0;
  return Object.keys(value).length > 0;
}

function LlmContextDebugDialogImpl({ snapshot, onClose }: LlmContextDebugDialogProps) {
  const { t } = useTranslation();
  const messageCount = snapshot.iterations.reduce(
    (sum, iter) => sum + iter.requestMessages.length,
    0,
  );
  const toolCallCount = snapshot.iterations.reduce(
    (sum, iter) => sum + iter.responseToolCalls.length,
    0,
  );
  const modelNames = Array.from(
    new Set(snapshot.iterations.map(iter => iter.modelName).filter(Boolean)),
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/60 backdrop-blur-sm p-4">
      <div className="bg-card border rounded-xl shadow-elevated w-full max-w-5xl max-h-[90vh] flex flex-col">
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b">
          <div className="min-w-0">
            <div className="text-sm font-semibold">{t('assistant.llmContextTitle')}</div>
            <div className="text-xs text-muted-foreground mt-0.5 truncate">
              {t('assistant.executionLabel')} {snapshot.executionId} · {snapshot.totalIterations}{' '}
              {t('assistant.iterations')}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label={t('assistant.close')}
          >
            <IconX className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-auto px-5 py-4 space-y-6">
          <div className="grid gap-2 sm:grid-cols-4">
            <DebugStat
              icon={<Cpu className="h-3.5 w-3.5" />}
              label={t('assistant.llmContextModels')}
              value={modelNames.length ? modelNames.join(', ') : '—'}
            />
            <DebugStat
              icon={<MessageSquare className="h-3.5 w-3.5" />}
              label={t('assistant.llmContextMessages')}
              value={messageCount}
            />
            <DebugStat
              icon={<ReceiptText className="h-3.5 w-3.5" />}
              label={t('assistant.llmContextToolCalls')}
              value={toolCallCount}
            />
            <DebugStat
              icon={<FileJson className="h-3.5 w-3.5" />}
              label={t('assistant.llmContextCapturedAt')}
              value={new Date(snapshot.capturedAt).toLocaleString()}
            />
          </div>

          {snapshot.queryIr != null && (
            <details className="border rounded-md" open>
              <summary className="cursor-pointer px-3 py-2 text-xs font-semibold bg-muted/40 rounded-md">
                {t('assistant.queryIr')}
              </summary>
              <pre className="p-3 font-mono text-[11px] whitespace-pre-wrap break-words max-h-72 overflow-auto">
                {stringifyJson(snapshot.queryIr)}
              </pre>
            </details>
          )}

          {snapshot.agentLoop && (
            <details className="border rounded-md">
              <summary className="cursor-pointer px-3 py-2 text-xs font-semibold bg-muted/40 rounded-md">
                {t('assistant.agentLoop')}
              </summary>
              <pre className="p-3 font-mono text-[11px] whitespace-pre-wrap break-words max-h-72 overflow-auto">
                {stringifyJson(snapshot.agentLoop)}
              </pre>
            </details>
          )}

          {snapshot.iterations.length === 0 && (
            <div className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
              {t('assistant.llmContextNoIterations')}
            </div>
          )}

          {snapshot.iterations.map((iter) => (
            <div key={iter.iteration} className="space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('assistant.iteration')} #{iter.iteration}
                </span>
                <span className="rounded-full border bg-muted/40 px-2 py-0.5 font-mono text-[11px]">
                  {iter.providerKind}/{iter.modelName}
                </span>
                {hasJsonPayload(iter.usage) && (
                  <span className="rounded-full border bg-muted/40 px-2 py-0.5 font-mono text-[11px]">
                    {t('assistant.usage')}
                  </span>
                )}
              </div>
              <details className="border rounded-md">
                <summary className="cursor-pointer px-3 py-2 text-xs font-medium bg-muted/40 rounded-md">
                  {t('assistant.requestMessages')} ({iter.requestMessages.length})
                </summary>
                <div className="p-3 space-y-2 font-mono text-[11px] leading-relaxed">
                  {iter.requestMessages.map((m, i) => (
                    <div key={i} className="border-l-2 border-primary/30 pl-2">
                      <div className="text-primary font-semibold mb-0.5">[{m.role}]</div>
                      {m.content && (
                        <pre className="whitespace-pre-wrap break-words text-foreground/80 max-h-60 overflow-auto">
                          {m.content}
                        </pre>
                      )}
                      {m.tool_calls && m.tool_calls.length > 0 && (
                        <div className="mt-1 text-status-warning">
                          {m.tool_calls.map((tc) => (
                            <div key={tc.id}>
                              → {tc.name}({tc.arguments_json})
                            </div>
                          ))}
                        </div>
                      )}
                      {m.tool_call_id && (
                        <div className="text-muted-foreground mt-0.5">
                          {t('assistant.toolCallIdLabel')}: {m.tool_call_id}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </details>
              {iter.responseText && (
                <details className="border rounded-md">
                  <summary className="cursor-pointer px-3 py-2 text-xs font-medium bg-muted/40 rounded-md">
                    {t('assistant.responseText')}
                  </summary>
                  <pre className="p-3 font-mono text-[11px] whitespace-pre-wrap break-words max-h-80 overflow-auto">
                    {iter.responseText}
                  </pre>
                </details>
              )}
              {iter.responseToolCalls.length > 0 && (
                <details className="border rounded-md">
                  <summary className="cursor-pointer px-3 py-2 text-xs font-medium bg-muted/40 rounded-md">
                    {t('assistant.responseToolCalls')} ({iter.responseToolCalls.length})
                  </summary>
                  <div className="p-3 space-y-3 font-mono text-[11px]">
                    {iter.responseToolCalls.map((tc) => (
                      <div
                        key={tc.id}
                        className="border-l-2 border-status-warning/40 pl-2"
                      >
                        <div
                          className={
                            tc.isError
                              ? 'text-status-failed font-semibold'
                              : 'text-status-warning font-semibold'
                          }
                        >
                          {tc.name}({tc.argumentsJson})
                        </div>
                        {tc.resultText && (
                          <pre className="whitespace-pre-wrap break-words text-foreground/70 max-h-60 overflow-auto mt-1">
                            {tc.resultText}
                          </pre>
                        )}
                      </div>
                    ))}
                  </div>
                </details>
              )}
              {hasJsonPayload(iter.usage) && (
                <details className="border rounded-md">
                  <summary className="cursor-pointer px-3 py-2 text-xs font-medium bg-muted/40 rounded-md">
                    {t('assistant.usage')}
                  </summary>
                  <pre className="p-3 font-mono text-[11px] whitespace-pre-wrap break-words max-h-60 overflow-auto">
                    {stringifyJson(iter.usage)}
                  </pre>
                </details>
              )}
            </div>
          ))}
          {snapshot.finalAnswer && (
            <div className="space-y-1">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('assistant.finalAnswer')}
              </div>
              <pre className="border rounded-md p-3 font-mono text-[11px] whitespace-pre-wrap break-words max-h-80 overflow-auto">
                {snapshot.finalAnswer}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function DebugStat({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-md border bg-muted/25 px-3 py-2">
      <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className="truncate text-xs font-semibold" title={String(value)}>
        {value}
      </div>
    </div>
  );
}

export const LlmContextDebugDialog = memo(LlmContextDebugDialogImpl);
