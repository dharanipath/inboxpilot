import { useUpdateTask } from "@/api/hooks";
import type { Task } from "@/api/types";
import { toast } from "@/components/ui/toast";

import type { TaskActions } from "./TaskCard";

/** Task actions with feedback and Undo. Undo simply reopens: the server keeps nothing else. */
export function useTaskActions(): TaskActions {
  const update = useUpdateTask();

  const run = (
    task: Task,
    patch: Parameters<typeof update.mutate>[0]["patch"],
    title: string,
    undo = true,
  ) => {
    update.mutate(
      { id: task.id, patch },
      {
        onSuccess: () =>
          toast({
            title,
            description: task.title,
            ...(undo
              ? {
                  action: {
                    label: "Undo",
                    onClick: () => update.mutate({ id: task.id, patch: { status: "open" } }),
                  },
                }
              : {}),
          }),
        onError: () =>
          toast({
            title: "Couldn't update the task",
            description: "Please try again.",
            tone: "error",
          }),
      },
    );
  };

  return {
    onDone: (task) => run(task, { status: "done" }, "Marked done"),
    onDismiss: (task) => run(task, { status: "dismissed" }, "Dismissed"),
    onSnooze: (task, until) =>
      run(
        task,
        { snoozed_until: until.toISOString() },
        `Snoozed until ${until.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`,
      ),
    onReopen: (task) => run(task, { status: "open" }, "Back on your list", false),
    onEditDue: (task, dueDate) =>
      run(task, { due_date: dueDate }, dueDate ? "Due date updated" : "Due date cleared", false),
  };
}
