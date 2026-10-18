import { useEffect, useRef } from "react";

import type { Backdrop } from "@/lib/backdrops";
import { useUi } from "@/store/ui";

import { useSyncProgress } from "../agent-runs/context";

/**
 * The dashboard's live background. It reads the agent's progress in real time:
 * idle → calm; a sync running → busier; each finished batch of emails → a burst.
 * Decorative only (aria-hidden, no pointer events), behind every card, and it draws a single
 * still frame for people who prefer reduced motion.
 */
export function AgentBackdrop() {
  const backdrop = useUi((s) => s.backdrop);
  const palette = useUi((s) => s.palette);
  const theme = useUi((s) => s.theme);
  const progress = useSyncProgress();
  const busy = progress.phase === "running";
  const batches = progress.extracted?.done ?? 0;

  if (backdrop === "none") return null;
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
      data-testid="agent-backdrop"
      data-backdrop={backdrop}
      data-busy={busy ? "true" : "false"}
    >
      {backdrop === "aurora" ? (
        <Aurora busy={busy} />
      ) : (
        <CanvasBackdrop
          kind={backdrop}
          busy={busy}
          batches={batches}
          colorKey={`${palette}:${theme}`}
        />
      )}
    </div>
  );
}

function Aurora({ busy }: { busy: boolean }) {
  return (
    <div className={busy ? "aurora aurora-busy" : "aurora"}>
      <span className="aurora-blob aurora-a" />
      <span className="aurora-blob aurora-b" />
      <span className="aurora-blob aurora-c" />
    </div>
  );
}

// ------------------------------------------------------------------ canvas backdrops

type CanvasKind = Exclude<Backdrop, "none" | "aurora">;

interface Colors {
  primary: string; // "232 66% 54%"
  accent: string;
  muted: string;
}

const hsla = (hsl: string, a: number) => `hsl(${hsl} / ${a.toFixed(3)})`;

function readColors(): Colors {
  const css = getComputedStyle(document.documentElement);
  const get = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    primary: get("--primary", "232 66% 54%"),
    accent: get("--accent-foreground", "232 66% 40%"),
    muted: get("--muted-foreground", "220 9% 40%"),
  };
}

interface Scene {
  resize(w: number, h: number): void;
  /** draw one frame; `energy` 0..1 (idle ≈ 0.25, busy = 1), `dt` in frames (≈1 at 60 fps) */
  frame(ctx: CanvasRenderingContext2D, c: Colors, energy: number, dt: number): void;
  burst(): void;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

function neural(): Scene {
  let w = 0;
  let h = 0;
  let nodes: { x: number; y: number; vx: number; vy: number; glow: number }[] = [];
  let pulses: { a: number; b: number; t: number; speed: number }[] = [];
  const LINK = 150;
  const spawn = () => {
    if (nodes.length < 2) return;
    const a = Math.floor(Math.random() * nodes.length);
    const na = nodes[a];
    if (!na) return;
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (!n || i === a) continue;
      const d = Math.hypot(n.x - na.x, n.y - na.y);
      if (d < LINK && d < bestD && Math.random() < 0.6) {
        best = i;
        bestD = d;
      }
    }
    if (best >= 0) pulses.push({ a, b: best, t: 0, speed: rand(0.012, 0.03) });
  };
  return {
    resize(nw, nh) {
      w = nw;
      h = nh;
      const count = Math.min(70, Math.max(24, Math.round((w * h) / 22000)));
      nodes = Array.from({ length: count }, () => ({
        x: rand(0, w),
        y: rand(0, h),
        vx: rand(-0.15, 0.15),
        vy: rand(-0.15, 0.15),
        glow: 0,
      }));
      pulses = [];
    },
    burst() {
      for (let i = 0; i < 14; i++) spawn();
    },
    frame(ctx, c, energy, dt) {
      ctx.clearRect(0, 0, w, h);
      const speed = 0.4 + energy * 1.6;
      for (const n of nodes) {
        n.x += n.vx * speed * dt;
        n.y += n.vy * speed * dt;
        if (n.x < 0 || n.x > w) n.vx *= -1;
        if (n.y < 0 || n.y > h) n.vy *= -1;
        n.glow = Math.max(0, n.glow - 0.02 * dt);
      }
      ctx.lineWidth = 1;
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        if (!a) continue;
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          if (!b) continue;
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d > LINK) continue;
          ctx.strokeStyle = hsla(c.primary, (1 - d / LINK) * (0.08 + energy * 0.1));
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
      if (Math.random() < (0.02 + energy * 0.25) * dt) spawn();
      pulses = pulses.filter((p) => {
        p.t += p.speed * speed * dt;
        const a = nodes[p.a];
        const b = nodes[p.b];
        if (!a || !b) return false;
        if (p.t >= 1) {
          b.glow = 1;
          return false;
        }
        const x = a.x + (b.x - a.x) * p.t;
        const y = a.y + (b.y - a.y) * p.t;
        ctx.fillStyle = hsla(c.primary, 0.55 + energy * 0.35);
        ctx.beginPath();
        ctx.arc(x, y, 2.2, 0, Math.PI * 2);
        ctx.fill();
        return true;
      });
      for (const n of nodes) {
        ctx.fillStyle = hsla(c.primary, 0.18 + n.glow * 0.6);
        ctx.beginPath();
        ctx.arc(n.x, n.y, 1.8 + n.glow * 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    },
  };
}

function mailstream(): Scene {
  let w = 0;
  let h = 0;
  let mails: { x: number; y: number; s: number; drift: number; phase: number; life: number }[] = [];
  let coreGlow = 0;
  const core = () => ({ x: w * 0.82, y: h * 0.28 });
  const add = (fromBottom: boolean) =>
    mails.push({
      x: rand(0, w * 0.75),
      y: fromBottom ? h + 20 : rand(0, h),
      s: rand(0.7, 1.2),
      drift: rand(0.2, 0.6),
      phase: rand(0, Math.PI * 2),
      life: 1,
    });
  const envelope = (ctx: CanvasRenderingContext2D, x: number, y: number, s: number) => {
    const ew = 16 * s;
    const eh = 11 * s;
    ctx.strokeRect(x - ew / 2, y - eh / 2, ew, eh);
    ctx.beginPath();
    ctx.moveTo(x - ew / 2, y - eh / 2);
    ctx.lineTo(x, y + eh * 0.1);
    ctx.lineTo(x + ew / 2, y - eh / 2);
    ctx.stroke();
  };
  return {
    resize(nw, nh) {
      w = nw;
      h = nh;
      mails = [];
      for (let i = 0; i < 16; i++) add(false);
    },
    burst() {
      for (let i = 0; i < 8; i++) add(true);
      coreGlow = 1;
    },
    frame(ctx, c, energy, dt) {
      ctx.clearRect(0, 0, w, h);
      const target = core();
      const want = Math.round(16 + energy * 24);
      if (mails.length < want && Math.random() < 0.3 * dt) add(true);
      ctx.lineWidth = 1.2;
      mails = mails.filter((m) => {
        m.phase += 0.02 * dt;
        if (energy > 0.6) {
          // the agent is reading: mail flows into the core
          const dx = target.x - m.x;
          const dy = target.y - m.y;
          const d = Math.hypot(dx, dy) || 1;
          const v = (1.2 + energy * 1.5) * dt;
          m.x += (dx / d) * v + Math.sin(m.phase) * 0.3;
          m.y += (dy / d) * v;
          if (d < 18) {
            coreGlow = Math.min(1, coreGlow + 0.25);
            return false;
          }
        } else {
          m.y -= m.drift * dt;
          m.x += Math.sin(m.phase) * 0.25 * dt;
          if (m.y < -20) return false;
        }
        ctx.strokeStyle = hsla(c.primary, 0.16 + energy * 0.16);
        envelope(ctx, m.x, m.y, m.s);
        return true;
      });
      coreGlow = Math.max(0, coreGlow - 0.01 * dt);
      const r = 26 + energy * 10 + coreGlow * 12;
      const g = ctx.createRadialGradient(target.x, target.y, 0, target.x, target.y, r * 2.2);
      g.addColorStop(0, hsla(c.primary, 0.1 + energy * 0.18 + coreGlow * 0.25));
      g.addColorStop(1, hsla(c.primary, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(target.x, target.y, r * 2.2, 0, Math.PI * 2);
      ctx.fill();
    },
  };
}

function signal(): Scene {
  let w = 0;
  let h = 0;
  let scan = 0;
  let packets: { x: number; y: number; vx: number; vy: number; life: number }[] = [];
  const GAP = 48;
  const add = () => {
    const horizontal = Math.random() < 0.5;
    packets.push({
      x: horizontal ? 0 : Math.round(rand(0, w) / GAP) * GAP,
      y: horizontal ? Math.round(rand(0, h) / GAP) * GAP : 0,
      vx: horizontal ? rand(1.5, 3) : 0,
      vy: horizontal ? 0 : rand(1.5, 3),
      life: 1,
    });
  };
  return {
    resize(nw, nh) {
      w = nw;
      h = nh;
      packets = [];
    },
    burst() {
      for (let i = 0; i < 10; i++) add();
    },
    frame(ctx, c, energy, dt) {
      ctx.clearRect(0, 0, w, h);
      ctx.lineWidth = 1;
      ctx.strokeStyle = hsla(c.muted, 0.07);
      ctx.beginPath();
      for (let x = 0; x <= w; x += GAP) {
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, h);
      }
      for (let y = 0; y <= h; y += GAP) {
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(w, y + 0.5);
      }
      ctx.stroke();

      scan = (scan + (0.6 + energy * 3) * dt) % (h + 120);
      const g = ctx.createLinearGradient(0, scan - 120, 0, scan);
      g.addColorStop(0, hsla(c.primary, 0));
      g.addColorStop(1, hsla(c.primary, 0.06 + energy * 0.1));
      ctx.fillStyle = g;
      ctx.fillRect(0, scan - 120, w, 120);

      if (Math.random() < (0.03 + energy * 0.3) * dt) add();
      const speed = 0.6 + energy * 1.4;
      packets = packets.filter((p) => {
        p.x += p.vx * speed * dt;
        p.y += p.vy * speed * dt;
        if (p.x > w || p.y > h) return false;
        ctx.fillStyle = hsla(c.primary, 0.35 + energy * 0.4);
        ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
        ctx.fillStyle = hsla(c.primary, 0.08 + energy * 0.08);
        ctx.fillRect(p.x - (p.vx ? 24 : 1), p.y - (p.vy ? 24 : 1), p.vx ? 22 : 2, p.vy ? 22 : 2);
        return true;
      });
    },
  };
}

const SCENES: Record<CanvasKind, () => Scene> = { neural, mailstream, signal };

function CanvasBackdrop({
  kind,
  busy,
  batches,
  colorKey,
}: {
  kind: CanvasKind;
  busy: boolean;
  batches: number;
  colorKey: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<Scene | null>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;

  // each finished batch of emails is a visible burst of activity
  useEffect(() => {
    if (batches > 0) sceneRef.current?.burst();
  }, [batches]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return; // no canvas support (e.g. tests): stay blank
    const scene = SCENES[kind]();
    sceneRef.current = scene;
    let colors = readColors();
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const { innerWidth: w, innerHeight: h } = window;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      scene.resize(w, h);
    };
    resize();

    let energy = busyRef.current ? 1 : 0.25;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(3, (now - last) / 16.7);
      last = now;
      // ease towards the agent's current state, so the change is visible but smooth
      energy += ((busyRef.current ? 1 : 0.25) - energy) * 0.04 * dt;
      if (!document.hidden) scene.frame(ctx, colors, energy, dt);
      raf = requestAnimationFrame(tick);
    };
    if (reduce)
      scene.frame(ctx, colors, 0.25, 1); // one still frame
    else raf = requestAnimationFrame(tick);

    const onResize = () => {
      resize();
      colors = readColors();
      if (reduce) scene.frame(ctx, colors, 0.25, 1);
    };
    window.addEventListener("resize", onResize);
    // theme or palette changed: pick up the new colours on the next frame
    const recolor = window.setTimeout(() => (colors = readColors()), 50);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(recolor);
      window.removeEventListener("resize", onResize);
      sceneRef.current = null;
    };
  }, [kind, colorKey]);

  return <canvas ref={canvasRef} className="absolute inset-0" />;
}
