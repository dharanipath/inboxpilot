import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CalendarClock,
  CreditCard,
  FileSearch,
  Flag,
  Minus,
  Phone,
  Repeat,
  Reply,
  Send,
  Sparkles,
  type LucideIcon,
} from "lucide-react";

import type { Priority, TaskType } from "@/api/types";
import { Badge } from "@/components/ui/primitives";
import { PRIORITY_META, TYPE_LABEL } from "@/lib/format";
import { cn } from "@/lib/utils";

const PRIORITY_ICON: Record<Priority, LucideIcon> = {
  P0: AlertTriangle,
  P1: ArrowUp,
  P2: Minus,
  P3: ArrowDown,
};

/** Colour is never the only signal: every chip carries an icon and text. */
export function PriorityChip({ priority, className }: { priority: Priority; className?: string }) {
  const meta = PRIORITY_META[priority];
  const Icon = PRIORITY_ICON[priority];
  return (
    <Badge
      className={cn("border-transparent ring-1 ring-inset", meta.className, className)}
      aria-label={`Priority ${priority}, ${meta.label.toLowerCase()}`}
    >
      <Icon aria-hidden="true" />
      <span aria-hidden="true">
        {priority} · {meta.label}
      </span>
    </Badge>
  );
}

const TYPE_ICON: Record<TaskType, LucideIcon> = {
  deadline: Flag,
  meeting: CalendarClock,
  payment: CreditCard,
  review: FileSearch,
  reply: Reply,
  send: Send,
  call: Phone,
  follow_up: Repeat,
  other: Sparkles,
};

export function TypeIcon({ type, className }: { type: TaskType; className?: string }) {
  const Icon = TYPE_ICON[type];
  return (
    <span
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-accent text-accent-foreground",
        className,
      )}
      title={TYPE_LABEL[type]}
    >
      <Icon className="size-4" aria-hidden="true" />
      <span className="sr-only">{TYPE_LABEL[type]}</span>
    </span>
  );
}
