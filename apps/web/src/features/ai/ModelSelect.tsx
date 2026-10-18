import { ApiError } from "@/api/client";
import { useProviders, useSetModel } from "@/api/hooks";
import type { ProviderStatus } from "@/api/types";
import { toast } from "@/components/ui/toast";
import { noAiConfigured, providerState, shownProviders, stateWords } from "@/lib/providers";
import { cn } from "@/lib/utils";
import { useUi } from "@/store/ui";

/** The option text: name, then its state in words (never colour alone). */
export function optionLabel(p: ProviderStatus): string {
  if (p.name === "heuristic") return "Rules only (no AI)";
  return `${p.label} — ${stateWords(p)}`;
}

/**
 * Pick the AI model that reads your mail, like the Types filter: "Auto" tries every model that
 * has a key, in order; picking one uses that model, then the rules reader if it is paused.
 * Models without a key are listed but disabled, with "add a free key".
 */
export function ModelSelect({
  id,
  className,
  only,
}: {
  id: string;
  className?: string;
  /** limit the choices (e.g. the models that are ready right now) */
  only?: ProviderStatus[];
}) {
  const providers = useProviders();
  const setModel = useSetModel();
  const setActiveRun = useUi((s) => s.setActiveRun);
  const page = providers.data;
  if (!page) return null;
  const options = shownProviders(only ?? page.providers);
  const current = options.some((p) => p.name === page.mode) ? page.mode : "";

  const change = (model: string) =>
    setModel.mutate(model, {
      onSuccess: (next) => {
        const picked = next.providers.find((p) => p.name === model);
        if (next.resync) setActiveRun(next.resync); // follow the re-read live
        toast({
          title:
            model === "auto"
              ? "Automatic: the best available model reads your mail"
              : `${picked?.label ?? model} will read your new mail`,
          ...(next.resync
            ? {
                description: `Re-reading your recent mail with ${picked?.label ?? model} now. Your done tasks and edited dates are kept.`,
              }
            : {}),
        });
      },
      onError: (err) =>
        toast({
          title: "Couldn't switch model",
          description: err instanceof ApiError ? (err.detail ?? err.title) : undefined,
          tone: "error",
        }),
    });

  return (
    <select
      id={id}
      value={only ? "" : current}
      onChange={(e) => e.target.value && change(e.target.value)}
      disabled={setModel.isPending}
      title={
        only
          ? "Switch to another AI model that is ready now"
          : "AI model that reads your mail: Gemini, Groq, OpenAI GPT, Ollama, or Rules only (no AI)"
      }
      className={cn(
        "h-8 max-w-full rounded-md border bg-card px-2 text-xs text-foreground disabled:opacity-60",
        className,
      )}
    >
      {only ? <option value="">Switch to…</option> : null}
      {!only && !current ? (
        // e.g. the older "automatic" setting: ask for a choice rather than pretend one is set
        <option value="" disabled>
          {noAiConfigured(page) ? "Choose a model (no AI key yet)" : "Choose a model"}
        </option>
      ) : null}
      {options.map((p) => (
        <option
          key={p.name}
          value={p.name}
          disabled={p.name !== "heuristic" && providerState(p) === "no_key"}
        >
          {optionLabel(p)}
        </option>
      ))}
    </select>
  );
}
