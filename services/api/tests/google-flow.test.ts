import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { TokenCipher } from "../src/lib/crypto.js";
import { CLIENT_ID, CLIENT_SECRET, FakeGoogle, REDIRECT_URI } from "./fake-google.js";
import { makeTestApp, resetState, syncAndWait, type TestApp } from "./helpers.js";

const KEY = randomBytes(32);
const WEB = "http://localhost:5173";
let google: FakeGoogle;
let t: TestApp;

beforeAll(async () => {
  google = new FakeGoogle();
  t = await makeTestApp({
    config: {
      google: {
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        redirectUri: REDIRECT_URI,
        tokenKey: KEY,
      },
      webAppUrl: WEB,
      gmailBackoffBaseMs: 1,
    },
    // indirection so each test can swap in a fresh fake
    googleFetch: (input, init) => google.fetch(input, init),
  });
});
beforeEach(async () => {
  await resetState(t);
  google = new FakeGoogle();
});
afterAll(async () => {
  await t.close();
});

const cookiesOf = (res: { headers: Record<string, unknown> }): Record<string, string> =>
  Object.fromEntries(
    ((res.headers["set-cookie"] as string[] | undefined) ?? []).map((c) => {
      const [pair = ""] = c.split(";");
      const i = pair.indexOf("=");
      return [pair.slice(0, i), pair.slice(i + 1)];
    }),
  );

/** Start sign-in, "consent" at the fake Google, and follow the callback. */
async function signIn(
  opts: Parameters<FakeGoogle["authorize"]>[1] & {
    tz?: string;
    dropCookie?: boolean;
    /** the "remember this browser" cookie from an earlier sign-in */
    device?: string;
  } = {},
) {
  const start = await t.http
    .get(`/api/auth/google${opts.tz ? `?tz=${opts.tz}` : ""}`)
    .set("cookie", opts.device ? `ip_device=${opts.device}` : "")
    .expect(302);
  const authUrl = String(start.headers.location);
  const oauthCookie = cookiesOf(start).ip_oauth ?? "";
  const query = google.authorize(authUrl, opts);
  const cb = await t.http
    .get(`/api/auth/google/callback?${query}`)
    .set("cookie", opts.dropCookie ? "" : `ip_oauth=${oauthCookie}`)
    .expect(302);
  const session = cookiesOf(cb).ip_session;
  return {
    callback: cb,
    device: cookiesOf(cb).ip_device,
    authUrl,
    start,
    query,
    oauthCookie,
    location: String(cb.headers.location),
    cookie: session ? `ip_session=${session}` : "",
  };
}

describe("Google sign-in (Authorization Code + PKCE)", () => {
  it("redirects to Google with state, PKCE and a browser-binding cookie", async () => {
    const res = await t.http.get("/api/auth/google?tz=Europe/Berlin").expect(302);
    const url = new URL(String(res.headers.location));
    const state = url.searchParams.get("state") ?? "";
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    const raw = (res.headers["set-cookie"] as unknown as string[]).join(";");
    expect(raw).toMatch(new RegExp(`ip_oauth=${state}`));
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/Path=\/api\/auth\/google/);

    const stored = JSON.parse(
      (await t.container.deps.redis.get(`oauth:${state}`)) ?? "{}",
    ) as Record<string, unknown>;
    expect(stored).toMatchObject({ tz: "Europe/Berlin" });
    expect(String(stored.verifier)).toMatch(/^[\w-]{43}$/);
    const ttl = await t.container.deps.redis.ttl(`oauth:${state}`);
    expect(ttl).toBeGreaterThan(590);
    expect(ttl).toBeLessThanOrEqual(600);
  });

  it("signs in, stores the refresh token encrypted and caches the access token", async () => {
    const { location, cookie, authUrl } = await signIn({ tz: "Europe/Berlin" });
    expect(location).toBe(`${WEB}/`);
    const me = await t.http.get("/api/me").set("cookie", cookie).expect(200);
    expect(me.body).toMatchObject({
      auth_mode: "google",
      email: "sam@gmail.example",
      name: "Sam Rao",
      timezone: "Europe/Berlin",
    });

    const { prisma, redis } = t.container.deps;
    const user = await prisma.user.findUniqueOrThrow({ where: { email: "sam@gmail.example" } });
    const [refresh] = google.liveRefreshTokens();
    expect(refresh).toBeDefined();
    const blob = Buffer.from(user.refreshTokenEnc ?? new Uint8Array());
    expect(blob.includes(Buffer.from(refresh ?? "x"))).toBe(false); // ciphertext only
    expect(new TokenCipher(KEY).decrypt(blob, user.id)).toBe(refresh);

    const cached = (await redis.get(`gtoken:${user.id}`)) ?? "";
    expect(cached).not.toMatch(/^ya29\./);
    const state = new URL(authUrl).searchParams.get("state") ?? "";
    expect(await redis.exists(`oauth:${state}`)).toBe(0); // one-time
    expect(await prisma.auditLog.count({ where: { userId: user.id, action: "login" } })).toBe(1);
  });

  it("rejects a replayed callback, a missing browser cookie and unknown state", async () => {
    const first = await signIn();
    expect(first.location).toBe(`${WEB}/`);
    const replay = await t.http
      .get(`/api/auth/google/callback?${first.query}`)
      .set("cookie", `ip_oauth=${first.oauthCookie}`)
      .expect(302);
    expect(replay.headers.location).toBe(`${WEB}/?auth_error=invalid_state`);

    const csrf = await signIn({ dropCookie: true }); // attacker-supplied callback URL
    expect(csrf.location).toBe(`${WEB}/?auth_error=invalid_state`);
    expect(csrf.cookie).toBe("");

    const bogus = await t.http.get("/api/auth/google/callback?code=x&state=nope").expect(302);
    expect(bogus.headers.location).toBe(`${WEB}/?auth_error=invalid_state`);
    const empty = await t.http.get("/api/auth/google/callback").expect(302);
    expect(empty.headers.location).toBe(`${WEB}/?auth_error=invalid_request`);
  });

  it.each([
    [{ deny: true }, "access_denied"],
    [{ scopes: ["openid", "email"] }, "insufficient_scope"],
  ] as const)("handles %o -> %s without creating a user", async (opts, code) => {
    const { location } = await signIn(opts);
    expect(location).toBe(`${WEB}/?auth_error=${code}`);
    expect(await t.container.deps.prisma.user.count()).toBe(0);
  });

  it("refuses unverified emails and a missing refresh token for new users", async () => {
    google.profile.email_verified = false;
    expect((await signIn()).location).toBe(`${WEB}/?auth_error=email_not_verified`);
    google.profile.email_verified = true;
    expect((await signIn({ withRefresh: false })).location).toBe(
      `${WEB}/?auth_error=no_refresh_token`,
    );
    expect(await t.container.deps.prisma.user.count()).toBe(0);
  });

  it("fails safely when the PKCE verifier does not match", async () => {
    const start = await t.http.get("/api/auth/google").expect(302);
    const state = new URL(String(start.headers.location)).searchParams.get("state") ?? "";
    const query = google.authorize(String(start.headers.location));
    await t.container.deps.redis.set(
      `oauth:${state}`,
      JSON.stringify({ verifier: "x".repeat(43), tz: null }),
    );
    const cb = await t.http
      .get(`/api/auth/google/callback?${query}`)
      .set("cookie", `ip_oauth=${state}`)
      .expect(302);
    expect(cb.headers.location).toBe(`${WEB}/?auth_error=oauth_failed`);
  });

  it("a returning user keeps their account; a missing refresh token reuses the stored one", async () => {
    const a = await signIn();
    const idA = (await t.http.get("/api/me").set("cookie", a.cookie)).body.id as string;
    const b = await signIn({ withRefresh: false });
    expect(b.location).toBe(`${WEB}/`);
    const idB = (await t.http.get("/api/me").set("cookie", b.cookie)).body.id as string;
    expect(idB).toBe(idA);
    expect(await t.container.deps.prisma.user.count()).toBe(1);
  });
});

describe("returning users: one click", () => {
  const params = (authUrl: string) => new URL(authUrl).searchParams;
  const userIdOf = async (cookie: string) =>
    (await t.http.get("/api/me").set("cookie", cookie)).body.id as string;

  it("a Google sign-in remembers this browser with a secret, httpOnly cookie", async () => {
    const first = await signIn();
    expect(params(first.authUrl).get("prompt")).toBe("consent");
    const raw = (first.callback.headers["set-cookie"] as unknown as string[]).find((c) =>
      c.startsWith("ip_device="),
    );
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/Path=\/api\/auth;/);
    expect(raw).toMatch(/Max-Age=15552000/); // 180 days
    const [deviceId, secret] = (first.device ?? "").split(".");
    const row = await t.container.deps.prisma.rememberedDevice.findUniqueOrThrow({
      where: { id: deviceId },
    });
    expect(row.userId).toBe(await userIdOf(first.cookie));
    expect(row.secretHash).not.toContain(secret ?? "x"); // only a hash is stored
  });

  it("after logout, 'Continue as …' signs in with one request: no Google at all", async () => {
    const first = await signIn();
    await syncAndWait(t, first.cookie);
    const userId = await userIdOf(first.cookie);
    await t.http.post("/api/auth/logout").set("cookie", first.cookie).send({}).expect(204);
    google.addMessage({ id: "new-1", subject: "Contract", text: "Please sign by Friday." });
    const googleCallsBefore = google.calls.filter((c) => c.includes("oauth2")).length;

    const who = await t.http
      .get("/api/auth/remembered")
      .set("cookie", `ip_device=${first.device ?? ""}`)
      .expect(200);
    expect(who.body).toEqual({
      email: "sam@gmail.example",
      name: "Sam Rao",
      gmail_connected: true,
    });

    const resumed = await t.http
      .post("/api/auth/resume")
      .set("cookie", `ip_device=${first.device ?? ""}`)
      .send({})
      .expect(200);
    expect(resumed.body).toMatchObject({ email: "sam@gmail.example", gmail_connected: true });
    const session = cookiesOf(resumed).ip_session ?? "";
    expect(await userIdOf(`ip_session=${session}`)).toBe(userId);
    expect(google.calls.filter((c) => c.includes("oauth2")).length).toBe(googleCallsBefore);

    // the cookie is rotated: the old value no longer works
    const rotated = cookiesOf(resumed).ip_device ?? "";
    expect(rotated).not.toBe(first.device);
    await t.http
      .post("/api/auth/resume")
      .set("cookie", `ip_device=${first.device ?? ""}`)
      .send({})
      .expect(401);

    // and new mail is read straight away
    const { prisma } = t.container.deps;
    for (
      let i = 0;
      i < 200 &&
      !(await prisma.email.findFirst({ where: { gmailId: "new-1", status: { not: "pending" } } }));
      i++
    ) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(await prisma.email.findFirst({ where: { gmailId: "new-1" } })).toMatchObject({
      status: expect.stringMatching(/processed|skipped/),
    });
  });

  it("when Gmail access has ended, resume says to reconnect with Google", async () => {
    const first = await signIn();
    await t.container.deps.prisma.user.update({
      where: { id: await userIdOf(first.cookie) },
      data: { refreshTokenEnc: null },
    });
    const who = await t.http
      .get("/api/auth/remembered")
      .set("cookie", `ip_device=${first.device ?? ""}`)
      .expect(200);
    expect(who.body.gmail_connected).toBe(false);
    const res = await t.http
      .post("/api/auth/resume")
      .set("cookie", `ip_device=${first.device ?? ""}`)
      .send({})
      .expect(409);
    expect(res.body.title).toBe("Reconnect Gmail");
    // the Google flow for this browser asks for consent, with the account pre-selected
    const again = await signIn({ device: first.device ?? "" });
    expect(params(again.authUrl).get("prompt")).toBe("consent");
    expect(params(again.authUrl).get("login_hint")).toBe("sam@gmail.example");
  });

  it("'forget this browser' and logout {forget:true} remove the shortcut", async () => {
    const a = await signIn();
    await t.http
      .post("/api/auth/logout")
      .set("cookie", `${a.cookie}; ip_device=${a.device ?? ""}`)
      .send({ forget: true })
      .expect(204);
    await t.http
      .get("/api/auth/remembered")
      .set("cookie", `ip_device=${a.device ?? ""}`)
      .expect(204);

    const b = await signIn();
    const forget = await t.http
      .post("/api/auth/forget")
      .set("cookie", `ip_device=${b.device ?? ""}`)
      .expect(204);
    expect((forget.headers["set-cookie"] as unknown as string[]).join(";")).toMatch(/ip_device=;/);
    await t.http
      .post("/api/auth/resume")
      .set("cookie", `ip_device=${b.device ?? ""}`)
      .send({})
      .expect(401);
    expect(await t.container.deps.prisma.rememberedDevice.count()).toBe(0);
  });

  it("rejects forged, malformed and expired device cookies", async () => {
    const a = await signIn();
    const [id] = (a.device ?? "").split(".");
    for (const bogus of [
      `${id}.${"A".repeat(43)}`, // right device, wrong secret
      "not-a-cookie",
      `00000000-0000-4000-8000-000000000000.${"B".repeat(43)}`,
    ]) {
      await t.http
        .post("/api/auth/resume")
        .set("cookie", `ip_device=${bogus}`)
        .send({})
        .expect(401);
    }
    await t.container.deps.prisma.rememberedDevice.update({
      where: { id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await t.http
      .post("/api/auth/resume")
      .set("cookie", `ip_device=${a.device ?? ""}`)
      .send({})
      .expect(401);
  });

  it("a different account on a remembered browser gets one automatic consent retry", async () => {
    const first = await signIn();
    google.profile = { ...google.profile, sub: "g-other", email: "other@gmail.example" };
    const other = await signIn({ device: first.device ?? "", withRefresh: false });
    expect(other.location).toBe("/api/auth/google?consent=1");
  });
});

describe("Gmail sync", () => {
  function seedInbox() {
    google.addMessage({
      id: "g1",
      subject: "Deck",
      text: "Can you send the deck by Friday?",
      minutesAgo: 120,
    });
    google.addMessage({
      id: "g2",
      subject: "Invoice",
      html: "<p>Your invoice of &#8377;4,500 is due on the 20th.</p><script>x()</script>",
      from: "Billing <billing@cloudhost.example>",
      minutesAgo: 90,
    });
    google.addMessage({
      id: "g3",
      subject: "Sale!",
      text: "50% off",
      labels: ["INBOX", "CATEGORY_PROMOTIONS"],
    });
    google.addMessage({ id: "g4", subject: "Old", text: "Ancient mail", minutesAgo: 20 * 24 * 60 });
    google.addMessage({
      id: "g5",
      subject: "Notes",
      text: "Please read the notes.",
      attachment: true,
    });
  }

  it("lists recent inbox mail, parses it and stores the history checkpoint", async () => {
    seedInbox();
    const { cookie } = await signIn();
    const checkpoint = String(google.historyId);
    const { status, runId } = await syncAndWait(t, cookie);
    expect(status).toBe("succeeded");

    expect(google.lastQuery).toBe("newer_than:14d in:inbox -category:promotions -category:social");
    const sent = t.agent.extractCalls.flatMap((c) => c.emails);
    expect(sent.map((e) => e.id).sort()).toEqual(["g1", "g2", "g5"]);
    const invoice = sent.find((e) => e.id === "g2");
    expect(invoice).toMatchObject({
      from_name: "Billing",
      from_email: "billing@cloudhost.example",
    });
    expect(invoice?.body_text).toBe("Your invoice of ₹4,500 is due on the 20th.");
    expect(sent.find((e) => e.id === "g5")?.body_text).not.toContain("ATTACHMENT");

    const user = await t.container.deps.prisma.user.findUniqueOrThrow({
      where: { email: "sam@gmail.example" },
    });
    expect(user.gmailHistoryId).toBe(checkpoint);
    const run = await t.http.get(`/api/sync/${runId}`).set("cookie", cookie).expect(200);
    expect(run.body.stats).toMatchObject({ mode: "full", fetched: 3 });

    const tasks = await t.http.get("/api/tasks").set("cookie", cookie).expect(200);
    const deck = (tasks.body.items as { email_id: string; gmail_url: string | null }[]).find(
      (i) => i.email_id === "g1",
    );
    expect(deck?.gmail_url).toBe("https://mail.google.com/mail/u/0/#inbox/thr-g1");
  });

  it("then syncs incrementally from the history id, fetching only new mail", async () => {
    seedInbox();
    const { cookie } = await signIn();
    await syncAndWait(t, cookie);
    const calls = t.agent.extractCalls.length;

    google.addMessage({ id: "g6", subject: "New", text: "Please confirm the venue by tomorrow." });
    google.addMessage({
      id: "g7",
      subject: "Promo",
      text: "Buy",
      labels: ["INBOX", "CATEGORY_SOCIAL"],
    });
    google.calls = [];
    const { runId } = await syncAndWait(t, cookie);

    expect(google.calls.some((c) => c.includes("/history?startHistoryId="))).toBe(true);
    expect(google.calls.some((c) => c.includes("/messages?"))).toBe(false); // no full listing
    const fresh = t.agent.extractCalls.slice(calls).flatMap((c) => c.emails.map((e) => e.id));
    expect(fresh).toEqual(["g6"]); // social mail dropped before the agent
    const run = await t.http.get(`/api/sync/${runId}`).set("cookie", cookie).expect(200);
    expect(run.body.stats).toMatchObject({ mode: "incremental" });
    const user = await t.container.deps.prisma.user.findUniqueOrThrow({
      where: { email: "sam@gmail.example" },
    });
    expect(user.gmailHistoryId).toBe(String(google.historyId));
  });

  it("falls back to a full listing when the history id has expired, and for reprocess", async () => {
    seedInbox();
    const { cookie } = await signIn();
    await syncAndWait(t, cookie);
    google.historyFloor = Number.MAX_SAFE_INTEGER;
    google.calls = [];
    expect((await syncAndWait(t, cookie)).status).toBe("succeeded");
    expect(google.calls.some((c) => c.includes("/messages?"))).toBe(true);

    google.calls = [];
    await syncAndWait(t, cookie, { reprocess: true });
    expect(google.calls.some((c) => c.includes("/history?"))).toBe(false);
  });

  it("survives Gmail rate limits and an expired access token", async () => {
    seedInbox();
    const { cookie } = await signIn();
    google.failNext(/messages\/g1/, 429, 2);
    google.failNext(/\/messages\?/, 503, 1);
    google.expireAccessTokens();
    google.calls = [];
    expect((await syncAndWait(t, cookie)).status).toBe("succeeded");
    expect(google.calls.filter((c) => c.includes("oauth2.googleapis.com/token"))).toHaveLength(1);
    expect(google.calls.filter((c) => c.includes("messages/g1"))).toHaveLength(3);
  });

  it("asks the user to reconnect when Google access was revoked", async () => {
    seedInbox();
    const { cookie } = await signIn();
    google.revokeAll();
    await t.container.deps.redis.del(
      `gtoken:${(await t.http.get("/api/me").set("cookie", cookie)).body.id as string}`,
    );
    const { status, runId } = await syncAndWait(t, cookie);
    expect(status).toBe("failed");
    const run = await t.http.get(`/api/sync/${runId}`).set("cookie", cookie).expect(200);
    expect(run.body.error).toMatch(/Sign in with Google again/);
    const user = await t.container.deps.prisma.user.findUniqueOrThrow({
      where: { email: "sam@gmail.example" },
    });
    expect(user.refreshTokenEnc).toBeNull();
    // the web app learns it must offer "Reconnect Gmail"
    const me = await t.http.get("/api/me").set("cookie", cookie).expect(200);
    expect(me.body.gmail_connected).toBe(false);

    // reconnecting (the same Google account) restores access on the same account
    const again = await signIn();
    const after = await t.http.get("/api/me").set("cookie", again.cookie).expect(200);
    expect(after.body).toMatchObject({ id: me.body.id, gmail_connected: true });
  });

  it("reports persistent Gmail failures on the run", async () => {
    seedInbox();
    const { cookie } = await signIn();
    google.failNext(/\/profile/, 500, 10);
    const { status, runId } = await syncAndWait(t, cookie);
    expect(status).toBe("failed");
    const run = await t.http.get(`/api/sync/${runId}`).set("cookie", cookie).expect(200);
    expect(run.body.error).toBe("Gmail API error 500");
  });
});

describe("disconnect", () => {
  it("DELETE /api/me revokes the token at Google and deletes everything", async () => {
    seedOne();
    const { cookie } = await signIn();
    await syncAndWait(t, cookie);
    const [refresh] = google.liveRefreshTokens();
    const id = (await t.http.get("/api/me").set("cookie", cookie)).body.id as string;

    const del = await t.http.delete("/api/me").set("cookie", cookie).expect(204);
    // this browser forgets the account too
    expect((del.headers["set-cookie"] as unknown as string[]).join(";")).toMatch(
      /ip_device=;.*Path=\/api\/auth/,
    );
    expect(google.revoked).toEqual([refresh]);
    expect(google.liveRefreshTokens()).toEqual([]);
    const { prisma, redis } = t.container.deps;
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.task.count()).toBe(0);
    expect(await redis.exists(`gtoken:${id}`)).toBe(0);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { userId: id, action: "delete_account" },
    });
    expect(audit.meta).toMatchObject({ mode: "google", google_revoked: true });
  });

  it("still deletes the account if Google is unreachable", async () => {
    seedOne();
    const { cookie } = await signIn();
    google.failNext(/\/revoke/, 503, 5);
    await t.http.delete("/api/me").set("cookie", cookie).expect(204);
    expect(await t.container.deps.prisma.user.count()).toBe(0);
  });

  function seedOne() {
    google.addMessage({ id: "g1", subject: "Deck", text: "Can you send the deck by Friday?" });
  }
});
