import { createHash, randomBytes } from "node:crypto";

import type { GmailMessage, GmailPart } from "../src/google/mime.js";

/**
 * In-process fake of Google OAuth + userinfo + revoke + the Gmail API, injected as `fetch`.
 * It enforces the real protocol rules we depend on: PKCE S256, one-time codes, redirect_uri
 * match, expiring access tokens (401), revocable refresh tokens (invalid_grant), history 404.
 */

export const CLIENT_ID = "test-client-id";
export const CLIENT_SECRET = "test-client-secret";
export const REDIRECT_URI = "http://localhost:4000/api/auth/google/callback";
export const ALL_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/gmail.readonly",
];

interface Profile {
  sub: string;
  email: string;
  email_verified: boolean;
  name: string;
}

interface Failure {
  match: RegExp;
  status: number;
  times: number;
  headers?: Record<string, string>;
  body?: string;
}

const formBody = (init?: RequestInit): string => (typeof init?.body === "string" ? init.body : "");

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const b64url = (s: string, charset: BufferEncoding = "utf8") =>
  Buffer.from(s, charset).toString("base64url");

export interface MessageSpec {
  id: string;
  threadId?: string;
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
  html?: string;
  labels?: string[];
  minutesAgo?: number;
  listUnsubscribe?: boolean;
  attachment?: boolean;
}

export function gmailMessage(spec: MessageSpec, now = Date.now()): GmailMessage {
  const headers = [
    { name: "From", value: spec.from ?? '"Priya Shah" <priya@acme.example>' },
    { name: "To", value: spec.to ?? "Sam <sam@gmail.example>" },
    { name: "Subject", value: spec.subject ?? `Message ${spec.id}` },
    { name: "Date", value: new Date(now - (spec.minutesAgo ?? 60) * 60_000).toUTCString() },
    ...(spec.listUnsubscribe
      ? [{ name: "List-Unsubscribe", value: "<mailto:unsub@x.example>" }]
      : []),
  ];
  const textPart: GmailPart | null = spec.text
    ? {
        mimeType: "text/plain",
        headers: [{ name: "Content-Type", value: 'text/plain; charset="UTF-8"' }],
        body: { data: b64url(spec.text) },
      }
    : null;
  const htmlPart: GmailPart | null = spec.html
    ? {
        mimeType: "text/html",
        headers: [{ name: "Content-Type", value: "text/html; charset=UTF-8" }],
        body: { data: b64url(spec.html) },
      }
    : null;
  const bodyParts = [textPart, htmlPart].filter((p): p is GmailPart => p !== null);
  let payload: GmailPart =
    bodyParts.length === 1 && bodyParts[0]
      ? { ...bodyParts[0], headers: [...headers, ...(bodyParts[0].headers ?? [])] }
      : { mimeType: "multipart/alternative", headers, parts: bodyParts, body: { size: 0 } };
  if (spec.attachment) {
    payload = {
      mimeType: "multipart/mixed",
      headers,
      body: { size: 0 },
      parts: [
        { ...payload, headers: payload.headers?.filter((h) => h.name.startsWith("Content")) ?? [] },
        {
          mimeType: "text/plain",
          filename: "notes.txt",
          headers: [{ name: "Content-Disposition", value: 'attachment; filename="notes.txt"' }],
          body: { data: b64url("ATTACHMENT TEXT must never be read"), size: 34 },
        },
      ],
    };
  }
  return {
    id: spec.id,
    threadId: spec.threadId ?? `thr-${spec.id}`,
    labelIds: spec.labels ?? ["INBOX", "UNREAD"],
    internalDate: String(now - (spec.minutesAgo ?? 60) * 60_000),
    payload,
  };
}

export class FakeGoogle {
  profile: Profile = {
    sub: "g-123",
    email: "sam@gmail.example",
    email_verified: true,
    name: "Sam Rao",
  };
  messages: GmailMessage[] = [];
  historyId = 1000;
  historyFloor = 0; // startHistoryId below this -> 404 (too old)
  private history: { id: number; message: GmailMessage }[] = [];
  private codes = new Map<string, { challenge: string; scopes: string[]; withRefresh: boolean }>();
  private access = new Map<string, number>(); // token -> expiresAt
  private refresh = new Map<string, boolean>(); // token -> revoked
  private failures: Failure[] = [];
  calls: string[] = [];
  revoked: string[] = [];
  redirectUri = REDIRECT_URI;
  lastQuery: string | null = null;

  /** Simulate the user consenting at Google; returns the callback query string. */
  authorize(
    authUrl: string,
    opts: { scopes?: readonly string[]; withRefresh?: boolean; deny?: boolean } = {},
  ): string {
    const u = new URL(authUrl);
    const state = u.searchParams.get("state") ?? "";
    if (opts.deny) return `error=access_denied&state=${encodeURIComponent(state)}`;
    const code = `code-${randomBytes(6).toString("hex")}`;
    this.codes.set(code, {
      challenge: u.searchParams.get("code_challenge") ?? "",
      scopes: [...(opts.scopes ?? ALL_SCOPES)],
      withRefresh: opts.withRefresh ?? true,
    });
    return `code=${code}&state=${encodeURIComponent(state)}&scope=x`;
  }

  addMessage(spec: MessageSpec): GmailMessage {
    const msg = gmailMessage(spec);
    this.messages.unshift(msg);
    this.historyId += 1;
    this.history.push({ id: this.historyId, message: msg });
    return msg;
  }

  failNext(
    match: RegExp,
    status: number,
    times = 1,
    headers?: Record<string, string>,
    body?: string,
  ): void {
    this.failures.push({
      match,
      status,
      times,
      ...(headers ? { headers } : {}),
      ...(body ? { body } : {}),
    });
  }

  expireAccessTokens(): void {
    for (const k of this.access.keys()) this.access.set(k, 0);
  }

  revokeAll(): void {
    for (const k of this.refresh.keys()) this.refresh.set(k, true);
    this.expireAccessTokens();
  }

  liveRefreshTokens(): string[] {
    return [...this.refresh.entries()].filter(([, revoked]) => !revoked).map(([t]) => t);
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const method = init?.method ?? "GET";
    this.calls.push(`${method} ${url.host}${url.pathname}${url.search}`);

    const failure = this.failures.find((f) => f.times > 0 && f.match.test(url.href));
    if (failure) {
      failure.times -= 1;
      return new Response(failure.body ?? "{}", {
        status: failure.status,
        headers: failure.headers ?? {},
      });
    }

    if (url.host === "oauth2.googleapis.com" && url.pathname === "/token") return this.token(init);
    if (url.host === "oauth2.googleapis.com" && url.pathname === "/revoke") {
      const token = new URLSearchParams(formBody(init)).get("token") ?? "";
      this.revoked.push(token);
      if (!this.refresh.has(token)) return json(400, { error: "invalid_token" });
      this.refresh.set(token, true);
      return json(200, {});
    }

    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const expires = this.access.get(auth.replace(/^Bearer /, ""));
    if (expires === undefined || expires < Date.now()) {
      return json(401, { error: { code: 401, message: "Invalid Credentials" } });
    }
    if (url.host === "openidconnect.googleapis.com") return json(200, this.profile);
    if (url.host === "gmail.googleapis.com") return this.gmail(url);
    return json(404, { error: "unknown fake endpoint" });
  };

  /** Mint a valid access token directly (for client-level tests). */
  issueAccess(): string {
    const t = `ya29.${randomBytes(8).toString("hex")}`;
    this.access.set(t, Date.now() + 3_600_000);
    return t;
  }

  private token(init?: RequestInit): Response {
    const p = new URLSearchParams(formBody(init));
    if (p.get("client_id") !== CLIENT_ID || p.get("client_secret") !== CLIENT_SECRET) {
      return json(401, { error: "invalid_client" });
    }
    if (p.get("grant_type") === "authorization_code") {
      const code = this.codes.get(p.get("code") ?? "");
      this.codes.delete(p.get("code") ?? ""); // one-time
      const verifier = p.get("code_verifier") ?? "";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      if (!code || challenge !== code.challenge || p.get("redirect_uri") !== this.redirectUri) {
        return json(400, { error: "invalid_grant" });
      }
      const refresh = code.withRefresh ? `1//refresh-${randomBytes(8).toString("hex")}` : undefined;
      if (refresh) this.refresh.set(refresh, false);
      return json(200, {
        access_token: this.issueAccess(),
        expires_in: 3599,
        scope: code.scopes.join(" "),
        token_type: "Bearer",
        ...(refresh ? { refresh_token: refresh } : {}),
      });
    }
    if (p.get("grant_type") === "refresh_token") {
      const revoked = this.refresh.get(p.get("refresh_token") ?? "");
      if (revoked !== false) return json(400, { error: "invalid_grant" });
      return json(200, {
        access_token: this.issueAccess(),
        expires_in: 3599,
        scope: ALL_SCOPES.join(" "),
      });
    }
    return json(400, { error: "unsupported_grant_type" });
  }

  private gmail(url: URL): Response {
    const path = url.pathname.replace("/gmail/v1/users/me", "");
    if (path === "/profile")
      return json(200, { emailAddress: this.profile.email, historyId: String(this.historyId) });
    if (path === "/messages") {
      const q = url.searchParams.get("q") ?? "";
      this.lastQuery = q;
      const days = Number(/newer_than:(\d+)d/.exec(q)?.[1] ?? "3650");
      const cutoff = Date.now() - days * 86_400_000;
      const hits = this.messages.filter((m) => {
        const labels = m.labelIds ?? [];
        if (q.includes("in:inbox") && !labels.includes("INBOX")) return false;
        if (q.includes("-category:promotions") && labels.includes("CATEGORY_PROMOTIONS"))
          return false;
        if (q.includes("-category:social") && labels.includes("CATEGORY_SOCIAL")) return false;
        return Number(m.internalDate) >= cutoff;
      });
      const size = Number(url.searchParams.get("maxResults") ?? "100");
      const offset = Number(url.searchParams.get("pageToken") ?? "0");
      const page = hits.slice(offset, offset + size);
      return json(200, {
        messages: page.map((m) => ({ id: m.id, threadId: m.threadId })),
        ...(offset + size < hits.length ? { nextPageToken: String(offset + size) } : {}),
        resultSizeEstimate: hits.length,
      });
    }
    if (path.startsWith("/messages/")) {
      const msg = this.messages.find(
        (m) => m.id === decodeURIComponent(path.slice("/messages/".length)),
      );
      return msg ? json(200, msg) : json(404, { error: { code: 404, message: "Not Found" } });
    }
    if (path === "/history") {
      const start = Number(url.searchParams.get("startHistoryId"));
      if (start < this.historyFloor)
        return json(404, { error: { code: 404, message: "Requested entity was not found." } });
      const records = this.history
        .filter((h) => h.id > start && (h.message.labelIds ?? []).includes("INBOX"))
        .map((h) => ({
          id: String(h.id),
          messagesAdded: [
            {
              message: {
                id: h.message.id,
                threadId: h.message.threadId,
                labelIds: h.message.labelIds,
              },
            },
          ],
        }));
      return json(200, { history: records, historyId: String(this.historyId) });
    }
    return json(404, { error: { code: 404, message: "Not Found" } });
  }
}
