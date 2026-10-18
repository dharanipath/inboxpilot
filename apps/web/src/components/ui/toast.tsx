/** Minimal accessible toasts (polite live region), with an optional action such as "Undo". */
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { useEffect } from "react";
import { create } from "zustand";

import { cn } from "@/lib/utils";

export interface ToastItem {
  id: number;
  title: string;
  description?: string;
  tone?: "default" | "error";
  action?: { label: string; onClick: () => void };
}

interface ToastState {
  toasts: ToastItem[];
  push: (t: Omit<ToastItem, "id">) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (t) => set((s) => ({ toasts: [...s.toasts.slice(-2), { ...t, id: nextId++ }] })),
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export const toast = (t: Omit<ToastItem, "id">): void => useToasts.getState().push(t);

function ToastCard({ t }: { t: ToastItem }) {
  const dismiss = useToasts((s) => s.dismiss);
  useEffect(() => {
    const timer = setTimeout(() => dismiss(t.id), t.action ? 7000 : 4500);
    return () => clearTimeout(timer);
  }, [t.id, t.action, dismiss]);
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8 }}
      className={cn(
        "pointer-events-auto flex w-full items-start gap-3 rounded-lg border bg-card p-3 pr-2 shadow-lg",
        t.tone === "error" && "border-destructive/40",
      )}
    >
      <div className="min-w-0 flex-1">
        <p className={cn("text-sm font-medium", t.tone === "error" && "text-destructive")}>
          {t.title}
        </p>
        {t.description ? (
          <p className="mt-0.5 text-xs text-muted-foreground">{t.description}</p>
        ) : null}
      </div>
      {t.action ? (
        <button
          type="button"
          className="shrink-0 rounded px-2 py-1 text-xs font-semibold text-primary hover:bg-accent"
          onClick={() => {
            t.action?.onClick();
            dismiss(t.id);
          }}
        >
          {t.action.label}
        </button>
      ) : null}
      <button
        type="button"
        aria-label="Dismiss notification"
        title="Dismiss notification"
        className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground"
        onClick={() => dismiss(t.id)}
      >
        <X className="size-3.5" />
      </button>
    </motion.div>
  );
}

export function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-4 bottom-4 z-[60] flex flex-col items-end gap-2 sm:left-auto sm:right-4 sm:w-96"
    >
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <ToastCard key={t.id} t={t} />
        ))}
      </AnimatePresence>
    </div>
  );
}
