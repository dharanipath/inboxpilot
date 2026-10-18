/**
 * Gmail API message (format=full) → contract EmailInput.
 * Gmail has already undone Content-Transfer-Encoding: part bodies are base64url of the raw
 * bytes in the part's declared charset.
 */
import type { EmailInput } from "../agent/types.js";

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: GmailPart;
}

export const MAX_BODY_CHARS = 50_000;

// ---------------------------------------------------------------- headers

export function header(headers: GmailHeader[] | undefined, name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers?.find((h) => h.name.toLowerCase() === lower)?.value;
}

/** RFC 2047 encoded-words: =?UTF-8?B?...?= and =?ISO-8859-1?Q?...?= */
export function decodeEncodedWords(value: string): string {
  return value
    .replace(/(\?=)\s+(=\?)/g, "$1$2") // whitespace between adjacent encoded words is dropped
    .replace(
      /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
      (whole, charset: string, enc: string, text: string) => {
        try {
          const bytes =
            enc.toUpperCase() === "B"
              ? Buffer.from(text, "base64")
              : Buffer.from(
                  text
                    .replace(/_/g, " ")
                    .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) =>
                      String.fromCharCode(parseInt(hex, 16)),
                    ),
                  "latin1",
                );
          return decodeBytes(bytes, charset);
        } catch {
          return whole;
        }
      },
    );
}

export interface Address {
  name: string | null;
  email: string;
}

/** Split an address list on commas that are outside quotes and angle brackets. */
export function parseAddressList(value: string | undefined): Address[] {
  if (!value) return [];
  const out: string[] = [];
  let current = "";
  let quoted = false;
  let angle = 0;
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "<" && !quoted) angle++;
    else if (ch === ">" && !quoted) angle = Math.max(0, angle - 1);
    if (ch === "," && !quoted && angle === 0) {
      out.push(current);
      current = "";
    } else current += ch;
  }
  out.push(current);
  return out.map(parseAddress).filter((a): a is Address => a !== null);
}

export function parseAddress(raw: string): Address | null {
  const value = decodeEncodedWords(raw.trim());
  if (!value) return null;
  const m = /^(.*?)\s*<([^<>]+)>\s*$/.exec(value);
  if (m) {
    const name = (m[1] ?? "")
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .replace(/\\"/g, '"')
      .trim();
    return { name: name || null, email: (m[2] ?? "").trim().toLowerCase() };
  }
  return value.includes("@") ? { name: null, email: value.toLowerCase() } : null;
}

// ---------------------------------------------------------------- bodies

function decodeBytes(bytes: Buffer, charset: string | undefined): string {
  const label = (charset ?? "utf-8").trim().toLowerCase();
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes); // unknown charset label
  }
}

function charsetOf(part: GmailPart): string | undefined {
  const ct = header(part.headers, "Content-Type") ?? "";
  return /charset="?([^";\s]+)"?/i.exec(ct)?.[1];
}

function isAttachment(part: GmailPart): boolean {
  if (part.filename) return true;
  const disposition = header(part.headers, "Content-Disposition") ?? "";
  return /^\s*attachment/i.test(disposition);
}

function decodePart(part: GmailPart): string | null {
  const data = part.body?.data;
  if (!data) return null;
  return decodeBytes(Buffer.from(data, "base64url"), charsetOf(part));
}

/** Depth-first search for the first inline part of the given type. */
function findPart(part: GmailPart | undefined, mimeType: string): GmailPart | null {
  if (!part) return null;
  if (part.mimeType?.toLowerCase() === mimeType && !isAttachment(part) && part.body?.data)
    return part;
  for (const child of part.parts ?? []) {
    const hit = findPart(child, mimeType);
    if (hit) return hit;
  }
  return null;
}

const ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  copy: "©",
  reg: "®",
  trade: "™",
  euro: "€",
  pound: "£",
  bull: "•",
  middot: "·",
  zwnj: "",
  zwj: "",
  shy: "",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code =
        ref[1]?.toLowerCase() === "x" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES[ref.toLowerCase()] ?? whole;
  });
}

/** Readable text from an HTML email. Scripts, styles and tags never reach the agent. */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(
      /<\/(p|div|tr|h[1-6]|table|ul|ol|blockquote|section|article|header|footer)\s*>/gi,
      "\n",
    )
    .replace(/<(p|div|tr|h[1-6]|table|blockquote)\b[^>]*>/gi, "\n")
    .replace(/<td\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, "");
  return normaliseText(decodeEntities(text));
}

function normaliseText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim()) // per line: spaces, tabs and NBSPs collapse
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Prefer text/plain; fall back to text/html converted to text. Attachments are ignored. */
export function extractBody(payload: GmailPart | undefined): string {
  const plain = findPart(payload, "text/plain");
  const plainText = plain ? decodePart(plain) : null;
  if (plainText?.trim()) return normaliseText(plainText).slice(0, MAX_BODY_CHARS);
  const html = findPart(payload, "text/html");
  const htmlText = html ? decodePart(html) : null;
  return htmlText ? htmlToText(htmlText).slice(0, MAX_BODY_CHARS) : "";
}

// ---------------------------------------------------------------- message

export function gmailToEmail(msg: GmailMessage): EmailInput {
  const headers = msg.payload?.headers;
  const from = parseAddressList(header(headers, "From"))[0];
  const internal = Number(msg.internalDate);
  const dateHeader = Date.parse(header(headers, "Date") ?? "");
  const received = Number.isFinite(internal) && internal > 0 ? internal : dateHeader;
  return {
    id: msg.id,
    thread_id: msg.threadId,
    from_name: from?.name ?? null,
    from_email: from?.email ?? "",
    to: parseAddressList(header(headers, "To")).map((a) => a.email),
    cc: parseAddressList(header(headers, "Cc")).map((a) => a.email),
    subject: decodeEncodedWords(header(headers, "Subject") ?? "").trim(),
    body_text: extractBody(msg.payload),
    received_at: new Date(Number.isFinite(received) ? received : Date.now()).toISOString(),
    labels: msg.labelIds ?? [],
    list_unsubscribe: header(headers, "List-Unsubscribe") !== undefined,
  };
}
