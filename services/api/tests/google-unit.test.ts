import { randomBytes } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { parseTokenKey } from "../src/config.js";
import { GmailClient, GmailError, HistoryExpired } from "../src/google/gmail.js";
import {
  decodeEncodedWords,
  decodeEntities,
  extractBody,
  gmailToEmail,
  htmlToText,
  MAX_BODY_CHARS,
  parseAddressList,
} from "../src/google/mime.js";
import { GoogleOAuth, pkcePair, SCOPES } from "../src/google/oauth.js";
import { listQuery } from "../src/google/source.js";
import { TokenCipher } from "../src/lib/crypto.js";
import { FakeGoogle, gmailMessage } from "./fake-google.js";

describe("TokenCipher (AES-256-GCM)", () => {
  const cipher = new TokenCipher(randomBytes(32));

  it("round-trips, with a fresh IV every time", () => {
    const a = cipher.encrypt("1//refresh-token", "user-1");
    const b = cipher.encrypt("1//refresh-token", "user-1");
    expect(a.equals(b)).toBe(false);
    expect(a.includes(Buffer.from("refresh"))).toBe(false); // no plaintext at rest
    expect(cipher.decrypt(a, "user-1")).toBe("1//refresh-token");
  });

  it("rejects tampering, the wrong user and the wrong key", () => {
    const blob = cipher.encrypt("secret", "user-1");
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    expect(() => cipher.decrypt(tampered, "user-1")).toThrow();
    expect(() => cipher.decrypt(blob, "user-2")).toThrow(); // copied to another row
    expect(() => new TokenCipher(randomBytes(32)).decrypt(blob, "user-1")).toThrow();
    expect(() => cipher.decrypt(Buffer.alloc(10), "user-1")).toThrow("too short");
    expect(() => new TokenCipher(randomBytes(16))).toThrow();
  });

  it("parses TOKEN_ENC_KEY as hex or base64 and insists on 32 bytes", () => {
    const key = randomBytes(32);
    expect(parseTokenKey(key.toString("hex")).equals(key)).toBe(true);
    expect(parseTokenKey(key.toString("base64")).equals(key)).toBe(true);
    expect(() => parseTokenKey("too-short")).toThrow("32 bytes");
  });
});

describe("MIME parsing", () => {
  it("prefers text/plain in multipart/alternative", () => {
    const msg = gmailMessage({
      id: "m1",
      text: "Plain: please review.",
      html: "<p>HTML version</p>",
    });
    expect(extractBody(msg.payload)).toBe("Plain: please review.");
  });

  it("converts HTML-only mail to clean text (scripts, styles, entities, lists)", () => {
    const html =
      "<html><head><style>p{color:red}</style><title>t</title></head><body>" +
      "<script>steal()</script><p>Hi&nbsp;Sam,</p><p>Please pay &#8377;4,500 &amp; reply.</p>" +
      "<ul><li>One</li><li>Two</li></ul><!-- hidden --><div>Thanks&hellip;</div></body></html>";
    const text = extractBody(gmailMessage({ id: "m2", html }).payload);
    expect(text).toBe("Hi Sam,\n\nPlease pay ₹4,500 & reply.\n\n- One\n- Two\n\nThanks…");
    expect(text).not.toMatch(/steal|color|hidden|</);
  });

  it("ignores attachments and walks nested multiparts", () => {
    const msg = gmailMessage({
      id: "m3",
      text: "Body text.",
      html: "<b>Body</b>",
      attachment: true,
    });
    expect(msg.payload?.mimeType).toBe("multipart/mixed");
    expect(extractBody(msg.payload)).toBe("Body text.");
  });

  it("decodes the part's declared charset", () => {
    const payload = {
      mimeType: "text/plain",
      headers: [{ name: "Content-Type", value: 'text/plain; charset="ISO-8859-1"' }],
      body: { data: Buffer.from("Café meeting at 3", "latin1").toString("base64url") },
    };
    expect(extractBody(payload)).toBe("Café meeting at 3");
    const unknown = {
      ...payload,
      headers: [{ name: "Content-Type", value: "text/plain; charset=x-made-up" }],
    };
    expect(
      extractBody({ ...unknown, body: { data: Buffer.from("ok").toString("base64url") } }),
    ).toBe("ok");
  });

  it("caps very large bodies and handles empty ones", () => {
    const big = gmailMessage({ id: "m4", text: "word ".repeat(30_000) });
    expect(extractBody(big.payload).length).toBeLessThanOrEqual(MAX_BODY_CHARS);
    expect(extractBody(undefined)).toBe("");
    expect(extractBody({ mimeType: "text/plain", body: { attachmentId: "x" } })).toBe("");
  });

  it("parses address lists with quoted commas and encoded words", () => {
    expect(
      parseAddressList('"Shah, Priya" <Priya@Acme.example>, bob@x.example, <c@d.example>, nobody'),
    ).toEqual([
      { name: "Shah, Priya", email: "priya@acme.example" },
      { name: null, email: "bob@x.example" },
      { name: null, email: "c@d.example" },
    ]);
    expect(parseAddressList("=?UTF-8?B?UHJpecOp?= <p@x.example>")[0]?.name).toBe("Priyé");
    expect(parseAddressList(undefined)).toEqual([]);
  });

  it("decodes RFC 2047 subjects (B and Q) and leaves bad ones alone", () => {
    expect(decodeEncodedWords("=?UTF-8?B?SW52b2ljZSDigrk=?=")).toBe("Invoice ₹");
    expect(decodeEncodedWords("=?ISO-8859-1?Q?Caf=E9_today?=")).toBe("Café today");
    expect(decodeEncodedWords("=?UTF-8?Q?a?= =?UTF-8?Q?b?=")).toBe("ab");
    expect(decodeEncodedWords("plain subject")).toBe("plain subject");
    expect(decodeEntities("&#x1F600;&bogus;&#0;")).toBe("😀&bogus;&#0;");
    expect(htmlToText("a<br>b")).toBe("a\nb");
  });

  it("maps a Gmail message to the contract's EmailInput", () => {
    const msg = gmailMessage({
      id: "m5",
      threadId: "t5",
      from: '"Priya Shah" <PRIYA@acme.example>',
      to: "Sam <sam@gmail.example>, Ravi <ravi@acme.example>",
      subject: "=?UTF-8?B?RGVjayBmb3IgVHVlc2RheQ==?=",
      text: "Can you send the deck before Tuesday?",
      labels: ["INBOX", "IMPORTANT"],
      minutesAgo: 30,
      listUnsubscribe: true,
    });
    const email = gmailToEmail(msg);
    expect(email).toMatchObject({
      id: "m5",
      thread_id: "t5",
      from_name: "Priya Shah",
      from_email: "priya@acme.example",
      to: ["sam@gmail.example", "ravi@acme.example"],
      subject: "Deck for Tuesday",
      body_text: "Can you send the deck before Tuesday?",
      labels: ["INBOX", "IMPORTANT"],
      list_unsubscribe: true,
    });
    expect(Date.now() - Date.parse(email.received_at)).toBeLessThan(31 * 60_000);
    const bare = gmailToEmail({ id: "x", threadId: "y" });
    expect(bare).toMatchObject({ from_email: "", subject: "", body_text: "", labels: [] });
  });
});

describe("OAuth helpers", () => {
  it("builds a least-privilege, offline, PKCE authorization URL", () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier).toMatch(/^[\w-]{43}$/);
    const url = new URL(
      new GoogleOAuth({ clientId: "cid", clientSecret: "s", redirectUri: "http://cb" }).authUrl(
        "st",
        challenge,
      ),
    );
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "cid",
      redirect_uri: "http://cb",
      response_type: "code",
      scope: "openid email profile https://www.googleapis.com/auth/gmail.readonly",
      state: "st",
      code_challenge: challenge,
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
    });
    expect(SCOPES.some((s) => /gmail\.(send|modify|compose)|mail\.google\.com/.test(s))).toBe(
      false,
    );
  });

  it("surfaces Google error codes but never token values", async () => {
    const google = new FakeGoogle();
    const oauth = new GoogleOAuth(
      { clientId: "test-client-id", clientSecret: "test-client-secret", redirectUri: "x" },
      google.fetch,
    );
    const err = await oauth.refresh("1//not-a-real-token").catch((e: unknown) => e);
    expect(String(err)).toContain("invalid_grant");
    expect(String(err)).not.toContain("not-a-real-token");
    const badClient = new GoogleOAuth(
      { clientId: "wrong", clientSecret: "x", redirectUri: "x" },
      google.fetch,
    );
    await expect(badClient.refresh("t")).rejects.toThrow("invalid_client");
    await expect(oauth.userinfo("expired")).rejects.toThrow("userinfo returned 401");
  });

  it("uses the inbox query with promotions and social excluded", () => {
    expect(listQuery(14)).toBe("newer_than:14d in:inbox -category:promotions -category:social");
  });
});

describe("GmailClient", () => {
  function setup() {
    const google = new FakeGoogle();
    let token = google.issueAccess();
    const tokens = {
      get: vi.fn(async () => token),
      invalidate: vi.fn(async () => {
        token = google.issueAccess(); // what a refresh would do
      }),
    };
    const sleeps: number[] = [];
    const client = new GmailClient(tokens, {
      fetchImpl: google.fetch,
      backoffBaseMs: 10,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    return { google, client, tokens, sleeps };
  }

  it("lists across pages and fetches messages", async () => {
    const { google, client } = setup();
    for (let i = 0; i < 150; i++) google.addMessage({ id: `m${i}`, text: "hi" });
    const ids = await client.listMessageIds("in:inbox", 120);
    expect(ids).toHaveLength(120);
    expect(google.calls.filter((c) => c.includes("/messages?"))).toHaveLength(2);
    expect((await client.message("m3")).id).toBe("m3");
  });

  it("backs off exponentially on 429/5xx and honours Retry-After", async () => {
    const { google, client, sleeps } = setup();
    google.addMessage({ id: "m1", text: "hi" });
    google.failNext(/messages\/m1/, 503, 2);
    google.failNext(/messages\/m1/, 429, 1, { "retry-after": "2" });
    expect((await client.message("m1")).id).toBe("m1");
    expect(sleeps).toHaveLength(3);
    expect(sleeps[0]).toBeGreaterThanOrEqual(10);
    expect(sleeps[1]).toBeGreaterThanOrEqual(20);
    expect(sleeps[2]).toBe(2000);
  });

  it("retries 403 rate-limit reasons but not other 403s, and gives up eventually", async () => {
    const { google, client } = setup();
    google.addMessage({ id: "m1", text: "hi" });
    google.failNext(
      /messages\/m1/,
      403,
      1,
      {},
      '{"error":{"errors":[{"reason":"userRateLimitExceeded"}]}}',
    );
    expect((await client.message("m1")).id).toBe("m1");
    google.failNext(
      /messages\/m1/,
      403,
      1,
      {},
      '{"error":{"errors":[{"reason":"insufficientPermissions"}]}}',
    );
    await expect(client.message("m1")).rejects.toMatchObject({ status: 403 });
    google.failNext(/messages\/m1/, 500, 10);
    await expect(client.message("m1")).rejects.toBeInstanceOf(GmailError);
  });

  it("refreshes the access token once on 401", async () => {
    const { google, client, tokens } = setup();
    google.addMessage({ id: "m1", text: "hi" });
    await client.message("m1");
    google.expireAccessTokens();
    expect((await client.message("m1")).id).toBe("m1");
    expect(tokens.invalidate).toHaveBeenCalledTimes(1);
  });

  it("reports an expired history id so the caller can do a full listing", async () => {
    const { google, client } = setup();
    google.addMessage({ id: "m1", text: "hi" });
    const start = String(google.historyId);
    google.addMessage({ id: "m2", text: "new" });
    expect(await client.addedSince(start, 50)).toEqual(["m2"]);
    google.historyFloor = 10_000;
    await expect(client.addedSince(start, 50)).rejects.toBeInstanceOf(HistoryExpired);
  });

  it("treats network failures as retryable, then fails", async () => {
    const down = vi.fn<typeof fetch>(() => Promise.reject(new TypeError("fetch failed")));
    const client = new GmailClient(
      { get: async () => "t", invalidate: async () => undefined },
      { fetchImpl: down, maxAttempts: 2, sleep: async () => undefined },
    );
    await expect(client.profile()).rejects.toThrow("Gmail API unreachable");
    expect(down).toHaveBeenCalledTimes(2);
  });
});
