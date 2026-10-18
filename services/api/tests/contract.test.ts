import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { AgentError, HttpAgentClient } from "../src/agent/client.js";
import {
  ContractValidator,
  ContractViolation,
  defaultContractsDir,
} from "../src/agent/contract.js";
import type { ExtractRequest, ExtractResponse } from "../src/agent/types.js";
import { fixtureInbox } from "./fixtures/inbox.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(resolve(defaultContractsDir(), "fixtures", name), "utf-8"));
const requestFixture = (): ExtractRequest => fixture("extract.request.json") as ExtractRequest;
const responseFixture = (): ExtractResponse => fixture("extract.response.json") as ExtractResponse;

const validator = new ContractValidator();

describe("shared contract fixtures (packages/contracts)", () => {
  it("the request and response fixtures validate with Ajv", () => {
    expect(validator.errors("ExtractRequest", requestFixture())).toEqual([]);
    expect(validator.errors("ExtractResponse", responseFixture())).toEqual([]);
  });

  it("what the gateway sends for the fixture inbox is a valid ExtractRequest", () => {
    const req: ExtractRequest = {
      user: {
        email: "a@b.co",
        name: null,
        timezone: "Asia/Kolkata",
        now: new Date().toISOString(),
        vip_senders: [],
      },
      emails: fixtureInbox(new Date(), "Asia/Kolkata"),
      options: { horizon_days: 7, use_llm_briefing: false, providers: ["groq"] },
    };
    expect(validator.errors("ExtractRequest", req)).toEqual([]);
  });

  it("rejects drift: unknown fields, bad enums, missing fields", () => {
    const res = responseFixture();
    const task = res.tasks[0];
    if (!task) throw new Error("fixture has no task");
    expect(validator.errors("ExtractResponse", { ...res, extra: 1 })).not.toEqual([]);
    expect(
      validator.errors("ExtractResponse", { ...res, tasks: [{ ...task, priority: "P9" }] }),
    ).not.toEqual([]);
    const noEvidence: Partial<typeof task> = { ...task };
    delete noEvidence.evidence;
    expect(validator.errors("ExtractResponse", { ...res, tasks: [noEvidence] })).not.toEqual([]);
    expect(() => validator.assert("Briefing", {})).toThrow(ContractViolation);
  });
});

function mockFetch(status: number, body: unknown) {
  return vi.fn<typeof fetch>(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}

function client(fetchImpl: typeof fetch) {
  return new HttpAgentClient({
    baseUrl: "http://agent",
    internalKey: "k3y-secret",
    timeoutMs: 1000,
    validator,
    fetchImpl,
  });
}

describe("HttpAgentClient", () => {
  it("sends the internal key and request id, and validates the response", async () => {
    const f = mockFetch(200, responseFixture());
    const res = await client(f).extract(requestFixture(), "req-7");
    expect(res.tasks).toHaveLength(1);
    const [url, init] = f.mock.calls[0] ?? [];
    expect(url).toBe("http://agent/v1/extract");
    expect(init?.headers).toMatchObject({
      "x-internal-key": "k3y-secret",
      "x-request-id": "req-7",
    });
  });

  it("refuses a response that breaks the contract", async () => {
    const bad = { ...responseFixture(), tasks: [{ id: "x" }] };
    await expect(client(mockFetch(200, bad)).extract(requestFixture())).rejects.toBeInstanceOf(
      ContractViolation,
    );
  });

  it("maps HTTP errors to AgentError without leaking the request", async () => {
    const err = await client(mockFetch(422, { title: "Request validation failed" }))
      .extract(requestFixture())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).status).toBe(422);
    expect((err as AgentError).message).toBe(
      "agent POST /v1/extract failed: 422 Request validation failed",
    );
    expect((err as AgentError).message).not.toContain("deck");
  });

  it("reports unreachable and timed-out agents", async () => {
    const down = vi.fn<typeof fetch>(() => Promise.reject(new TypeError("fetch failed")));
    await expect(client(down).providers()).rejects.toThrow(
      "agent unreachable (POST /v1/providers)",
    );
    const slow = vi.fn<typeof fetch>(() =>
      Promise.reject(Object.assign(new Error("t"), { name: "TimeoutError" })),
    );
    await expect(client(slow).providers()).rejects.toThrow("agent timed out");
    expect(await client(down).health()).toBe(false);
    expect(await client(mockFetch(200, { status: "ok" })).health()).toBe(true);
  });

  it("handles non-JSON error bodies", async () => {
    const f = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response("oops", { status: 503, statusText: "Unavailable" })),
    );
    await expect(
      client(f).ask({
        user: { email: "a@b.co", timezone: "UTC", now: new Date().toISOString() },
        question: "q",
        tasks: [],
      }),
    ).rejects.toThrow("503 Unavailable");
  });
});
