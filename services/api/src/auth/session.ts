import { randomUUID } from "node:crypto";

import type { Redis } from "ioredis";
import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE = "ip_session";
export const SESSION_TTL_S = 7 * 24 * 3600;

export interface SessionUser {
  userId: string;
  jti: string;
  mode: "google";
}

/**
 * HS256 JWT in an httpOnly cookie, plus a Redis allow-list (session:{jti}) so logout and
 * account deletion revoke a session immediately, not when the token expires.
 */
export class Sessions {
  private readonly key: Uint8Array;

  constructor(
    secret: string,
    private readonly redis: Redis,
    private readonly ttlS = SESSION_TTL_S,
  ) {
    this.key = new TextEncoder().encode(secret);
  }

  async issue(
    userId: string,
    mode: SessionUser["mode"],
  ): Promise<{ token: string; maxAge: number }> {
    const jti = randomUUID();
    const token = await new SignJWT({ mode })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(userId)
      .setJti(jti)
      .setIssuedAt()
      .setExpirationTime(`${this.ttlS}s`)
      .setIssuer("inboxpilot")
      .sign(this.key);
    await this.redis.set(`session:${jti}`, userId, "EX", this.ttlS);
    return { token, maxAge: this.ttlS };
  }

  async verify(token: string | undefined): Promise<SessionUser | null> {
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: "inboxpilot",
        algorithms: ["HS256"],
      });
      const { sub, jti, mode } = payload;
      if (!sub || !jti || mode !== "google") return null;
      const owner = await this.redis.get(`session:${jti}`);
      return owner === sub ? { userId: sub, jti, mode } : null;
    } catch {
      return null;
    }
  }

  async revoke(jti: string): Promise<void> {
    await this.redis.del(`session:${jti}`);
  }
}
