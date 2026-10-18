import { Cpu } from "lucide-react";

import { useProviders } from "@/api/hooks";
import type { ProviderStatus } from "@/api/types";
import { ModelSelect } from "@/features/ai/ModelSelect";
import { cn } from "@/lib/utils";

export function summarizeProviders(list: ProviderStatus[]): {
  label: string;
  tone: "ok" | "warn" | "rules";
} {
  const llms = list.filter((p) => p.configured && p.name !== "heuristic");
  const active = llms.find((p) => p.available);
  if (!llms.length) return { label: "Rules only", tone: "rules" };
  if (!active) return { label: "LLMs cooling down", tone: "warn" };
  const coolingAhead = llms.slice(0, llms.indexOf(active)).some((p) => p.circuit === "open");
  return { label: active.name, tone: coolingAhead ? "warn" : "ok" };
}

const DOT = {
  ok: "bg-success",
  warn: "bg-warning",
  rules: "bg-p3",
  down: "bg-destructive",
} as const;

/** Header control: which AI model reads the mail, chosen like the Types filter. */
export function ProviderBadge() {
  const { data, isError } = useProviders();
  if (isError) {
    return (
      <span className="hidden items-center gap-2 rounded-full border bg-card px-2.5 py-1 text-xs font-medium sm:inline-flex">
        <span className={cn("size-2 rounded-full", DOT.down)} aria-hidden="true" />
        Agent offline
      </span>
    );
  }
  if (!data) return null;
  const tone = summarizeProviders(data.providers).tone;
  return (
    <div className="hidden items-center gap-1.5 sm:flex">
      <Cpu className="size-3.5 text-muted-foreground" aria-hidden="true" />
      <span className={cn("size-2 rounded-full", DOT[tone])} aria-hidden="true" />
      <label htmlFor="header-model" className="sr-only">
        AI model
      </label>
      <ModelSelect id="header-model" className="w-44 lg:w-56" />
    </div>
  );
}
