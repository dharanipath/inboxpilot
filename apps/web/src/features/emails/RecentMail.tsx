import { ExternalLink, FilterX, MailOpen, MailX } from "lucide-react";
import { useState } from "react";

import { useEmails } from "@/api/hooks";
import type { RecentEmail } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Badge, Skeleton } from "@/components/ui/primitives";
import { dayLabel, pastStrip, timeLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useUi } from "@/store/ui";

import { DayStrip, KpiTiles } from "../tasks/Overview";
import { applyFilters, EmptyPanel, FilterBar } from "../tasks/TaskBoard";
import { closedState, TaskCard, type TaskActions } from "../tasks/TaskCard";
import { useTaskActions } from "../tasks/useTaskActions";

/** Why an email produced no task, in plain words. */
export const SKIP_LABEL: Record<string, string> = {
  promotion: "Promotion",
  social: "Social",
  newsletter: "Newsletter",
  automated: "Automated notification",
  no_action_items: "No action needed",
  empty: "Empty message",
  duplicate: "Duplicate",
};

export function outcomeLabel(email: Pick<RecentEmail, "status" | "skip_reason" | "tasks">): string {
  const n = email.tasks.length;
  if (n) return `${n} task${n === 1 ? "" : "s"}`;
  if (email.status === "skipped") return SKIP_LABEL[email.skip_reason ?? ""] ?? "Skipped";
  if (email.status === "failed") return "Couldn't process";
  if (email.status === "pending") return "Waiting for the agent";
  return "No action needed";
}

export function groupByLocalDate(emails: RecentEmail[]): [string, RecentEmail[]][] {
  const map = new Map<string, RecentEmail[]>();
  for (const e of emails) map.set(e.local_date, [...(map.get(e.local_date) ?? []), e]);
  return [...map.entries()].sort(([a], [b]) => b.localeCompare(a)); // newest day first
}

const DAYS = 7;

/**
 * The 7 days before today, by day: every email, what happened to it, and its tasks as the same
 * cards as Upcoming (priority, due date, type, sender, evidence, "why", actions). Today's mail
 * is not here; it is on the Upcoming tab.
 */
export function RecentMail({ timezone }: { timezone: string }) {
  const q = useEmails(DAYS);
  const actions = useTaskActions();
  const { typeFilter, priorityFilter, resetFilters } = useUi();
  const [onlyTasks, setOnlyTasks] = useState(false);

  if (q.isLoading) {
    return (
      <div className="space-y-2" aria-busy="true" aria-label="Loading recent mail">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-14" />
        ))}
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <p role="alert" className="text-sm text-destructive">
        We couldn't load your recent mail.
      </p>
    );
  }
  const { today } = q.data;
  const all = q.data.items;
  if (!all.length) {
    return (
      <EmptyPanel
        icon={<MailOpen />}
        title={`No mail in the past ${DAYS} days`}
        body="Mail from before today shows up here. Today's mail is on the Upcoming tab."
      />
    );
  }

  const filtered = typeFilter !== "all" || priorityFilter !== "all";
  const shown = all
    .map((e) => ({ ...e, tasks: applyFilters(e.tasks, typeFilter, priorityFilter) }))
    .filter((e) => (onlyTasks || filtered ? e.tasks.length > 0 : true));
  const tasks = all.flatMap((e) => e.tasks);
  const now = new Date();
  // same tiles as Upcoming, counted over the tasks these emails produced
  const stillOpen = tasks.filter((t) => !closedState(t, now));
  const done = tasks.filter((t) => t.status === "done").length;

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        {all.length} email{all.length === 1 ? "" : "s"} from {dayLabel(q.data.from, today)} to
        yesterday · {tasks.length} task{tasks.length === 1 ? "" : "s"} found · {done} done
      </p>
      <KpiTiles open={stillOpen} doneCount={done} hide={["Today"]} />
      <DayStrip
        label="Past 7 days"
        unit="email"
        days={pastStrip(all, q.data.from)}
        highlight={6}
        target={(d) => `mail-${d.date}`}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <FilterBar />
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={onlyTasks}
            onChange={(e) => setOnlyTasks(e.target.checked)}
            className="size-3.5 accent-[hsl(var(--primary))]"
          />
          Only emails with tasks
        </label>
      </div>
      {!shown.length ? (
        <EmptyPanel
          icon={<FilterX />}
          title="No tasks match these filters"
          body="Try another priority or type."
        >
          {filtered ? (
            <Button variant="outline" size="sm" onClick={resetFilters}>
              Clear filters
            </Button>
          ) : null}
        </EmptyPanel>
      ) : null}
      {groupByLocalDate(shown).map(([date, emails]) => (
        <section key={date} aria-labelledby={`mail-${date}`} className="space-y-3">
          <h3 id={`mail-${date}`} className="flex items-center gap-2 text-sm font-semibold">
            {dayLabel(date, today)}
            <span className="rounded-full bg-secondary px-2 text-xs font-medium text-muted-foreground">
              {emails.length} email{emails.length === 1 ? "" : "s"}
            </span>
          </h3>
          <ul className="space-y-3">
            {emails.map((e) => (
              <MailItem key={e.id} email={e} today={today} timezone={timezone} actions={actions} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function MailItem({
  email,
  today,
  timezone,
  actions,
}: {
  email: RecentEmail;
  today: string;
  timezone: string;
  actions: TaskActions;
}) {
  const sender = email.from_name ?? email.from_email ?? "Unknown sender";
  const hasTasks = email.tasks.length > 0;
  const subjectId = `mail-subject-${email.id}`;
  return (
    <li aria-labelledby={subjectId} data-testid="recent-mail" className="space-y-2">
      <div className="flex items-start gap-3 rounded-lg border bg-card/60 px-3 py-2">
        <span
          className={cn(
            "mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md",
            hasTasks ? "bg-accent text-accent-foreground" : "bg-secondary text-muted-foreground",
          )}
          aria-hidden="true"
        >
          {hasTasks ? <MailOpen className="size-4" /> : <MailX className="size-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <p id={subjectId} className="truncate text-sm font-medium">
            {email.subject || "(no subject)"}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {sender}
            {email.from_name && email.from_email ? ` <${email.from_email}>` : ""} ·{" "}
            {timeLabel(email.received_at, timezone)}
          </p>
        </div>
        <Badge className={hasTasks ? "border-primary/30 text-primary" : "text-muted-foreground"}>
          {outcomeLabel(email)}
        </Badge>
        <a
          href={email.gmail_url}
          target="_blank"
          rel="noreferrer noopener"
          className="rounded p-1 text-muted-foreground hover:text-foreground"
          aria-label={`Open "${email.subject || "email"}" in Gmail`}
          title={`Open "${email.subject || "email"}" in Gmail`}
        >
          <ExternalLink className="size-3.5" aria-hidden="true" />
        </a>
      </div>
      {hasTasks ? (
        <ul className="space-y-2 pl-4 sm:pl-10" aria-label="Tasks from this email">
          {email.tasks.map((t) => (
            <TaskCard key={t.id} task={t} today={today} timezone={timezone} {...actions} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
