import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { ProvidersPage } from "@/api/types";
import { limitNotice, stateWords, waitLabel, writtenBy } from "@/lib/providers";
import { renderApp } from "@/test/render";
import { briefing, http, HttpResponse, providerStatus, providersPage, server } from "@/test/server";

const gemini = (over = {}) =>
  providerStatus({ name: "gemini", label: "Google Gemini", model: "gemini-2.5-flash", ...over });
const groq = (over = {}) =>
  providerStatus({ name: "groq", label: "Groq", model: "llama-3.3-70b-versatile", ...over });
const rules = providerStatus({
  name: "heuristic",
  label: "Rules only (no AI)",
  configured: true,
  available: true,
  keyable: false,
});
const ready = { configured: true, available: true, key_source: "user" as const };
const limited = (s: number) => ({
  configured: true,
  available: false,
  key_source: "user" as const,
  circuit: "open" as const,
  circuit_reason: "rate_limited" as const,
  cooldown_s: s,
});

describe("limit notices (what the user is told when a model is paused)", () => {
  it("the picked model ran out of free quota: say when it is back, and offer the others", () => {
    const page = providersPage([gemini(ready), groq(limited(120)), rules], "groq");
    const n = limitNotice(page);
    expect(n?.tone).toBe("warn");
    expect(n?.message).toBe(
      "Groq has used up its free limit for now. It should work again in about 2 min.",
    );
    expect(n?.fallback).toMatch(/rules reader, which is less accurate/);
    expect(n?.alternatives.map((p) => p.name)).toEqual(["gemini"]);
  });

  it("automatic mode: the first model is paused but another took over", () => {
    const n = limitNotice(providersPage([gemini(limited(45)), groq(ready), rules]));
    expect(n).toMatchObject({ tone: "info", fallback: "Using Groq meanwhile." });
    expect(n?.message).toMatch(/about 45 s/);
  });

  it("explains a rejected key and repeated errors differently", () => {
    const rejected = { ...limited(600), circuit_reason: "auth" as const };
    expect(limitNotice(providersPage([gemini(rejected), rules], "gemini"))?.message).toBe(
      "Google Gemini rejected its API key. Replace the key in the server's .env and restart.",
    );
    const failing = { ...limited(30), circuit_reason: "failures" as const };
    expect(limitNotice(providersPage([gemini(failing), rules], "gemini"))?.message).toMatch(
      /isn't responding/,
    );
  });

  it("a model that is out of credit says so and offers the models that work", () => {
    const gpt = providerStatus({
      name: "github",
      label: "OpenAI GPT (GitHub Models)",
      ...limited(580),
      circuit_reason: "no_credit",
    });
    const page = providersPage([gemini(ready), gpt, rules], "github");
    const n = limitNotice(page);
    expect(n?.tone).toBe("warn");
    expect(n?.message).toBe(
      "OpenAI GPT (GitHub Models) is out of credit, so it can't answer right now. Check its billing or usage page, or pick another model.",
    );
    expect(n?.fallback).toMatch(/rules reader/);
    expect(n?.alternatives.map((p) => p.name)).toEqual(["gemini"]);
    expect(stateWords(gpt)).toBe("out of credit");
  });

  it("stays quiet when nothing the user picked is paused", () => {
    expect(limitNotice(providersPage([gemini(ready), rules], "gemini"))).toBeNull();
    expect(limitNotice(providersPage([gemini(limited(30)), rules], "heuristic"))).toBeNull();
    expect(limitNotice(providersPage([gemini(), rules]))).toBeNull(); // no keys at all
  });

  it("describes each state in words", () => {
    expect(stateWords(gemini())).toBe("add a free key");
    expect(stateWords(gemini(ready))).toBe("ready · your key");
    expect(stateWords(groq(limited(3600)))).toBe("free limit reached · back in ~1 h");
    expect(stateWords(rules)).toBe("always on");
    expect([waitLabel(5), waitLabel(90), waitLabel(7200)]).toEqual(["5 s", "2 min", "2 h"]);
  });
});

/** A tiny stateful /api/providers + /api/llm/* backend. */
function backend(initial: ProvidersPage) {
  let page = initial;
  const calls: { method: string; path: string; body: unknown }[] = [];
  server.use(
    http.get("/api/providers", () => HttpResponse.json(page)),
    http.put("/api/llm/model", async ({ request }) => {
      const body = (await request.json()) as { model: string };
      calls.push({ method: "PUT", path: "/api/llm/model", body });
      page = { ...page, mode: body.model };
      return HttpResponse.json(page);
    }),
    http.put("/api/llm/keys/:name", async ({ request, params }) => {
      const body = (await request.json()) as { api_key: string };
      calls.push({ method: "PUT", path: `/api/llm/keys/${String(params.name)}`, body });
      if (body.api_key.startsWith("bad")) {
        return HttpResponse.json(
          { title: "Key rejected", detail: "Groq did not accept this key." },
          { status: 422 },
        );
      }
      page = {
        ...page,
        providers: page.providers.map((p) =>
          p.name === params.name
            ? { ...p, ...ready, key_hint: "••••" + body.api_key.slice(-4) }
            : p,
        ),
      };
      return HttpResponse.json({
        ...page,
        saved: true,
        test: "ok",
        retry_after_s: null,
        resync: "44444444-4444-4444-8444-444444444444",
      });
    }),
    http.delete("/api/llm/keys/:name", ({ params }) => {
      calls.push({ method: "DELETE", path: `/api/llm/keys/${String(params.name)}`, body: null });
      page = {
        ...page,
        providers: page.providers.map((p) =>
          p.name === params.name
            ? { ...p, configured: false, available: false, key_source: "none", key_hint: null }
            : p,
        ),
      };
      return HttpResponse.json(page);
    }),
  );
  return calls;
}

describe("daily briefing: written by the selected model", () => {
  it("names the model in plain words", () => {
    expect(writtenBy("github")).toBe("OpenAI GPT (GitHub Models)");
    expect(writtenBy("ollama")).toBe("Ollama (local Llama)");
    expect(writtenBy("gemini")).toBe("Google Gemini");
    expect(writtenBy("groq")).toBe("Groq");
    expect(writtenBy("template")).toBe("rules (no LLM)");
    expect(writtenBy("gateway-template")).toBe("rules (no LLM)");
    expect(writtenBy("cerebras")).toBe("cerebras");
  });

  it("switching the model rewrites the briefing, and it keeps saying who wrote it", async () => {
    const gpt = providerStatus({ name: "github", label: "OpenAI GPT (GitHub Models)", ...ready });
    backend(providersPage([gemini(ready), groq(), gpt, rules], "gemini"));
    let writer = "gemini";
    let fetched = 0;
    server.use(
      http.get("/api/briefing", () => {
        fetched += 1;
        return HttpResponse.json({ ...briefing, generated_by: writer });
      }),
      // the gateway rewrites the briefing for the new model when the choice changes
      http.put("/api/llm/model", async ({ request }) => {
        const { model } = (await request.json()) as { model: string };
        writer = model === "heuristic" ? "template" : model; // rules write a template briefing
        return HttpResponse.json({
          ...providersPage([gemini(ready), groq(), gpt, rules], model),
          resync: null,
        });
      }),
    );
    const u = userEvent.setup();
    renderApp("/app");
    expect(await screen.findByText("Written by Google Gemini")).toBeInTheDocument();

    await u.selectOptions(await screen.findByLabelText("AI model"), "github");
    // no reload: the card refetches and now credits the model that was picked
    expect(await screen.findByText("Written by OpenAI GPT (GitHub Models)")).toBeInTheDocument();
    expect(screen.queryByText("Written by Google Gemini")).not.toBeInTheDocument();
    expect(fetched).toBeGreaterThanOrEqual(2);

    await u.selectOptions(screen.getByLabelText("AI model"), "heuristic");
    expect(await screen.findByText("Written by rules (no LLM)")).toBeInTheDocument();
  });
});

describe("no AI key yet", () => {
  it("says the rules reader is in use and how to add a key", async () => {
    backend(providersPage([gemini(), groq(), rules]));
    renderApp("/app");
    const banner = await screen.findByTestId("no-ai-banner");
    expect(banner).toHaveTextContent(
      "No AI model is set up yet, so your mail is read by the rules reader.",
    );
    expect(banner).toHaveTextContent(/add a free key for Google Gemini, Groq or GitHub Models/);
    expect(within(banner).queryByRole("link")).not.toBeInTheDocument(); // no settings section to link to
    expect(
      within(screen.getByLabelText("AI model")).getByRole("option", { name: /^Choose a model/ }),
    ).toHaveTextContent("Choose a model (no AI key yet)");
  });

  it("is not shown once any model has a key, or when the user chose rules only", async () => {
    backend(providersPage([gemini(ready), rules]));
    renderApp("/app");
    await screen.findByLabelText("AI model");
    expect(screen.queryByTestId("no-ai-banner")).not.toBeInTheDocument();
  });
});

describe("picking a model", () => {
  it("offers only the free models (Gemini, Groq, GPT, Ollama) and Rules only", async () => {
    const gpt = providerStatus({ name: "github", label: "OpenAI GPT (GitHub Models)", ...ready });
    const ollama = providerStatus({
      name: "ollama",
      label: "Ollama (local Llama)",
      keyable: false,
    });
    const cerebras = providerStatus({ name: "cerebras", label: "Cerebras", ...ready });
    const calls = backend(providersPage([cerebras, gemini(), groq(ready), gpt, ollama, rules]));
    const u = userEvent.setup();
    renderApp("/app");
    const picker = await screen.findByLabelText("AI model");
    const option = (name: RegExp) => within(picker).getByRole("option", { name });
    // the older "automatic" setting asks for a choice; other providers are not offered
    expect(
      within(picker)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual([
      "Choose a model",
      "Google Gemini — add a free key",
      "Groq — ready · your key",
      "OpenAI GPT (GitHub Models) — ready · your key",
      "Ollama (local Llama) — not set up",
      "Rules only (no AI)",
    ]);
    expect(picker).toHaveAttribute("title", expect.stringMatching(/AI model that reads your mail/));
    expect(option(/Google Gemini — add a free key/)).toBeDisabled();
    expect(option(/Groq — ready · your key/)).toBeEnabled();
    expect(option(/Rules only \(no AI\)/)).toBeEnabled();

    await u.selectOptions(picker, "groq");
    await waitFor(() =>
      expect(calls).toEqual([{ method: "PUT", path: "/api/llm/model", body: { model: "groq" } }]),
    );
    expect(await screen.findByText("Groq will read your new mail")).toBeInTheDocument();
    expect(picker).toHaveValue("groq");
  });

  it("when the picked model hits its free limit, the dashboard says so and offers a switch", async () => {
    const calls = backend(providersPage([gemini(ready), groq(limited(120)), rules], "groq"));
    const u = userEvent.setup();
    renderApp("/app");
    const banner = await screen.findByTestId("limit-banner");
    expect(banner).toHaveAttribute("role", "alert");
    expect(banner).toHaveTextContent(
      "Groq has used up its free limit for now. It should work again in about 2 min.",
    );
    expect(banner).toHaveTextContent(/rules reader/);

    await u.selectOptions(within(banner).getByLabelText("Use another model"), "gemini");
    await waitFor(() => expect(calls.at(-1)?.body).toEqual({ model: "gemini" }));
    await waitFor(() => expect(screen.queryByTestId("limit-banner")).not.toBeInTheDocument());
  });
});
