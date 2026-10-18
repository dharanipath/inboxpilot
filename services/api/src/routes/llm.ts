import type { User } from "@prisma/client";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import type { RouteContext } from "../app.js";
import type { ProviderStatus } from "../agent/types.js";
import { HttpProblem } from "../lib/problem.js";
import {
  isKeyed,
  KEYED_PROVIDERS,
  keyHint,
  PROVIDER_LABEL,
  type ProviderKeys,
  selection,
} from "../llm/keys.js";
import { agentUnavailable } from "./assistant.js";

/** A next step for errors a free tier commonly gives. */
function hint(name: string, why: string): string {
  if (/NO_CREDIT/.test(why)) {
    return "This provider's API is paid and the account has no credit: add credit in its billing page.";
  }
  if (/MODEL_RETIRED/.test(why)) {
    return "This model is closed to new keys; set a newer one (e.g. GEMINI_MODEL=gemini-flash-lite-latest).";
  }
  if (/NOT_FOUND|404/.test(why)) return "The model may not be available to this key yet.";
  if (/FAILED_PRECONDITION|location/i.test(why) && name === "gemini") {
    return "Google may not offer the free Gemini API in your region for this account.";
  }
  if (/5\d\d/.test(why)) return "The provider is having trouble; please try again in a minute.";
  return "Please check the key and try again.";
}

/** "auto" = every model with a key, in order; a name = that model, then the rules reader. */
export type ModelMode = string; // "auto" | "heuristic" | a provider name

export function modeOf(saved: string[]): ModelMode {
  const order = selection(saved);
  if (order.length === 1 && order[0] === "heuristic") return "heuristic";
  if (order.length === 2 && order[1] === "heuristic" && order[0] !== "heuristic") {
    return order[0] ?? "auto";
  }
  return "auto";
}

export function orderFor(mode: ModelMode): string[] {
  if (mode === "auto") return [];
  if (mode === "heuristic") return ["heuristic"];
  return [mode, "heuristic"];
}

const KeyBody = z
  .object({
    api_key: z
      .string()
      .trim()
      .min(8, "That key looks too short.")
      .max(512)
      .regex(/^\S+$/, "An API key has no spaces."),
  })
  .strict();
const ModelBody = z.object({ model: z.string().min(1).max(40) }).strict();
const NameParam = z.object({ name: z.enum(KEYED_PROVIDERS) });

interface ProviderView extends ProviderStatus {
  label: string;
  keyable: boolean;
  key_hint: string | null;
}

export const llmRoutes =
  (ctx: RouteContext): FastifyPluginAsync =>
  async (app) => {
    async function view(user: User, keys: ProviderKeys, requestId: string) {
      const status = await ctx.agent
        .providers(Object.keys(keys).length ? { provider_keys: keys } : {}, requestId)
        .catch(agentUnavailable);
      const providers: ProviderView[] = status.providers.map((p) => {
        const own = isKeyed(p.name) ? keys[p.name] : undefined;
        return {
          ...p,
          // another user's error text never reaches this user; ours is summarised by the reason
          last_error: p.key_source === "user" ? null : (p.last_error ?? null),
          label: PROVIDER_LABEL[p.name] ?? p.name,
          keyable: isKeyed(p.name),
          key_hint: own ? keyHint(own) : null,
        };
      });
      return { mode: modeOf(user.llmProviders), keys_enabled: ctx.llmKeys.enabled, providers };
    }

    /** Every model, as this user sees it: which have a key (theirs or the server's), which are
     *  cooling down and why (free limit used up, key rejected), and the selected mode. */
    app.get("/api/providers", async (req) => {
      const user = await ctx.currentUser(req);
      return view(user, await ctx.llmKeys.get(user.id), req.id);
    });

    /** Pick the model: "auto", "heuristic" (rules only) or one provider. */
    app.put("/api/llm/model", async (req) => {
      const user = await ctx.currentUser(req);
      const { model } = ModelBody.parse(req.body);
      const keys = await ctx.llmKeys.get(user.id);
      let ready = false;
      if (model !== "auto") {
        const current = await view(user, keys, req.id);
        const p = current.providers.find((x) => x.name === model);
        ready = Boolean(p?.available) && model !== "heuristic";
        if (!p) throw new HttpProblem(400, "Unknown model", `There is no model called "${model}".`);
        if (!p.configured) {
          throw new HttpProblem(
            409,
            "Add a key first",
            `${p.label} needs an API key. Add your free key in Settings \u2192 AI models.`,
          );
        }
      }
      const updated = await ctx.prisma.user.update({
        where: { id: user.id },
        data: { llmProviders: orderFor(model) },
      });
      await ctx.briefing.invalidate(updated);
      // picking a specific, working model re-reads recent mail with it (user edits are kept),
      // so the tasks on screen come from the model the user chose, not only new mail
      let resync: string | null = null;
      if (ready && model !== modeOf(user.llmProviders)) {
        resync = await ctx.sync
          .start(user.id, { days: 14, reprocess: true, trigger: "manual" }, req.id)
          .then((r) => r.runId)
          .catch(() => null); // a sync is running: the next one uses the new model
      }
      return { ...(await view(updated, keys, req.id)), resync };
    });

    /** Save the user's own key, after one tiny test call to the provider. */
    app.put(
      "/api/llm/keys/:name",
      { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
      async (req, reply) => {
        const user = await ctx.currentUser(req);
        const { name } = NameParam.parse(req.params);
        const { api_key } = KeyBody.parse(req.body);
        if (!ctx.llmKeys.enabled) {
          throw new HttpProblem(
            503,
            "Keys can't be saved",
            "Set TOKEN_ENC_KEY on the server to store API keys encrypted.",
          );
        }
        const label = PROVIDER_LABEL[name] ?? name;
        const probe = await ctx.agent
          .testProvider({ name, api_key }, req.id)
          .catch(agentUnavailable);
        if (probe.outcome === "auth") {
          throw new HttpProblem(
            422,
            "Key rejected",
            `${label} did not accept this key. Check that you copied all of it, and that it is still active.`,
          );
        }
        if (probe.outcome === "timeout") {
          throw new HttpProblem(
            502,
            "Couldn't check the key",
            `${label} did not answer in time, so the key was not saved. Please try again.`,
          );
        }
        if (probe.outcome === "error") {
          // the agent's message is built from status codes only, never from key or prompt text
          const why = probe.message?.replace(/^[a-z]+: /, "") ?? "an error";
          throw new HttpProblem(
            502,
            "Couldn't check the key",
            `${label} answered with ${why} while checking the key, so it was not saved. ${hint(name, why)}`,
          );
        }
        await ctx.llmKeys.set(user.id, name, api_key);
        await ctx.prisma.auditLog.create({
          data: { userId: user.id, action: "llm_key_saved", meta: { provider: name } },
        });
        // the briefing was written without this model: write it again with the new key
        await ctx.briefing.invalidate(user);
        // a working key: re-read the recent mail with it, so tasks the rules reader made are
        // upgraded now rather than only for new mail (user edits are kept, see SyncService)
        let resync: string | null = null;
        if (probe.outcome === "ok" && modeOf(user.llmProviders) !== "heuristic") {
          resync = await ctx.sync
            .start(user.id, { days: 14, reprocess: true, trigger: "manual" }, req.id)
            .then((r) => r.runId)
            .catch(() => null); // a sync is already running: the next one will use the key
        }
        reply.code(200);
        return {
          saved: true,
          test: probe.outcome, // ok, rate_limited (valid but out of free quota) or invalid (odd reply)
          retry_after_s: probe.retry_after_s ?? null,
          resync,
          ...(await view(user, await ctx.llmKeys.get(user.id), req.id)),
        };
      },
    );

    app.delete("/api/llm/keys/:name", async (req) => {
      const user = await ctx.currentUser(req);
      const { name } = NameParam.parse(req.params);
      await ctx.llmKeys.remove(user.id, name);
      await ctx.briefing.invalidate(user);
      let current = user;
      if (modeOf(user.llmProviders) === name) {
        // the selected model just lost its key: fall back to automatic choice
        current = await ctx.prisma.user.update({
          where: { id: user.id },
          data: { llmProviders: [] },
        });
      }
      await ctx.prisma.auditLog.create({
        data: { userId: user.id, action: "llm_key_removed", meta: { provider: name } },
      });
      return view(current, await ctx.llmKeys.get(user.id), req.id);
    });
  };
