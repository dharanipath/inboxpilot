/**
 * Colour themes for the dashboard, each a take on the email-agent idea. A palette only recolours
 * the brand surfaces (background, cards, primary, accent, borders); the P0–P3 priority colours
 * stay identical in every palette, so urgency always reads the same. Each palette has a light and
 * a dark variant (see index.css), combined with the Light / Dark / System mode.
 */
export type Palette = "inbox" | "inbox-zero" | "paper-ink" | "midnight" | "lavender";

export interface PaletteInfo {
  id: Palette;
  label: string;
  description: string;
  /** three swatch colours (light variant): background, primary, accent */
  swatch: [string, string, string];
}

export const PALETTES: PaletteInfo[] = [
  {
    id: "inbox",
    label: "Inbox Blue",
    description: "The classic: clear indigo on a cool white desk.",
    swatch: ["hsl(220 20% 98%)", "hsl(232 66% 54%)", "hsl(228 70% 92%)"],
  },
  {
    id: "inbox-zero",
    label: "Inbox Zero",
    description: "Calm emerald for the feeling of an empty to-do list.",
    swatch: ["hsl(150 25% 97%)", "hsl(161 94% 26%)", "hsl(152 55% 90%)"],
  },
  {
    id: "paper-ink",
    label: "Paper & Ink",
    description: "Letter paper and fountain-pen navy; gold ink after dark.",
    swatch: ["hsl(40 38% 95%)", "hsl(222 60% 32%)", "hsl(40 55% 86%)"],
  },
  {
    id: "midnight",
    label: "Midnight Courier",
    description: "The night-shift mail run: deep navy and signal cyan.",
    swatch: ["hsl(210 30% 97%)", "hsl(199 89% 33%)", "hsl(199 80% 90%)"],
  },
  {
    id: "lavender",
    label: "Lavender Digest",
    description: "A soft violet for reading the daily briefing.",
    swatch: ["hsl(260 30% 98%)", "hsl(262 60% 50%)", "hsl(262 70% 93%)"],
  },
];

export const DEFAULT_PALETTE: Palette = "inbox";

export const isPalette = (v: unknown): v is Palette => PALETTES.some((p) => p.id === v);

/** Sets data-palette on <html>; the default palette is the base CSS, so no attribute. */
export function applyPalette(palette: Palette): void {
  const root = document.documentElement;
  if (palette === DEFAULT_PALETTE) delete root.dataset.palette;
  else root.dataset.palette = palette;
}
