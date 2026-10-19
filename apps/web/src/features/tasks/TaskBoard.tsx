import { AnimatePresence } from "framer-motion";
import { ChevronRight, FilterX, Inbox } from "lucide-react";
import type { ReactNode } from "react";

import type { Bucket, Priority, Task, TaskType } from "@/api/types";
import { Button } from "@/components/ui/button";
import { groupByDay, PRIORITY_META, sortTasks, TYPE_LABEL } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useUi } from "@/store/ui";

import { TaskCard, type TaskActions } from "./TaskCard";

interface Props {
  tasks: Task[];
  today: string;
  timezone: string;
  actions: TaskActions;
  emptyAction?: ReactNode;
}

export function applyFilters(
  tasks: Task[],
  type: TaskType | "all",
  priority: Priority | "all",
): Task[] {
  return tasks.filter(
    (t) => (type === "all" || t.type === type) && (priority === "all" || t.priority === priority),
  );
}

const byBucket = (tasks: Task[], b: Bucket) => tasks.filter((t) => t.bucket === b);

export function TaskBoard({ tasks, today, timezone, actions, emptyAction }: Props) {
  const { typeFilter, priorityFilter, resetFilters } = useUi();
  const visible = applyFilters(tasks, typeFilter, priorityFilter);
  const filtered = typeFilter !== "all" || priorityFilter !== "all";

  if (!tasks.length) {
    return (
      <EmptyPanel
        icon={<Inbox />}
        title="No open tasks"
        body="Nothing in your inbox needs you right now. Sync to check for new mail."
      >
        {emptyAction}
      </EmptyPanel>
    );
  }

  const card = (t: Task) => (
    <TaskCard key={t.id} task={t} today={today} timezone={timezone} {...actions} />
  );
  const week = byBucket(visible, "week");
  const review = byBucket(visible, "needs_review");
  const undated = byBucket(visible, "undated");

  return (
    <div className="space-y-6">
      <FilterBar />
      {!visible.length && filtered ? (
        <EmptyPanel
          icon={<FilterX />}
          title="No tasks match these filters"
          body="Try another type or priority."
        >
          <Button variant="outline" size="sm" onClick={resetFilters}>
            Clear filters
          </Button>
        </EmptyPanel>
      ) : null}

      <Section
        id="overdue"
        title="Overdue"
        tasks={sortTasks(byBucket(visible, "overdue"))}
        tone="danger"
        render={card}
        hideWhenEmpty
      />
      <Section
        id="today"
        title="Today"
        tasks={sortTasks(byBucket(visible, "today"))}
        render={card}
        emptyText="Nothing due today."
      />
      <section aria-labelledby="h-week" className="space-y-3">
        <SectionHeading id="h-week" title="Next 7 days" count={week.length} />
        {week.length ? (
          groupByDay(week, today).map((g) => (
            <div key={g.date} id={`day-${g.date}`} className="scroll-mt-24 space-y-2">
              <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {g.label}
              </h4>
              <ul className="space-y-2">
                <AnimatePresence initial={false}>{g.tasks.map(card)}</AnimatePresence>
              </ul>
            </div>
          ))
        ) : (
          <p className="text-sm text-muted-foreground">Nothing else this week.</p>
        )}
      </section>
      <Section
        id="later"
        title="Later"
        tasks={sortTasks(byBucket(visible, "later"))}
        render={card}
        hideWhenEmpty
      />
      {undated.length ? (
        // collapsed: tasks with no date don't belong in the week view, but stay one click away
        <details className="group rounded-lg border border-dashed p-3" data-testid="undated">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium">
            <ChevronRight
              className="size-4 transition-transform group-open:rotate-90"
              aria-hidden="true"
            />
            No due date <span className="text-muted-foreground">({undated.length})</span>
            <span className="ml-auto text-xs font-normal text-muted-foreground">
              Not in your week: set a date to schedule it
            </span>
          </summary>
          <ul className="mt-3 space-y-2">{sortTasks(undated).map(card)}</ul>
        </details>
      ) : null}
      {review.length ? (
        <details className="group rounded-lg border border-dashed p-3">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium">
            <ChevronRight
              className="size-4 transition-transform group-open:rotate-90"
              aria-hidden="true"
            />
            Needs review <span className="text-muted-foreground">({review.length})</span>
            <span className="ml-auto text-xs font-normal text-muted-foreground">
              Low confidence: kept out of Today
            </span>
          </summary>
          <ul className="mt-3 space-y-2">{sortTasks(review).map(card)}</ul>
        </details>
      ) : null}
    </div>
  );
}

function SectionHeading({
  id,
  title,
  count,
  tone,
}: {
  id: string;
  title: string;
  count: number;
  tone?: "danger";
}) {
  return (
    <h3 id={id} className="flex items-center gap-2 text-sm font-semibold">
      <span className={cn(tone === "danger" && "text-p0")}>{title}</span>
      <span className="rounded-full bg-secondary px-2 text-xs font-medium text-muted-foreground">
        {count}
      </span>
    </h3>
  );
}

function Section(props: {
  id: string;
  title: string;
  tasks: Task[];
  render: (t: Task) => ReactNode;
  tone?: "danger";
  hideWhenEmpty?: boolean;
  emptyText?: string;
}) {
  if (!props.tasks.length && props.hideWhenEmpty) return null;
  return (
    <section aria-labelledby={`h-${props.id}`} className="space-y-3">
      <SectionHeading
        id={`h-${props.id}`}
        title={props.title}
        count={props.tasks.length}
        {...(props.tone ? { tone: props.tone } : {})}
      />
      {props.tasks.length ? (
        <ul className="space-y-2">
          <AnimatePresence initial={false}>{props.tasks.map(props.render)}</AnimatePresence>
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{props.emptyText}</p>
      )}
    </section>
  );
}

export function FilterBar() {
  const { typeFilter, priorityFilter, setTypeFilter, setPriorityFilter } = useUi();
  const priorities: (Priority | "all")[] = ["all", "P0", "P1", "P2", "P3"];
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter tasks">
      <div className="flex rounded-md border bg-card p-0.5" role="group" aria-label="Priority">
        {priorities.map((p) => (
          <button
            key={p}
            type="button"
            aria-pressed={priorityFilter === p}
            title={
              p === "all"
                ? "Show tasks of every priority"
                : `Show only ${p} (${PRIORITY_META[p].label}) tasks`
            }
            onClick={() => setPriorityFilter(p)}
            className={cn(
              "rounded px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors",
              priorityFilter === p && "bg-secondary text-foreground",
            )}
          >
            {p === "all" ? "All" : `${p} ${PRIORITY_META[p].label}`}
          </button>
        ))}
      </div>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="sr-only sm:not-sr-only">Type</span>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value as TaskType | "all")}
          className="h-8 rounded-md border bg-card px-2 text-xs text-foreground"
          aria-label="Task type"
          title="Show only tasks of this type"
        >
          <option value="all">All types</option>
          {Object.entries(TYPE_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

export function EmptyPanel({
  icon,
  title,
  body,
  children,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-10 text-center">
      <div className="text-muted-foreground [&_svg]:size-6" aria-hidden="true">
        {icon}
      </div>
      <p className="font-medium">{title}</p>
      <p className="max-w-sm text-sm text-muted-foreground">{body}</p>
      {children ? <div className="mt-2">{children}</div> : null}
    </div>
  );
}
