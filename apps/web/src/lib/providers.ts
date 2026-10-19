import type { ProvidersPage, ProviderStatus } from "@/api/types";

/** What a model is called on screen ("github" -> "OpenAI GPT (GitHub Models)"). Unknown ids pass through. */
const DISPLAY_NAME: Record<string, string> = {
  gemini: "Google Gemini",
  groq: "Groq",
  openrouter: "OpenRouter",
  github: "OpenAI GPT (GitHub Models)",
  ollama: "Ollama (local Llama)",
};
export const providerName = (id: string): string => DISPLAY_NAME[id] ?? id;

/** "Written by …" wording for whoever produced a briefing or answer (`generated_by`). */
export const writtenBy = (id: string): string =>
  id === "template" || id === "gateway-template" || id === "rules" || id === "heuristic"
    ? "rules (no LLM)"
    : providerName(id);

/** The models offered in the UI, in this order. Others the server may know are not shown. */
export const SHOWN_MODELS = ["gemini", "groq", "openrouter", "heuristic"] as const;

export const shownProviders = (list: ProviderStatus[]): ProviderStatus[] =>
  SHOWN_MODELS.flatMap((name) => list.filter((p) => p.name === name));

export type ProviderState = "ready" | "no_key" | "limited" | "rejected" | "no_credit" | "failing";

export function providerState(p: ProviderStatus): ProviderState {
  if (!p.configured) return "no_key";
  if (p.available) return "ready";
  if (p.circuit_reason === "auth") return "rejected";
  if (p.circuit_reason === "no_credit") return "no_credit";
  if (p.circuit_reason === "failures") return "failing";
  return "limited";
}

/** "45 s", "2 min", "1 h". */
export function waitLabel(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3600)} h`;
}

/** Short status words for a provider (used in the picker and in Settings). */
export function stateWords(p: ProviderStatus): string {
  if (p.name === "heuristic") return "always on";
  switch (providerState(p)) {
    case "ready":
      return p.key_source === "user" ? "ready · your key" : "ready";
    case "no_key":
      return p.keyable ? "add a free key" : "not set up";
    case "limited":
      return `free limit reached · back in ~${waitLabel(p.cooldown_s)}`;
    case "rejected":
      return "key rejected";
    case "no_credit":
      return "out of credit";
    case "failing":
      return `not responding · retry in ~${waitLabel(p.cooldown_s)}`;
  }
}

export const isLlm = (p: ProviderStatus): boolean => p.name !== "heuristic";

export interface LimitNotice {
  tone: "warn" | "info";
  provider: ProviderStatus;
  message: string;
  /** what is reading the mail meanwhile */
  fallback: string;
  alternatives: ProviderStatus[];
}

function reasonText(p: ProviderStatus): string {
  const wait = waitLabel(p.cooldown_s);
  switch (providerState(p)) {
    case "rejected":
      return `${p.label} rejected its API key. Replace the key in the server's .env and restart.`;
    case "no_credit":
      return `${p.label} is out of credit, so it can't answer right now. Check its billing or usage page, or pick another model.`;
    case "failing":
      return `${p.label} isn't responding (several errors in a row). It will be tried again in about ${wait}.`;
    default:
      return `${p.label} has used up its free limit for now. It should work again in about ${wait}.`;
  }
}

/** True when no AI model has a key: everything is being read by the rules reader. */
export function noAiConfigured(page: ProvidersPage): boolean {
  return (
    page.mode !== "heuristic" &&
    !shownProviders(page.providers).some((p) => isLlm(p) && p.configured)
  );
}

/**
 * Is the model the user wants paused? Returns what to tell them and what they could switch to.
 * Null when everything the user picked is working (or they picked rules only).
 */
export function limitNotice(page: ProvidersPage): LimitNotice | null {
  const llms = shownProviders(page.providers).filter((p) => isLlm(p) && p.configured);
  const ready = llms.filter((p) => p.available);
  if (page.mode === "heuristic") return null;

  if (page.mode !== "auto") {
    const picked = page.providers.find((p) => p.name === page.mode);
    if (!picked || picked.available || !picked.configured) return null;
    return {
      tone: "warn",
      provider: picked,
      message: reasonText(picked),
      fallback:
        "Until then, new emails are read by the rules reader, which is less accurate. Pick another model to keep using AI.",
      alternatives: ready.filter((p) => p.name !== picked.name),
    };
  }

  // automatic: the first model in order is the one the user would normally get
  const first = llms[0];
  if (!first || first.available) return null;
  const using = ready[0];
  return {
    tone: using ? "info" : "warn",
    provider: first,
    message: reasonText(first),
    fallback: using
      ? `Using ${using.label} meanwhile.`
      : "No other AI model is available, so new emails are read by the rules reader, which is less accurate.",
    alternatives: ready,
  };
}
