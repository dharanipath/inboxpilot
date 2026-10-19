import { ChevronRight, ExternalLink, FilterX, MailOpen, MailX, Plus } from "lucide-react";

import { useAddTaskFromEmail, useEmails } from "@/api/hooks";
import type { RecentEmail, Task } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Badge, Skeleton } from "@/components/ui/primitives";
import { toast } from "@/components/ui/toast";
import { dayLabel, pastStrip, sortTasks, timeLabel } from "@/lib/format";
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

/** "4 newsletter, 3 automated notification" for the summary line. */
function skipBreakdown(skipped: RecentEmail[]): string {
  const counts = new Map<string, number>();
  for (const e of skipped) {
    const label = outcomeLabel(e).toLowerCase();
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].map(([label, n]) => `${n} ${label}`).join(", ");
}

/**
 * Catch-up: the 7 days before today, answering "did the agent miss or wrongly skip anything?"
 *  1. a one-line summary of what happened to the mail,
 *  2. the tasks from these days that are still open,
 *  3. mail that became tasks, by day (finished tasks sit under their mail),
 *  4. mail the agent skipped, folded by reason, each with "Add as task" to correct it.
 * Today's mail is not here: its tasks are on the Upcoming tab.
 */
export function RecentMail({ timezone }: { timezone: string }) {
  const q = useEmails(DAYS);
  const actions = useTaskActions();
  const addTask = useAddTaskFromEmail();
  const { typeFilter, priorityFilter, resetFilters } = useUi();

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
        body="Mail from before today shows up here. Tasks from today's mail are on the Upcoming tab."
      />
    );
  }

  const now = new Date();
  const filtered = typeFilter !== "all" || priorityFilter !== "all";
  const tasks = all.flatMap((e) => e.tasks);
  const stillOpen = tasks.filter((t) => !closedState(t, now));
  const done = tasks.filter((t) => t.status === "done").length;
  const withTasks = all.filter((e) => e.tasks.length > 0);
  const skipped = all.filter((e) => e.tasks.length === 0);
  const breakdown = skipBreakdown(skipped);

  const openShown = sortTasks(applyFilters(stillOpen, typeFilter, priorityFilter));
  // finished tasks stay under their mail; open ones are listed once, in "Still open"
  const mailShown = withTasks
    .map((e) => ({
      email: e,
      cards: applyFilters(
        e.tasks.filter((t) => closedState(t, now)),
        typeFilter,
        priorityFilter,
      ),
    }))
    .filter((m) =>
      filtered ? applyFilters(m.email.tasks, typeFilter, priorityFilter).length > 0 : true,
    );

  const add = (e: RecentEmail) =>
    addTask.mutate(
      { emailId: e.id },
      {
        onSuccess: () =>
          toast({
            title: "Added as a task",
            description: `${e.subject || "(no subject)"} is in Still open. Set a due date to schedule it.`,
          }),
        onError: () =>
          toast({
            title: "Couldn't add the task",
            description: "Please try again.",
            tone: "error",
          }),
      },
    );
  const skippedGroups = new Map<string, RecentEmail[]>();
  for (const e of skipped) {
    const label = outcomeLabel(e);
    skippedGroups.set(label, [...(skippedGroups.get(label) ?? []), e]);
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground" data-testid="catchup-summary">
        {dayLabel(q.data.from, today)} to yesterday · {all.length} email
        {all.length === 1 ? "" : "s"} · {withTasks.length} became tasks · {skipped.length} skipped
        {breakdown ? ` (${breakdown})` : ""} · {done} done
      </p>
      <KpiTiles open={stillOpen} doneCount={done} hide={["Today"]} />
      <DayStrip
        label="Past 7 days"
        unit="email"
        days={pastStrip(all, q.data.from)}
        highlight={6}
        target={(d) => `mail-${d.date}`}
      />
      <FilterBar />

      {openShown.length ? (
        <section aria-labelledby="catchup-open" className="space-y-3" data-testid="still-open">
          <h3 id="catchup-open" className="flex items-center gap-2 text-sm font-semibold">
            Still open from these days
            <span className="rounded-full bg-secondary px-2 text-xs font-medium text-muted-foreground">
              {openShown.length}
            </span>
          </h3>
          <ul className="space-y-2">
            {openShown.map((t: Task) => (
              <TaskCard key={t.id} task={t} today={today} timezone={timezone} {...actions} />
            ))}
          </ul>
        </section>
      ) : null}

      {!mailShown.length && !openShown.length && filtered ? (
        <EmptyPanel
          icon={<FilterX />}
          title="No tasks match these filters"
          body="Try another priority or type."
        >
          <Button variant="outline" size="sm" onClick={resetFilters}>
            Clear filters
          </Button>
        </EmptyPanel>
      ) : null}

      {groupByLocalDate(mailShown.map((m) => m.email)).map(([date, emails]) => (
        <section key={date} aria-labelledby={`mail-${date}`} className="space-y-3">
          <h3 id={`mail-${date}`} className="flex items-center gap-2 text-sm font-semibold">
            {dayLabel(date, today)}
            <span className="rounded-full bg-secondary px-2 text-xs font-medium text-muted-foreground">
              {emails.length} email{emails.length === 1 ? "" : "s"}
            </span>
          </h3>
          <ul className="space-y-3">
            {emails.map((e) => (
              <MailItem
                key={e.id}
                email={e}
                cards={mailShown.find((m) => m.email.id === e.id)?.cards ?? []}
                today={today}
                timezone={timezone}
                actions={actions}
              />
            ))}
          </ul>
        </section>
      ))}

      {skipped.length && !filtered ? (
        <details className="group rounded-lg border border-dashed p-3" data-testid="skipped">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium">
            <ChevronRight
              className="size-4 transition-transform group-open:rotate-90"
              aria-hidden="true"
            />
            Skipped by the agent <span className="text-muted-foreground">({skipped.length})</span>
            <span className="ml-auto text-xs font-normal text-muted-foreground">
              Something missing? Add it as a task
            </span>
          </summary>
          <div className="mt-3 space-y-4">
            {[...skippedGroups.entries()].map(([label, emails]) => (
              <div key={label} className="space-y-2">
                <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {label} ({emails.length})
                </h4>
                <ul className="space-y-2">
                  {emails.map((e) => (
                    <MailItem
                      key={e.id}
                      email={e}
                      cards={[]}
                      today={today}
                      timezone={timezone}
                      actions={actions}
                      onAdd={add}
                      adding={addTask.isPending}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function MailItem({
  email,
  cards,
  today,
  timezone,
  actions,
  onAdd,
  adding = false,
}: {
  email: RecentEmail;
  /** the task cards to show under the mail (not the open ones: those are in "Still open") */
  cards: Task[];
  today: string;
  timezone: string;
  actions: TaskActions;
  onAdd?: (email: RecentEmail) => void;
  adding?: boolean;
}) {
  const sender = email.from_name ?? email.from_email ?? "Unknown sender";
  const hasTasks = email.tasks.length > 0;
  const subjectId = `mail-subject-${email.id}`;
  const subject = email.subject || "(no subject)";
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
            {subject}
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
        {onAdd ? (
          <Button
            variant="outline"
            size="sm"
            disabled={adding}
            onClick={() => onAdd(email)}
            aria-label={`Add "${subject}" as a task`}
            title={`Add "${subject}" as a task`}
          >
            <Plus aria-hidden="true" />
            Add as task
          </Button>
        ) : null}
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
      {cards.length ? (
        <ul className="space-y-2 pl-4 sm:pl-10" aria-label="Tasks from this email">
          {cards.map((t) => (
            <TaskCard key={t.id} task={t} today={today} timezone={timezone} {...actions} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
