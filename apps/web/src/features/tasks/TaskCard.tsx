import { motion } from "framer-motion";
import {
  AlarmClock,
  Check,
  CheckCircle2,
  ExternalLink,
  Info,
  MoreHorizontal,
  Quote,
  RotateCcw,
  X,
} from "lucide-react";
import { useState } from "react";

import type { Task } from "@/api/types";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
} from "@/components/ui/primitives";
import {
  dayLabel,
  dueLabel,
  localDateOf,
  snoozeOptions,
  timeLabel,
  TYPE_LABEL,
} from "@/lib/format";
import { cn } from "@/lib/utils";

import { PriorityChip, TypeIcon } from "./badges";

export interface TaskActions {
  onDone: (task: Task) => void;
  onSnooze: (task: Task, until: Date) => void;
  onDismiss: (task: Task) => void;
  onEditDue: (task: Task, dueDate: string | null) => void;
  /** Done, dismissed or snoozed tasks (shown in Past 7 days) can be put back on the list. */
  onReopen: (task: Task) => void;
}

interface Props extends TaskActions {
  task: Task;
  today: string;
  timezone: string;
  now?: Date;
}

/** Done, dismissed or still-snoozed: not on the Upcoming list. Null while the task is open. */
export function closedState(task: Task, now: Date): string | null {
  if (task.status === "done") return "Done";
  if (task.status === "dismissed") return "Dismissed";
  if (
    task.status === "snoozed" &&
    task.snoozed_until &&
    Date.parse(task.snoozed_until) > now.getTime()
  )
    return "Snoozed";
  return null;
}

const SOURCE_LABEL: Record<Task["date_source"], string> = {
  resolver: "Resolved from the email's wording",
  llm: "Model's date guess",
  none: "No date in the email",
  user: "Set by you",
};

export function TaskCard({
  task,
  today,
  timezone,
  now = new Date(),
  onDone,
  onSnooze,
  onDismiss,
  onEditDue,
  onReopen,
}: Props) {
  const sender = task.source.from_name ?? task.source.from_email;
  const closed = closedState(task, now);
  // a finished task is not "overdue": say when it was due instead
  const due =
    closed && task.due_date
      ? `Due ${dayLabel(task.due_date, today)}`
      : dueLabel(task, today, timezone);
  const overdue = !closed && task.bucket === "overdue";
  const titleId = `task-${task.id}-title`;

  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: 24, transition: { duration: 0.18 } }}
      aria-labelledby={titleId}
      className={cn(
        "group flex gap-3 rounded-lg border bg-card p-3 shadow-sm transition-shadow hover:shadow-md sm:p-4",
        closed && "bg-muted/40",
      )}
      data-testid="task-card"
    >
      <TypeIcon type={task.type} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
          {/* not a heading: cards are list items labelled by their title, under the section headings */}
          <p
            id={titleId}
            className={cn(
              "min-w-0 flex-1 basis-48 text-sm font-medium leading-snug",
              closed && closed !== "Snoozed" && "text-muted-foreground line-through",
            )}
          >
            {task.title}
          </p>
          {closed ? (
            <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium text-muted-foreground">
              {closed === "Done" ? (
                <CheckCircle2 className="size-3 text-success" aria-hidden="true" />
              ) : closed === "Snoozed" ? (
                <AlarmClock className="size-3" aria-hidden="true" />
              ) : (
                <X className="size-3" aria-hidden="true" />
              )}
              {closed === "Snoozed" && task.snoozed_until
                ? `Snoozed until ${dayLabel(localDateOf(new Date(task.snoozed_until), timezone), today)}, ${timeLabel(task.snoozed_until, timezone)}`
                : closed}
            </span>
          ) : null}
          <PriorityChip priority={task.priority} />
        </div>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          <span className={cn("font-medium", overdue ? "text-p0" : "text-foreground/80")}>
            {due}
          </span>
          <span aria-hidden="true">·</span>
          <span>{TYPE_LABEL[task.type]}</span>
          <span aria-hidden="true">·</span>
          <span className="truncate">From {sender}</span>
        </p>
        <Tooltip content={<span className="whitespace-pre-wrap">{task.evidence}</span>}>
          <p className="mt-2 line-clamp-2 border-l-2 pl-2 text-xs italic text-muted-foreground sm:line-clamp-1">
            <Quote className="mr-1 inline size-3 align-baseline" aria-hidden="true" />
            <span className="sr-only">Evidence: </span>
            {task.evidence}
          </p>
        </Tooltip>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1 sm:flex-row sm:items-start">
        {closed ? (
          <Button
            size="icon-sm"
            variant="outline"
            aria-label={`Reopen "${task.title}"`}
            onClick={() => onReopen(task)}
          >
            <RotateCcw />
          </Button>
        ) : (
          <Button
            size="icon-sm"
            variant="outline"
            aria-label={`Mark "${task.title}" as done`}
            onClick={() => onDone(task)}
          >
            <Check />
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label={`More actions for "${task.title}"`}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {closed ? null : (
              <>
                <DropdownMenuLabel>Snooze</DropdownMenuLabel>
                {snoozeOptions(now, timezone).map((o) => (
                  <DropdownMenuItem key={o.label} onSelect={() => onSnooze(task, o.until)}>
                    <AlarmClock /> {o.label}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem asChild>
              <a href={task.gmail_url} target="_blank" rel="noreferrer noopener">
                <ExternalLink /> Open in Gmail
              </a>
            </DropdownMenuItem>
            {closed ? null : (
              <DropdownMenuItem onSelect={() => onDismiss(task)}>
                <X /> Not a task — dismiss
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <TaskDetails task={task} today={today} timezone={timezone} onEditDue={onEditDue} />
      </div>
    </motion.li>
  );
}

function TaskDetails({
  task,
  today,
  timezone,
  onEditDue,
}: Pick<Props, "task" | "today" | "timezone" | "onEditDue">) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(task.due_date ?? "");
  const received = new Date(task.source.received_at).toLocaleString("en-GB", {
    timeZone: timezone,
    dateStyle: "medium",
    timeStyle: "short",
  });
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="icon-sm" variant="ghost" aria-label={`Why "${task.title}"?`}>
          <Info />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-96 space-y-3 text-sm">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Evidence
          </p>
          <blockquote className="mt-1 border-l-2 border-primary/60 pl-3 text-sm">
            {task.evidence}
          </blockquote>
          <p className="mt-1 text-xs text-muted-foreground">
            {task.source.from_name
              ? `${task.source.from_name} <${task.source.from_email}>`
              : task.source.from_email}{" "}
            · “{task.source.subject}” · {received}
          </p>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Priority {task.priority} · score {task.priority_score}
          </p>
          <ul className="mt-1 flex flex-wrap gap-1">
            {task.priority_reasons.map((r) => (
              <li key={r} className="rounded bg-secondary px-1.5 py-0.5 text-xs">
                {r}
              </li>
            ))}
          </ul>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Due</dt>
          <dd>
            {dueLabel(task, today, timezone)}
            {task.due_phrase ? (
              <span className="text-muted-foreground"> (“{task.due_phrase}”)</span>
            ) : null}
          </dd>
          <dt className="text-muted-foreground">Date from</dt>
          <dd>{SOURCE_LABEL[task.date_source]}</dd>
          <dt className="text-muted-foreground">Confidence</dt>
          <dd>{Math.round(task.confidence * 100)}%</dd>
          <dt className="text-muted-foreground">Extracted by</dt>
          <dd className="break-all">{task.extracted_by}</dd>
        </dl>
        <form
          className="flex items-end gap-2 border-t pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            onEditDue(task, date || null);
            setOpen(false);
          }}
        >
          <label htmlFor={`due-${task.id}`} className="flex-1 text-xs text-muted-foreground">
            Change due date
            <Input
              id={`due-${task.id}`}
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="mt-1"
            />
          </label>
          <Button type="submit" size="sm">
            Save
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}
