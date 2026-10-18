import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { login, makeTestApp, resetState, type TestApp } from "./helpers.js";

let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp();
});
beforeEach(async () => {
  await resetState(t);
});
afterAll(async () => {
  await t.close();
});

describe("sessions", () => {
  it("there is no way in except Google: the old demo sign-up route is gone", async () => {
    await t.http.post("/api/auth/demo").send({}).expect(404);
  });

  it("rejects requests without a valid session as problem+json", async () => {
    const res = await t.http.get("/api/me").set("x-request-id", "req-42").expect(401);
    expect(res.headers["content-type"]).toMatch(/application\/problem\+json/);
    expect(res.headers["x-request-id"]).toBe("req-42");
    expect(res.body).toMatchObject({ status: 401, title: "Unauthorized", traceId: "req-42" });

    await t.http.get("/api/me").set("cookie", "ip_session=not-a-jwt").expect(401);
  });

  it("returns the current user, and logout revokes the session immediately", async () => {
    const { cookie, userId } = await login(t);
    const me = await t.http.get("/api/me").set("cookie", cookie).expect(200);
    expect(me.body).toMatchObject({
      id: userId,
      auth_mode: "google",
      auto_sync_interval_s: 120,
      gmail_connected: true,
    });

    await t.http.post("/api/auth/logout").set("cookie", cookie).expect(204);
    await t.http.get("/api/me").set("cookie", cookie).expect(401); // JWT still unexpired, but revoked
    await t.http.post("/api/auth/logout").expect(204); // idempotent
  });

  it("rejects a tampered token", async () => {
    const { cookie } = await login(t);
    const [name, token = ""] = cookie.split("=");
    const parts = token.split(".");
    const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString()) as Record<
      string,
      unknown
    >;
    payload.sub = "00000000-0000-0000-0000-000000000000";
    const forged = [
      parts[0],
      Buffer.from(JSON.stringify(payload)).toString("base64url"),
      parts[2],
    ].join(".");
    await t.http
      .get("/api/me")
      .set("cookie", `${name ?? ""}=${forged}`)
      .expect(401);
  });

  it("rejects cross-origin and non-JSON mutating requests (CSRF)", async () => {
    const { cookie } = await login(t);
    const patch = () => t.http.patch("/api/me/settings").set("cookie", cookie);
    await patch().set("origin", "https://evil.example").send({ timezone: "UTC" }).expect(403);
    await patch().set("origin", "http://localhost:5173").send({ timezone: "UTC" }).expect(200);
    await patch().set("content-type", "text/plain").send("hello").expect(415);
  });

  it("validates input without echoing it", async () => {
    const { cookie } = await login(t);
    const res = await t.http
      .patch("/api/me/settings")
      .set("cookie", cookie)
      .send({ timezone: "Mars/Base<script>" })
      .expect(400);
    expect(res.body.title).toBe("Invalid request");
    expect(JSON.stringify(res.body)).not.toContain("<script>");
  });

  it("rate-limits sign-in attempts", async () => {
    for (let i = 0; i < 20; i++) await t.http.get("/api/auth/google").expect(503);
    const res = await t.http.get("/api/auth/google").expect(429);
    expect(res.body).toMatchObject({ status: 429, title: "Too Many Requests" });
  });

  it("Google sign-in answers 503 with setup guidance when it is not configured", async () => {
    const res = await t.http.get("/api/auth/google").expect(503);
    expect(res.body).toMatchObject({ title: "Google sign-in not configured" });
    expect(res.body.detail).toMatch(/GOOGLE_CLIENT_ID/);
    await t.http.get("/api/auth/google/callback?code=x&state=y").expect(503);
  });

  it("serves security headers and a problem+json 404", async () => {
    const res = await t.http.get("/api/nope").expect(404);
    expect(res.headers["content-security-policy"]).toBeDefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.body.title).toBe("Not Found");
  });
});
