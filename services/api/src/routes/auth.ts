import { randomBytes } from "node:crypto";

import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";

import type { RouteContext } from "../app.js";
import { DEVICE_COOKIE, DEVICE_PATH, DEVICE_TTL_S, Devices } from "../auth/devices.js";
import { SESSION_COOKIE } from "../auth/session.js";
import { GMAIL_READONLY, OAuthError, pkcePair } from "../google/oauth.js";
import { HttpProblem } from "../lib/problem.js";
import { isValidTimeZone } from "../lib/time.js";
import { userJson } from "./me.js";

const Tz = z.string().refine(isValidTimeZone, "unknown IANA timezone");
const StartQuery = z.object({ tz: Tz.optional(), consent: z.literal("1").optional() });
const CallbackQuery = z.object({
  code: z.string().max(2048).optional(),
  state: z.string().max(256).optional(),
  error: z.string().max(256).optional(),
});

const OAUTH_COOKIE = "ip_oauth";
const OAUTH_TTL_S = 600;
const LogoutBody = z.object({ forget: z.boolean().optional() }).strict();
const OAUTH_PATH = "/api/auth/google";
const oauthKey = (state: string) => `oauth:${state}`;
const RETRY_WITH_CONSENT = "retry_with_consent";

export const authRoutes =
  (ctx: RouteContext): FastifyPluginAsync =>
  async (app) => {
    const devices = new Devices(ctx.prisma);

    const setSession = async (reply: FastifyReply, userId: string) => {
      const { token, maxAge } = await ctx.sessions.issue(userId, "google");
      reply.setCookie(SESSION_COOKIE, token, {
        httpOnly: true,
        secure: ctx.config.cookieSecure,
        sameSite: "lax",
        path: "/",
        maxAge,
      });
    };
    const setDevice = (reply: FastifyReply, value: string) =>
      reply.setCookie(DEVICE_COOKIE, value, {
        httpOnly: true,
        secure: ctx.config.cookieSecure,
        sameSite: "lax",
        path: DEVICE_PATH,
        maxAge: DEVICE_TTL_S,
      });
    const clearDevice = (reply: FastifyReply) =>
      reply.clearCookie(DEVICE_COOKIE, { path: DEVICE_PATH });

    /** A returning user: read new mail now instead of waiting for the next background check. */
    const syncOnSignIn = async (userId: string, lastSyncAt: Date | null, requestId: string) => {
      if (!lastSyncAt) return; // a first sign-in is synced by the dashboard, with the live trace
      await ctx.sync
        .start(userId, { days: 14, reprocess: false, trigger: "auto" }, requestId)
        .catch(() => undefined); // already syncing
    };

    /** Normal logout keeps "remember this browser"; `{forget: true}` removes it too. */
    app.post("/api/auth/logout", async (req, reply) => {
      const { forget } = LogoutBody.parse(req.body ?? {});
      const session = await ctx.sessions.verify(req.cookies[SESSION_COOKIE]);
      if (session) {
        await ctx.sessions.revoke(session.jti);
        await ctx.prisma.auditLog.create({
          data: { userId: session.userId, action: "logout", meta: { forget: Boolean(forget) } },
        });
      }
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      if (forget) {
        await devices.forget(req.cookies[DEVICE_COOKIE]);
        clearDevice(reply);
      }
      return reply.status(204).send();
    });

    // ------------------------------------------------------------ one click for returning users

    /** Who this browser remembers (for "Continue as …"), or 204. Reveals only the account that
     *  signed in on this very browser. */
    app.get("/api/auth/remembered", async (req, reply) => {
      const found = await devices.find(req.cookies[DEVICE_COOKIE]);
      if (!found) return reply.status(204).send();
      return {
        email: found.user.email,
        name: found.user.name,
        gmail_connected: found.user.refreshTokenEnc !== null,
      };
    });

    /** "Continue as …": sign in on a remembered browser with no trip to Google. */
    app.post(
      "/api/auth/resume",
      { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
      async (req, reply) => {
        const found = await devices.find(req.cookies[DEVICE_COOKIE]);
        if (!found) {
          clearDevice(reply);
          throw new HttpProblem(401, "Not remembered", "Please sign in with Google.");
        }
        const { user } = found;
        if (!user.refreshTokenEnc) {
          // Gmail access ended: only Google can grant it again
          throw new HttpProblem(
            409,
            "Reconnect Gmail",
            "Google ended InboxPilot's access to your Gmail. Sign in with Google to reconnect.",
          );
        }
        setDevice(reply, await devices.rotate(found.id));
        await setSession(reply, user.id);
        await ctx.prisma.auditLog.create({
          data: { userId: user.id, action: "login", meta: { mode: "remembered_device" } },
        });
        await syncOnSignIn(user.id, user.lastSyncAt, req.id);
        return userJson(user);
      },
    );

    /** "Not you?": forget this browser without being signed in. */
    app.post("/api/auth/forget", async (req, reply) => {
      await devices.forget(req.cookies[DEVICE_COOKIE]);
      clearDevice(reply);
      return reply.status(204).send();
    });

    // ------------------------------------------------------------ Google OAuth (Code + PKCE)

    const google = () => {
      if (!ctx.google) {
        throw new HttpProblem(
          503,
          "Google sign-in not configured",
          "Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and TOKEN_ENC_KEY in .env.",
        );
      }
      return ctx.google;
    };

    /** Step 1: one-time state + PKCE verifier in Redis (10 min), bound to this browser by cookie. */
    app.get(
      OAUTH_PATH,
      { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
      async (req, reply) => {
        const { oauth } = google();
        const { tz, consent: forced } = StartQuery.parse(req.query);
        const state = randomBytes(32).toString("base64url");
        const { verifier, challenge } = pkcePair();

        // a remembered browser: pre-select the account, and skip the permission screen when we
        // already hold that account's Gmail token (Google remembers the grant)
        const known = (await devices.find(req.cookies[DEVICE_COOKIE]))?.user ?? null;
        const consent = Boolean(forced) || !known?.refreshTokenEnc;

        await ctx.redis.set(
          oauthKey(state),
          JSON.stringify({ verifier, tz: tz ?? null, consent }),
          "EX",
          OAUTH_TTL_S,
        );
        reply.setCookie(OAUTH_COOKIE, state, {
          httpOnly: true,
          secure: ctx.config.cookieSecure,
          sameSite: "lax", // sent on Google's top-level redirect back to us
          path: OAUTH_PATH,
          maxAge: OAUTH_TTL_S,
        });
        return reply.redirect(
          oauth.authUrl(state, challenge, {
            consent,
            ...(known ? { loginHint: known.email } : {}),
          }),
          302,
        );
      },
    );

    /** Step 2: Google redirects back. Every failure lands on the web app with ?auth_error=<code>. */
    app.get(`${OAUTH_PATH}/callback`, async (req, reply) => {
      const { oauth, tokens } = google();
      const fail = (code: string) => {
        reply.clearCookie(OAUTH_COOKIE, { path: OAUTH_PATH });
        return reply.redirect(
          `${ctx.config.webAppUrl}/?auth_error=${encodeURIComponent(code)}`,
          302,
        );
      };
      const q = CallbackQuery.safeParse(req.query);
      if (!q.success) return fail("invalid_request");
      const { code, state, error } = q.data;
      if (error) return fail(error === "access_denied" ? "access_denied" : "google_error");
      if (!code || !state) return fail("invalid_request");

      // one-time use, and must be the browser that started the flow (login-CSRF defence)
      const stored = await ctx.redis.getdel(oauthKey(state));
      if (!stored || req.cookies[OAUTH_COOKIE] !== state) return fail("invalid_state");
      const { verifier, tz, consent } = JSON.parse(stored) as {
        verifier: string;
        tz: string | null;
        consent?: boolean;
      };

      // all OAuth work returns an error code (or null); the redirect happens afterwards
      const signIn = async (): Promise<string | null> => {
        const t = await oauth.exchangeCode(code, verifier);
        if (!t.scopes.includes(GMAIL_READONLY)) return "insufficient_scope";
        const profile = await oauth.userinfo(t.accessToken);
        if (!profile.emailVerified) return "email_not_verified";

        const existing = await ctx.prisma.user.findUnique({ where: { email: profile.email } });
        if (existing && existing.authMode !== "google") return "account_conflict";
        if (!t.refreshToken && !existing?.refreshTokenEnc) {
          // Google skipped the permission screen, so it sent no long-lived token and we hold
          // none: ask once more, with the permission screen (never loops: that flow has consent)
          if (consent === false) return RETRY_WITH_CONSENT;
          return "no_refresh_token";
        }

        const user = existing
          ? await ctx.prisma.user.update({
              where: { id: existing.id },
              data: { name: profile.name },
            })
          : await ctx.prisma.user.create({
              data: {
                email: profile.email,
                name: profile.name,
                authMode: "google",
                ...(tz ? { timezone: tz } : {}),
              },
            });
        if (t.refreshToken) await tokens.storeRefreshToken(user.id, t.refreshToken);
        await tokens.cacheAccessToken(user.id, t.accessToken, t.expiresIn);
        await ctx.prisma.auditLog.create({
          data: {
            userId: user.id,
            action: "login",
            meta: { mode: "google", returning: Boolean(existing) },
          },
        });
        await setSession(reply, user.id);
        // remember this browser for one-click sign-in next time (replacing any old device)
        await devices.forget(req.cookies[DEVICE_COOKIE]);
        setDevice(reply, await devices.remember(user.id));
        await syncOnSignIn(user.id, existing?.lastSyncAt ?? null, req.id);
        return null;
      };

      let failure: string | null;
      try {
        failure = await signIn();
      } catch (err) {
        req.log.warn(
          { code: err instanceof OAuthError ? err.code : "unexpected" },
          "google sign-in failed",
        );
        failure = "oauth_failed";
      }
      if (failure === RETRY_WITH_CONSENT) {
        reply.clearCookie(OAUTH_COOKIE, { path: OAUTH_PATH });
        const again = new URLSearchParams({ consent: "1", ...(tz ? { tz } : {}) });
        return reply.redirect(`${OAUTH_PATH}?${again.toString()}`, 302);
      }
      if (failure) return fail(failure);
      reply.clearCookie(OAUTH_COOKIE, { path: OAUTH_PATH });
      return reply.redirect(`${ctx.config.webAppUrl}/`, 302);
    });
  };
