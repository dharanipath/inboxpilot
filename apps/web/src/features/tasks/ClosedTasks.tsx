import { AnimatePresence } from "framer-motion";
import { useState } from "react";

import { useClosedTasks } from "@/api/hooks";
import { Button } from "@/components/ui/button";

import { TaskCard, type TaskActions } from "./TaskCard";

const SHOWN = 5;

/**
 * Everything taken off the list (done, snoozed, dismissed), most recent first, so a mis-click is
 * never final: each card has Reopen, which puts the task back exactly as it was.
 */
export function ClosedTasks({
  today,
  timezone,
  actions,
}: {
  today: string;
  timezone: string;
  actions: TaskActions;
}) {
  const q = useClosedTasks();
  const [all, setAll] = useState(false);
  const tasks = [...(q.data?.items ?? [])].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  if (!tasks.length) return null;
  const visible = all ? tasks : tasks.slice(0, SHOWN);

  return (
    <section aria-labelledby="h-closed" className="space-y-3">
      <div>
        <h3 id="h-closed" className="flex items-center gap-2 text-sm font-semibold">
          Done, snoozed &amp; dismissed
          <span className="rounded-full bg-secondary px-2 text-xs font-medium text-muted-foreground">
            {tasks.length}
          </span>
        </h3>
        <p className="text-xs text-muted-foreground">
          Changed your mind? Reopen puts a task back on your list as it was.
        </p>
      </div>
      <ul className="space-y-2">
        <AnimatePresence initial={false}>
          {visible.map((t) => (
            <TaskCard key={t.id} task={t} today={today} timezone={timezone} {...actions} />
          ))}
        </AnimatePresence>
      </ul>
      {tasks.length > SHOWN ? (
        <Button variant="ghost" size="sm" onClick={() => setAll((v) => !v)} aria-expanded={all}>
          {all ? "Show fewer" : `Show all ${tasks.length}`}
        </Button>
      ) : null}
    </section>
  );
}
