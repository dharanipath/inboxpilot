import { AlertTriangle, Info } from "lucide-react";

import { useProviders } from "@/api/hooks";
import { limitNotice, noAiConfigured } from "@/lib/providers";
import { cn } from "@/lib/utils";

import { ModelSelect } from "./ModelSelect";

/**
 * Says plainly when the chosen AI model is paused (free limit used up, key rejected, not
 * responding), what is reading the mail meanwhile, and lets the user switch to another model.
 */
export function LimitBanner() {
  const { data } = useProviders();
  if (data && noAiConfigured(data)) return <NoAiBanner />;
  const notice = data ? limitNotice(data) : null;
  if (!notice) return null;
  const warn = notice.tone === "warn";
  return (
    <div
      role={warn ? "alert" : "status"}
      aria-labelledby="limit-title"
      className={cn(
        "flex flex-wrap items-start gap-3 rounded-lg border p-3 text-sm sm:p-4",
        warn ? "border-warning/40 bg-warning/10" : "border-primary/30 bg-accent/40",
      )}
      data-testid="limit-banner"
    >
      {warn ? (
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
      ) : (
        <Info className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
      )}
      <div className="min-w-0 flex-1 space-y-1">
        <p id="limit-title" className="font-medium">
          {notice.message}
        </p>
        <p className="text-muted-foreground">{notice.fallback}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {notice.alternatives.length ? (
          <>
            <label htmlFor="limit-switch" className="text-xs text-muted-foreground">
              Use another model
            </label>
            <ModelSelect id="limit-switch" only={notice.alternatives} />
          </>
        ) : null}
      </div>
    </div>
  );
}

/** No AI key anywhere yet: say so, instead of silently using the rules reader. */
function NoAiBanner() {
  return (
    <div
      role="status"
      aria-labelledby="no-ai-title"
      className="flex flex-wrap items-start gap-3 rounded-lg border border-primary/30 bg-accent/40 p-3 text-sm sm:p-4"
      data-testid="no-ai-banner"
    >
      <Info className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-1">
        <p id="no-ai-title" className="font-medium">
          No AI model is set up yet, so your mail is read by the rules reader.
        </p>
        <p className="text-muted-foreground">
          To use AI, add a free key for Google Gemini, Groq or GitHub Models to the server&apos;s
          .env (for example GEMINI_API_KEY) and restart. It then appears in the AI model menu.
        </p>
      </div>
    </div>
  );
}
