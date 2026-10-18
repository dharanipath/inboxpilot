import type { GmailMessage } from "./mime.js";

export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

export class GmailError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** history.list returns 404 when startHistoryId is too old (roughly a week): do a full list. */
export class HistoryExpired extends Error {}

export interface TokenSource {
  get(): Promise<string>;
  invalidate(): Promise<void>;
}

export interface GmailOptions {
  fetchImpl?: typeof fetch;
  backoffBaseMs?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const RATE_LIMIT_REASONS = /rateLimitExceeded|userRateLimitExceeded|backendError/;

/** Minimal Gmail REST client: exponential back-off on 429/5xx, one token refresh on 401. */
export class GmailClient {
  private readonly fetchImpl: typeof fetch;
  private readonly base: number;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly tokens: TokenSource,
    opts: GmailOptions = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.base = opts.backoffBaseMs ?? 500;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async profile(): Promise<{ emailAddress: string; historyId: string }> {
    return this.get<{ emailAddress: string; historyId: string }>("/profile");
  }

  async listMessageIds(q: string, max: number): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        q,
        maxResults: String(Math.min(100, max - ids.length)),
      });
      if (pageToken) params.set("pageToken", pageToken);
      const page = await this.get<{ messages?: { id: string }[]; nextPageToken?: string }>(
        `/messages?${params.toString()}`,
      );
      ids.push(...(page.messages ?? []).map((m) => m.id));
      pageToken = page.nextPageToken;
    } while (pageToken && ids.length < max);
    return ids.slice(0, max);
  }

  /** Ids of INBOX messages added since `startHistoryId`. */
  async addedSince(startHistoryId: string, max: number): Promise<string[]> {
    const ids = new Set<string>();
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        startHistoryId,
        historyTypes: "messageAdded",
        labelId: "INBOX",
      });
      if (pageToken) params.set("pageToken", pageToken);
      let page: {
        history?: { messagesAdded?: { message: { id: string; labelIds?: string[] } }[] }[];
        nextPageToken?: string;
      };
      try {
        page = await this.get(`/history?${params.toString()}`);
      } catch (err) {
        if (err instanceof GmailError && err.status === 404) throw new HistoryExpired();
        throw err;
      }
      for (const h of page.history ?? []) {
        for (const added of h.messagesAdded ?? []) ids.add(added.message.id);
      }
      pageToken = page.nextPageToken;
    } while (pageToken && ids.size < max);
    return [...ids].slice(0, max);
  }

  async message(id: string): Promise<GmailMessage> {
    return this.get<GmailMessage>(`/messages/${encodeURIComponent(id)}?format=full`);
  }

  private async get<T>(path: string): Promise<T> {
    let refreshed = false;
    for (let attempt = 1; ; attempt++) {
      const token = await this.tokens.get();
      let res: Response;
      try {
        res = await this.fetchImpl(`${GMAIL_API}${path}`, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(20_000),
        });
      } catch {
        if (attempt >= this.maxAttempts) throw new GmailError(0, "Gmail API unreachable");
        await this.sleep(this.delay(attempt, null));
        continue;
      }
      if (res.ok) return (await res.json()) as T;

      if (res.status === 401 && !refreshed) {
        refreshed = true; // access token expired early or was revoked: refresh once
        await this.tokens.invalidate();
        continue;
      }
      const text = await res.text().catch(() => "");
      const retryable =
        RETRY_STATUS.has(res.status) || (res.status === 403 && RATE_LIMIT_REASONS.test(text));
      if (retryable && attempt < this.maxAttempts) {
        await this.sleep(this.delay(attempt, res.headers.get("retry-after")));
        continue;
      }
      throw new GmailError(res.status, `Gmail API error ${res.status}`);
    }
  }

  private delay(attempt: number, retryAfter: string | null): number {
    const header = Number(retryAfter);
    if (Number.isFinite(header) && header > 0) return Math.min(header, 30) * 1000;
    const exp = this.base * 2 ** (attempt - 1);
    return exp + Math.floor(Math.random() * this.base);
  }
}
