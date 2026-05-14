import type { TFunction } from 'i18next';
import { AlertTriangle, Loader2, X as IconX } from 'lucide-react';
import { LlmContextDebugDialog } from '@/features/assistant/components/LlmContextDebugDialog';
import type { LlmContextDebugResponse } from '@/shared/api/query';

type AssistantDebugContextProps = {
  t: TFunction;
  loadingId: string | null;
  snapshot: LlmContextDebugResponse | null;
  error: string | null;
  onClose: () => void;
};

export function AssistantDebugContext({
  t,
  loadingId,
  snapshot,
  error,
  onClose,
}: AssistantDebugContextProps) {
  return (
    <>
      {loadingId && !snapshot && (
        <div
          role="status"
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/40 backdrop-blur-sm"
        >
          <div className="bg-card border rounded-lg px-4 py-3 flex items-center gap-2 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('assistant.llmContextLoading')}
          </div>
        </div>
      )}

      {snapshot && (
        <LlmContextDebugDialog snapshot={snapshot} onClose={onClose} />
      )}

      {error && !snapshot && !loadingId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/60 p-4 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-xl border bg-card shadow-elevated">
            <div className="flex items-start justify-between gap-3 border-b px-5 py-4">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-status-failed" />
                <div>
                  <div className="text-sm font-semibold">
                    {t('assistant.llmContextUnavailableTitle')}
                  </div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    {error}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="text-muted-foreground transition-colors hover:text-foreground"
                aria-label={t('assistant.close')}
              >
                <IconX className="h-4 w-4" />
              </button>
            </div>
            <div className="px-5 py-4 text-xs leading-relaxed text-muted-foreground">
              {t('assistant.llmContextUnavailableHint')}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
