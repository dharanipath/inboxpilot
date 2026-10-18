/**
 * Live dashboard backgrounds. Each one reacts to the agent in real time: calm while it waits,
 * busier while a sync runs, with a burst every time it finishes a batch of emails.
 */
export type Backdrop = "none" | "aurora" | "neural" | "mailstream" | "signal";

export interface BackdropInfo {
  id: Backdrop;
  label: string;
  description: string;
}

export const BACKDROPS: BackdropInfo[] = [
  { id: "none", label: "Plain", description: "No background. Nothing moves." },
  {
    id: "aurora",
    label: "Aurora",
    description: "Soft glows in your theme colours; they drift faster while the agent works.",
  },
  {
    id: "neural",
    label: "Neural mesh",
    description: "A network of nodes; signals race along it while the agent reads your mail.",
  },
  {
    id: "mailstream",
    label: "Mail stream",
    description: "Envelopes drift by; during a sync they flow into the glowing agent core.",
  },
  {
    id: "signal",
    label: "Signal grid",
    description: "A quiet grid with a scan line and data packets that speed up as the agent works.",
  },
];

export const DEFAULT_BACKDROP: Backdrop = "aurora";
