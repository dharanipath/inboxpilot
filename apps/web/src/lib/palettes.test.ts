/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// read from disk: vitest is configured with css: false, so CSS imports are empty in tests
const css = readFileSync(resolve(process.cwd(), "src/index.css"), "utf8");

import { applyPalette, DEFAULT_PALETTE, isPalette, PALETTES } from "./palettes";

/** CSS custom properties per selector, from index.css. */
function blocks(): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (m[1] ?? "").replace(/\/\*[\s\S]*?\*\//g, "").trim();
    const vars: Record<string, string> = {};
    for (const v of (m[2] ?? "").matchAll(/--([\w-]+):\s*([^;]+);/g))
      vars[v[1] ?? ""] = (v[2] ?? "").trim();
    if (Object.keys(vars).length) out.set(selector, vars);
  }
  return out;
}

function luminance(hsl: string): number {
  const [h = 0, s = 0, l = 0] = hsl.replace(/%/g, "").split(/\s+/).map(Number);
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(0) + 0.7152 * f(8) + 0.0722 * f(4);
}

const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return ((x ?? 0) + 0.05) / ((y ?? 0) + 0.05);
};

/** Text pairs that must stay readable (WCAG AA, 4.5:1 for normal text). */
const PAIRS: [string, string][] = [
  ["foreground", "background"],
  ["card-foreground", "card"],
  ["primary-foreground", "primary"],
  ["muted-foreground", "background"],
  ["muted-foreground", "card"],
  ["accent-foreground", "accent"],
  ["secondary-foreground", "secondary"],
];

describe("colour themes", () => {
  const all = blocks();
  const root = all.get(":root") ?? {};
  const dark = all.get(".dark") ?? {};

  const variants = PALETTES.flatMap((p) => {
    const light =
      p.id === DEFAULT_PALETTE
        ? root
        : { ...root, ...all.get(`:root[data-palette="${p.id}"]:not(.dark)`) };
    const night =
      p.id === DEFAULT_PALETTE
        ? { ...root, ...dark }
        : { ...root, ...dark, ...all.get(`:root.dark[data-palette="${p.id}"]`) };
    return [
      [`${p.label} (light)`, light],
      [`${p.label} (dark)`, night],
    ] as const;
  });

  it("every palette has CSS for both light and dark", () => {
    for (const p of PALETTES.filter((x) => x.id !== DEFAULT_PALETTE)) {
      expect(all.has(`:root[data-palette="${p.id}"]:not(.dark)`), p.id).toBe(true);
      expect(all.has(`:root.dark[data-palette="${p.id}"]`), p.id).toBe(true);
    }
  });

  it.each(variants)("%s keeps text readable (WCAG AA)", (_name, vars) => {
    for (const [fg, bg] of PAIRS) {
      const ratio = contrast(vars[fg] ?? "", vars[bg] ?? "");
      expect(ratio, `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("never changes the priority colours, so urgency reads the same in every theme", () => {
    for (const [selector, vars] of all) {
      if (!selector.includes("data-palette")) continue;
      expect(
        Object.keys(vars).filter((k) => /^p[0-3]$|^success$|^warning$|^destructive/.test(k)),
      ).toEqual([]);
    }
  });

  afterEach(() => applyPalette(DEFAULT_PALETTE));

  it("applies a palette to <html> and clears it for the default", () => {
    applyPalette("midnight");
    expect(document.documentElement.dataset.palette).toBe("midnight");
    applyPalette(DEFAULT_PALETTE);
    expect(document.documentElement.dataset.palette).toBeUndefined();
    expect(isPalette("paper-ink")).toBe(true);
    expect(isPalette("neon")).toBe(false);
  });
});
