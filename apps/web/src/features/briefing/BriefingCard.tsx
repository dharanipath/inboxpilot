import { Sparkles } from "lucide-react";

import { useBriefing } from "@/api/hooks";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/primitives";
import { writtenBy } from "@/lib/providers";

export function BriefingCard() {
  const { data, isLoading, isError } = useBriefing();
  return (
    <Card className="relative overflow-hidden border-primary/20 bg-gradient-to-br from-accent/70 via-card to-card">
      <CardContent className="space-y-2 p-4 sm:p-5">
        <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-accent-foreground">
          <Sparkles className="size-3.5" aria-hidden="true" /> Daily briefing
        </p>
        {isLoading ? (
          <div className="space-y-2" aria-label="Loading briefing">
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-4 w-full" />
          </div>
        ) : isError || !data ? (
          <p className="text-sm text-muted-foreground">The briefing is unavailable right now.</p>
        ) : (
          <>
            <h2 className="text-lg font-semibold leading-snug sm:text-xl">{data.headline}</h2>
            <p className="text-sm leading-relaxed text-foreground/80">{data.summary}</p>
            <p className="text-xs text-muted-foreground">
              Written by {writtenBy(data.generated_by)}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
