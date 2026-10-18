import type { User } from "@prisma/client";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import type { RouteContext } from "../app.js";
import { SESSION_COOKIE } from "../auth/session.js";
import { isValidTimeZone } from "../lib/time.js";
import { DEVICE_COOKIE, DEVICE_PATH } from "../auth/devices.js";

export const KNOWN_PROVIDERS = [
  "gemini",
  "groq",
  "cerebras",
  "openrouter",
  "mistral",
  "github",
  "hf",
  "ollama",
  "openai",
  "heuristic",
] as const;

const VIP = /^(@[a-z0-9.-]+\.[a-z]{2,}|[^@\s]+@[a-z0-9.-]+\.[a-z]{2,})$/;

const SettingsBody = z
  .object({
    timezone: z.string().refine(isValidTimeZone, "unknown IANA timezone").optional(),
    vip_senders: z
      .array(z.string().trim().toLowerCase().regex(VIP, "must be an email or @domain"))
      .max(50)
      .optional(),
    llm_providers: z.array(z.enum(KNOWN_PROVIDERS)).max(KNOWN_PROVIDERS.length).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, "nothing to update");

export function userJson(u: User) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    auth_mode: u.authMode,
    timezone: u.timezone,
    vip_senders: u.vipSenders,
    llm_providers: u.llmProviders,
    last_sync_at: u.lastSyncAt?.toISOString() ?? null,
    created_at: u.createdAt.toISOString(),
    // false once Google has expired or revoked access (invalid_grant): the user must reconnect
    gmail_connected: u.refreshTokenEnc !== null,
  };
}

export const meRoutes =
  (ctx: RouteContext): FastifyPluginAsync =>
  async (app) => {
    app.get("/api/me", async (req) => ({
      ...userJson(await ctx.currentUser(req)),
      auto_sync_interval_s: ctx.config.autoSyncIntervalS,
    }));

    app.patch("/api/me/settings", async (req) => {
      const user = await ctx.currentUser(req);
      const body = SettingsBody.parse(req.body);
      const updated = await ctx.prisma.user.update({
        where: { id: user.id },
        data: {
          ...(body.timezone ? { timezone: body.timezone } : {}),
          ...(body.vip_senders ? { vipSenders: [...new Set(body.vip_senders)] } : {}),
          ...(body.llm_providers ? { llmProviders: [...new Set(body.llm_providers)] } : {}),
        },
      });
      await ctx.briefing.invalidate(user);
      await ctx.briefing.invalidate(updated);
      return userJson(updated);
    });

    /** Disconnect = delete: every row cascades from users; the audit entry outlives it. */
    app.delete("/api/me", async (req, reply) => {
      const user = await ctx.currentUser(req);
      // revoke at Google first (best effort): disconnecting must also cut off our access
      const googleRevoked = ctx.google ? await ctx.google.tokens.revoke(user.id) : null;
      await ctx.prisma.$transaction([
        ctx.prisma.user.delete({ where: { id: user.id } }),
        ctx.prisma.auditLog.create({
          data: {
            userId: user.id,
            action: "delete_account",
            meta: { mode: user.authMode, google_revoked: googleRevoked },
          },
        }),
      ]);
      if (req.session) await ctx.sessions.revoke(req.session.jti);
      await ctx.briefing.invalidate(user);
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      reply.clearCookie(DEVICE_COOKIE, { path: DEVICE_PATH }); // rows went with the user
      return reply.status(204).send();
    });
  };
