import { AlertCircle, CalendarDays, CheckCircle2, Sun } from "lucide-react";
import type { ReactNode } from "react";

import type { Task } from "@/api/types";
import { type StripDay, weekStrip } from "@/lib/format";
import { cn } from "@/lib/utils";

export function KpiTiles({
  open,
  doneCount,
  hide = [],
}: {
  open: Task[];
  doneCount: number;
  /** tiles to leave out, by label (Past 7 days has no "Today") */
  hide?: string[];
}) {
  const count = (b: Task["bucket"]) => open.filter((t) => t.bucket === b).length;
  const tiles: { label: string; value: number; icon: ReactNode; tone?: string }[] = [
    {
      label: "Overdue",
      value: count("overdue"),
      icon: <AlertCircle />,
      tone: count("overdue") ? "text-p0" : "",
    },
    { label: "Today", value: count("today"), icon: <Sun /> },
    { label: "This week", value: count("week"), icon: <CalendarDays /> },
    { label: "Done", value: doneCount, icon: <CheckCircle2 />, tone: "text-success" },
  ];
  return (
    <dl
      className={cn(
        "grid grid-cols-2 gap-3",
        tiles.length - hide.length === 3 ? "sm:grid-cols-3" : "lg:grid-cols-4",
      )}
    >
      {tiles
        .filter((t) => !hide.includes(t.label))
        .map((t) => (
          <div key={t.label} className="rounded-lg border bg-card p-3 shadow-sm sm:p-4">
            <dt className="flex items-center gap-2 text-xs font-medium text-muted-foreground [&_svg]:size-4">
              <span aria-hidden="true" className={t.tone}>
                {t.icon}
              </span>
              {t.label}
            </dt>
            <dd
              className={cn("mt-1 text-2xl font-semibold tabular-nums", t.tone)}
              data-testid={`kpi-${t.label.toLowerCase().replace(" ", "-")}`}
            >
              {t.value}
            </dd>
          </div>
        ))}
    </dl>
  );
}

/** Today + 6 days. Bar height = tasks that day; days with tasks jump to their group. */
export function WeekStrip({ open, today }: { open: Task[]; today: string }) {
  return (
    <DayStrip
      label="Next 7 days"
      unit="task"
      days={weekStrip(open, today)}
      highlight={0}
      target={(d, i) => (i === 0 ? "today" : `day-${d.date}`)}
    />
  );
}

/**
 * A row of 7 days: weekday, date, a bar for the count and the count itself. Days with something
 * on them are buttons that scroll to that day's group; empty days are disabled.
 */
export function DayStrip({
  label,
  unit,
  days,
  highlight,
  target,
}: {
  label: string;
  unit: string;
  days: StripDay[];
  highlight?: number;
  target: (day: StripDay, index: number) => string;
}) {
  const max = Math.max(1, ...days.map((d) => d.count));
  return (
    <nav aria-label={label} className="rounded-lg border bg-card p-2 shadow-sm">
      <ol className="grid grid-cols-7 gap-1">
        {days.map((d, i) => {
          const name = `${d.weekday} ${d.day}: ${d.count} ${unit}${d.count === 1 ? "" : "s"}${d.extra ? `, ${d.extra}` : ""}${d.urgent ? `, ${d.urgent} high priority` : ""}`;
          return (
            <li key={d.date}>
              <button
                type="button"
                disabled={!d.count}
                aria-label={name}
                title={name}
                onClick={() =>
                  document
                    .getElementById(target(d, i))
                    ?.scrollIntoView({ behavior: "smooth", block: "start" })
                }
                className={cn(
                  "flex w-full flex-col items-center gap-1 rounded-md px-1 py-2 text-center transition-colors enabled:hover:bg-accent disabled:cursor-default",
                  i === highlight && "bg-accent/60",
                )}
              >
                <span className="text-[11px] font-medium text-muted-foreground">{d.weekday}</span>
                <span className="text-sm font-semibold tabular-nums">{d.day}</span>
                <span
                  className="flex h-8 w-2.5 items-end overflow-hidden rounded-full bg-secondary"
                  aria-hidden="true"
                >
                  <span
                    className={cn("w-full rounded-full", d.urgent ? "bg-p1" : "bg-primary/70")}
                    style={{ height: `${(d.count / max) * 100}%` }}
                  />
                </span>
                <span className="text-[11px] tabular-nums text-muted-foreground" aria-hidden="true">
                  {d.count || "–"}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
