import { createHash, randomBytes } from "node:crypto";

import type { GoogleConfig } from "../config.js";

export const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
export const GMAIL_READONLY = "https://www.googleapis.com/auth/gmail.readonly";
/** Least privilege: identity + read-only Gmail. Nothing that can send, modify or delete. */
export const SCOPES = ["openid", "email", "profile", GMAIL_READONLY];

export class OAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface TokenSet {
  accessToken: string;
  expiresIn: number;
  refreshToken: string | null;
  scopes: string[];
}

export interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/**
 * Route Google traffic to a local emulator (tests only; refused in production by config):
 * https://<host>/<path> becomes <emulator>/<host>/<path>.
 */
export function emulatorUrl(emulator: string, url: string): string {
  const u = new URL(url);
  return `${emulator}/${u.host}${u.pathname}${u.search}`;
}

export function emulatorFetch(emulator: string): typeof fetch {
  return (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return fetch(emulatorUrl(emulator, url), init);
  };
}

export class GoogleOAuth {
  constructor(
    private readonly cfg: Pick<GoogleConfig, "clientId" | "clientSecret" | "redirectUri">,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly authEndpoint: string = AUTH_URL,
  ) {}

  /**
   * `consent` forces Google's permission screen, which is what makes it return a refresh token.
   * Needed only when we hold none for this person; a returning user with a stored token skips it
   * (Google remembers the grant). `loginHint` pre-selects their account (no account chooser).
   */
  authUrl(
    state: string,
    codeChallenge: string,
    opts: { consent?: boolean; loginHint?: string } = {},
  ): string {
    const params = new URLSearchParams({
      client_id: this.cfg.clientId,
      redirect_uri: this.cfg.redirectUri,
      response_type: "code",
      scope: SCOPES.join(" "),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      access_type: "offline",
      include_granted_scopes: "false",
    });
    if (opts.consent ?? true) params.set("prompt", "consent");
    if (opts.loginHint) params.set("login_hint", opts.loginHint);
    return `${this.authEndpoint}?${params.toString()}`;
  }

  async exchangeCode(code: string, codeVerifier: string): Promise<TokenSet> {
    return this.token({
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
      redirect_uri: this.cfg.redirectUri,
    });
  }

  async refresh(refreshToken: string): Promise<TokenSet> {
    return this.token({ grant_type: "refresh_token", refresh_token: refreshToken });
  }

  async userinfo(accessToken: string): Promise<GoogleProfile> {
    const res = await this.fetchImpl(USERINFO_URL, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new OAuthError("userinfo_failed", `userinfo returned ${res.status}`);
    const p = (await res.json()) as Record<string, unknown>;
    if (typeof p.sub !== "string" || typeof p.email !== "string") {
      throw new OAuthError("userinfo_failed", "userinfo missing sub/email");
    }
    return {
      sub: p.sub,
      email: p.email.toLowerCase(),
      emailVerified: p.email_verified === true,
      name: typeof p.name === "string" ? p.name : null,
    };
  }

  /** Best effort: Google returns 200 for valid tokens, 400 for already-invalid ones. */
  async revoke(token: string): Promise<boolean> {
    const res = await this.fetchImpl(REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(), // in the body, never in a logged URL
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  }

  private async token(params: Record<string, string>): Promise<TokenSet> {
    const res = await this.fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        ...params,
      }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const code = typeof body.error === "string" ? body.error : `http_${res.status}`;
      throw new OAuthError(code, `token endpoint: ${code}`); // never include tokens in errors
    }
    if (typeof body.access_token !== "string")
      throw new OAuthError("bad_response", "no access_token");
    return {
      accessToken: body.access_token,
      expiresIn: typeof body.expires_in === "number" ? body.expires_in : 3600,
      refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
      scopes: typeof body.scope === "string" ? body.scope.split(" ") : [],
    };
  }
}
