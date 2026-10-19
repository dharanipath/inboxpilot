import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { TokenCipher } from "../src/lib/crypto.js";
import {
  login,
  makeTestApp,
  resetState,
  syncAndWait,
  type TestApp,
  waitForRun,
} from "./helpers.js";

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

const GROQ_KEY = "gsk_test_groq_key_7a1f";

interface ProviderRow {
  name: string;
  configured: boolean;
  available: boolean;
  key_source: string;
  key_hint: string | null;
  circuit_reason: string | null;
  cooldown_s: number;
  label: string;
}
/** Save a key and wait for the re-read it starts, so a test's own sync doesn't race it. */
async function saveKey(cookie: string, name: string, apiKey: string) {
  const res = await t.http
    .put(`/api/llm/keys/${name}`)
    .set("cookie", cookie)
    .send({ api_key: apiKey })
    .expect(200);
  if (res.body.resync) await waitForRun(t, res.body.resync as string);
  t.agent.reset();
  return res;
}

const row = (body: { providers: ProviderRow[] }, name: string) =>
  body.providers.find((p) => p.name === name);

describe("users' own LLM API keys", () => {
  it("tests the key, stores it encrypted, and only ever shows a hint", async () => {
    const { cookie, userId } = await login(t);
    const res = await t.http
      .put("/api/llm/keys/groq")
      .set("cookie", cookie)
      .send({ api_key: `  ${GROQ_KEY}  ` })
      .expect(200);
    expect(res.body).toMatchObject({ saved: true, test: "ok", resync: expect.any(String) });
    expect(t.agent.testCalls).toEqual([{ name: "groq", api_key: GROQ_KEY }]);
    expect(row(res.body, "groq")).toMatchObject({
      configured: true,
      available: true,
      key_source: "user",
      key_hint: "••••7a1f",
      label: "Groq",
    });
    expect(JSON.stringify(res.body)).not.toContain(GROQ_KEY);

    const { prisma } = t.container.deps;
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(stored.llmKeysEnc).not.toBeNull();
    expect(Buffer.from(stored.llmKeysEnc ?? []).toString("utf8")).not.toContain(GROQ_KEY);
    const audit = await prisma.auditLog.findMany({ where: { userId } });
    expect(audit.map((a) => a.action)).toContain("llm_key_saved");
    expect(JSON.stringify(audit.map((a) => a.meta))).not.toContain(GROQ_KEY);

    const list = await t.http.get("/api/providers").set("cookie", cookie).expect(200);
    expect(row(list.body, "groq")?.key_source).toBe("user");
    expect(JSON.stringify(list.body)).not.toContain(GROQ_KEY);
  });

  it("a working key re-reads recent mail with it and rewrites the briefing", async () => {
    const { cookie, userId } = await login(t);
    await syncAndWait(t, cookie); // first read: no key yet
    expect(t.agent.extractCalls.every((c) => !c.options?.provider_keys)).toBe(true);
    await t.http.get("/api/briefing").set("cookie", cookie).expect(200);
    const briefingsBefore = t.agent.briefingCalls.length;

    const res = await t.http
      .put("/api/llm/keys/groq")
      .set("cookie", cookie)
      .send({ api_key: GROQ_KEY })
      .expect(200);
    const runId = res.body.resync as string;
    expect(await waitForRun(t, runId)).toBe("succeeded");
    const run = await t.container.deps.prisma.syncRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.userId).toBe(userId);
    expect(run.stats).toMatchObject({ reprocess: true });
    // every email was sent again, this time with the user's key
    const reread = t.agent.extractCalls.filter((c) => c.options?.provider_keys?.groq === GROQ_KEY);
    expect(reread.length).toBeGreaterThan(0);
    // and the briefing is written again (not served from the rules-era cache)
    await t.http.get("/api/briefing").set("cookie", cookie).expect(200);
    expect(t.agent.briefingCalls.length).toBeGreaterThan(briefingsBefore);
    expect(t.agent.briefingCalls.at(-1)?.options?.provider_keys).toEqual({ groq: GROQ_KEY });
  });

  it("an out-of-quota key, or rules-only mode, does not trigger a re-read", async () => {
    const { cookie } = await login(t);
    const limited = await t.http
      .put("/api/llm/keys/groq")
      .set("cookie", cookie)
      .send({ api_key: "limited-key-123456" })
      .expect(200);
    expect(limited.body.resync).toBeNull();
    await t.http.put("/api/llm/model").set("cookie", cookie).send({ model: "heuristic" });
    const rules = await t.http
      .put("/api/llm/keys/gemini")
      .set("cookie", cookie)
      .send({ api_key: "gm-good-key-123456" })
      .expect(200);
    expect(rules.body.resync).toBeNull();
  });

  it("refuses a rejected key, and does not save one it could not check", async () => {
    const { cookie, userId } = await login(t);
    const bad = await t.http
      .put("/api/llm/keys/gemini")
      .set("cookie", cookie)
      .send({ api_key: "bad-key-123456" })
      .expect(422);
    expect(bad.body).toMatchObject({ title: "Key rejected" });
    expect(bad.body.detail).toMatch(/Google Gemini did not accept this key/);
    const failed = await t.http
      .put("/api/llm/keys/gemini")
      .set("cookie", cookie)
      .send({ api_key: "down-key-123456" })
      .expect(502);
    // the real reason, not "could not be reached"
    expect(failed.body.detail).toBe(
      "Google Gemini answered with HTTP 404 NOT_FOUND while checking the key, so it was not saved. The model may not be available to this key yet.",
    );
    const slow = await t.http
      .put("/api/llm/keys/gemini")
      .set("cookie", cookie)
      .send({ api_key: "slow-key-123456" })
      .expect(502);
    expect(slow.body.detail).toMatch(/did not answer in time/);
    await t.http
      .put("/api/llm/keys/gemini")
      .set("cookie", cookie)
      .send({ api_key: "has spaces in it" })
      .expect(400);
    await t.http
      .put("/api/llm/keys/ollama")
      .set("cookie", cookie)
      .send({ api_key: "whatever-123" })
      .expect(400);
    const stored = await t.container.deps.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(stored.llmKeysEnc).toBeNull();
    await t.http.put("/api/llm/keys/groq").send({ api_key: GROQ_KEY }).expect(401);
  });

  it("a valid key that is out of free quota is saved, and its cooldown is reported", async () => {
    const { cookie } = await login(t);
    const res = await t.http
      .put("/api/llm/keys/groq")
      .set("cookie", cookie)
      .send({ api_key: "limited-key-123456" })
      .expect(200);
    expect(res.body).toMatchObject({ saved: true, test: "rate_limited", retry_after_s: 42 });
    expect(row(res.body, "groq")).toMatchObject({
      configured: true,
      available: false,
      circuit_reason: "rate_limited",
      cooldown_s: 42,
    });
  });

  it("every agent call for the user carries their keys; other users' calls never do", async () => {
    const mine = await login(t);
    const other = await login(t);
    await saveKey(mine.cookie, "groq", GROQ_KEY);

    await syncAndWait(t, mine.cookie, { reprocess: true });
    expect(t.agent.extractCalls.length).toBeGreaterThan(0);
    expect(t.agent.extractCalls.every((c) => c.options?.provider_keys?.groq === GROQ_KEY)).toBe(
      true,
    );
    expect(t.agent.briefingCalls.at(-1)?.options?.provider_keys).toEqual({ groq: GROQ_KEY });
    await t.http
      .post("/api/ask")
      .set("cookie", mine.cookie)
      .send({ question: "What is due?" })
      .expect(200);
    expect(t.agent.askCalls.at(-1)?.options?.provider_keys).toEqual({ groq: GROQ_KEY });

    t.agent.reset();
    await syncAndWait(t, other.cookie);
    expect(t.agent.extractCalls.length).toBeGreaterThan(0);
    expect(t.agent.extractCalls.every((c) => !c.options?.provider_keys)).toBe(true);
  });

  it("picks a model: one provider then rules, rules only, or automatic", async () => {
    const { cookie, userId } = await login(t);
    const noKey = await t.http
      .put("/api/llm/model")
      .set("cookie", cookie)
      .send({ model: "gemini" })
      .expect(409);
    expect(noKey.body.detail).toMatch(/Google Gemini needs an API key/);

    await saveKey(cookie, "groq", GROQ_KEY);
    const picked = await t.http
      .put("/api/llm/model")
      .set("cookie", cookie)
      .send({ model: "groq" })
      .expect(200);
    expect(picked.body.mode).toBe("groq");
    // a working model re-reads recent mail with it
    expect(picked.body.resync).toEqual(expect.any(String));
    expect(await waitForRun(t, picked.body.resync as string)).toBe("succeeded");
    expect(t.agent.extractCalls.at(-1)?.options?.providers).toEqual(["groq", "heuristic"]);
    t.agent.reset();
    const user = () => t.container.deps.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect((await user()).llmProviders).toEqual(["groq", "heuristic"]);
    await syncAndWait(t, cookie, { reprocess: true });
    expect(t.agent.extractCalls[0]?.options?.providers).toEqual(["groq", "heuristic"]);

    const rules = await t.http
      .put("/api/llm/model")
      .set("cookie", cookie)
      .send({ model: "heuristic" })
      .expect(200);
    expect(rules.body.resync).toBeNull(); // rules only: nothing to re-read with
    expect((await user()).llmProviders).toEqual(["heuristic"]);
    const auto = await t.http
      .put("/api/llm/model")
      .set("cookie", cookie)
      .send({ model: "auto" })
      .expect(200);
    expect(auto.body.mode).toBe("auto");
    expect((await user()).llmProviders).toEqual([]);
    await t.http.put("/api/llm/model").set("cookie", cookie).send({ model: "skynet" }).expect(400);
  });

  it("the daily briefing is written by the selected model, and rewritten when it changes", async () => {
    const { cookie } = await login(t);
    await saveKey(cookie, "groq", GROQ_KEY);
    const briefingOptions = () => t.agent.briefingCalls.at(-1)?.options;

    const first = await t.http
      .put("/api/llm/model")
      .set("cookie", cookie)
      .send({ model: "groq" })
      .expect(200);
    if (first.body.resync) await waitForRun(t, first.body.resync as string);
    await t.http.get("/api/briefing").set("cookie", cookie).expect(200);
    // the agent is told which model to write it with (it used to start at the server's default)
    expect(briefingOptions()?.providers).toEqual(["groq", "heuristic"]);

    // a cached briefing is served as-is...
    const calls = t.agent.briefingCalls.length;
    await t.http.get("/api/briefing").set("cookie", cookie).expect(200);
    expect(t.agent.briefingCalls.length).toBe(calls);

    // ...until the model changes: the next briefing is written again, by the new selection
    await t.http
      .put("/api/llm/model")
      .set("cookie", cookie)
      .send({ model: "heuristic" })
      .expect(200);
    await t.http.get("/api/briefing").set("cookie", cookie).expect(200);
    expect(t.agent.briefingCalls.length).toBeGreaterThan(calls);
    expect(briefingOptions()?.providers).toEqual(["heuristic"]);

    // the assistant follows the same selection
    await t.http
      .post("/api/ask")
      .set("cookie", cookie)
      .send({ question: "What is due?" })
      .expect(200);
    expect(t.agent.askCalls.at(-1)?.options?.providers).toEqual(["heuristic"]);
  });

  it("a removed provider (old selection or saved key) never reaches the agent or breaks a sync", async () => {
    const { cookie, userId } = await login(t);
    const { prisma, config } = t.container.deps;
    const cipher = new TokenCipher(config.tokenKey ?? Buffer.alloc(32));
    await prisma.user.update({
      where: { id: userId },
      data: {
        llmProviders: ["hf", "heuristic"], // chosen back when Hugging Face was supported
        llmKeysEnc: cipher.encrypt(
          JSON.stringify({ hf: "hf_old_0000000000", groq: GROQ_KEY }),
          `llm-keys:${userId}`,
        ),
      },
    });

    // not left on a model that no longer exists: back to automatic
    const providers = await t.http.get("/api/providers").set("cookie", cookie).expect(200);
    expect(providers.body.mode).toBe("auto");

    await syncAndWait(t, cookie);
    const options = t.agent.extractCalls[0]?.options;
    expect(options?.providers).toBeUndefined();
    expect(options?.provider_keys).toEqual({ groq: GROQ_KEY }); // the stale key is dropped
  });

  it("removing the selected model's key falls back to automatic", async () => {
    const { cookie, userId } = await login(t);
    await t.http
      .put("/api/llm/keys/groq")
      .set("cookie", cookie)
      .send({ api_key: GROQ_KEY })
      .expect(200);
    await t.http.put("/api/llm/model").set("cookie", cookie).send({ model: "groq" }).expect(200);
    const res = await t.http.delete("/api/llm/keys/groq").set("cookie", cookie).expect(200);
    expect(res.body.mode).toBe("auto");
    expect(row(res.body, "groq")).toMatchObject({ configured: false, key_hint: null });
    const stored = await t.container.deps.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(stored.llmKeysEnc).toBeNull(); // no keys left: no blob kept
    expect(stored.llmProviders).toEqual([]);
  });

  it("a key blob copied onto another user's row cannot be decrypted", async () => {
    const a = await login(t);
    const b = await login(t);
    await t.http
      .put("/api/llm/keys/groq")
      .set("cookie", a.cookie)
      .send({ api_key: GROQ_KEY })
      .expect(200);
    const { prisma } = t.container.deps;
    const blob = (await prisma.user.findUniqueOrThrow({ where: { id: a.userId } })).llmKeysEnc;
    await prisma.user.update({ where: { id: b.userId }, data: { llmKeysEnc: blob } });
    const res = await t.http.get("/api/providers").set("cookie", b.cookie).expect(200);
    expect(row(res.body, "groq")?.configured).toBe(false);
  });
});

describe("without TOKEN_ENC_KEY", () => {
  it("cannot store keys, and says how to fix it", async () => {
    const t2 = await makeTestApp({ config: { tokenKey: null } });
    try {
      const { cookie } = await login(t2);
      const res = await t2.http
        .put("/api/llm/keys/groq")
        .set("cookie", cookie)
        .send({ api_key: GROQ_KEY })
        .expect(503);
      expect(res.body.detail).toMatch(/TOKEN_ENC_KEY/);
      const list = await t2.http.get("/api/providers").set("cookie", cookie).expect(200);
      expect(list.body.keys_enabled).toBe(false);
    } finally {
      await t2.close();
    }
  });
});
