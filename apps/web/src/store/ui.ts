import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { Priority, TaskType } from "@/api/types";
import { type Backdrop, DEFAULT_BACKDROP } from "@/lib/backdrops";
import { DEFAULT_PALETTE, type Palette } from "@/lib/palettes";

export type Theme = "system" | "light" | "dark";

interface UiState {
  theme: Theme;
  /** colour theme (see lib/palettes.ts), combined with the light/dark mode */
  palette: Palette;
  /** live dashboard background (see lib/backdrops.ts) */
  backdrop: Backdrop;
  typeFilter: TaskType | "all";
  priorityFilter: Priority | "all";
  /** the sync run whose live progress the agent panel is showing */
  activeRunId: string | null;
  setTheme: (t: Theme) => void;
  setPalette: (p: Palette) => void;
  setBackdrop: (b: Backdrop) => void;
  setTypeFilter: (t: TaskType | "all") => void;
  setPriorityFilter: (p: Priority | "all") => void;
  setActiveRun: (id: string | null) => void;
  resetFilters: () => void;
}

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      theme: "system",
      palette: DEFAULT_PALETTE,
      backdrop: DEFAULT_BACKDROP,
      typeFilter: "all",
      priorityFilter: "all",
      activeRunId: null,
      setTheme: (theme) => set({ theme }),
      setPalette: (palette) => set({ palette }),
      setBackdrop: (backdrop) => set({ backdrop }),
      setTypeFilter: (typeFilter) => set({ typeFilter }),
      setPriorityFilter: (priorityFilter) => set({ priorityFilter }),
      setActiveRun: (activeRunId) => set({ activeRunId }),
      resetFilters: () => set({ typeFilter: "all", priorityFilter: "all" }),
    }),
    {
      name: "inboxpilot-ui",
      storage: createJSONStorage(() => localStorage),
      // only appearance survives reloads
      partialize: (s) => ({ theme: s.theme, palette: s.palette, backdrop: s.backdrop }),
    },
  ),
);

export function applyTheme(theme: Theme): void {
  const dark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}
