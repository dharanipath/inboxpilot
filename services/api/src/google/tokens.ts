import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";

import type { TokenCipher } from "../lib/crypto.js";
import { HttpProblem } from "../lib/problem.js";
import { type GoogleOAuth, OAuthError } from "./oauth.js";

/** Google access was revoked or expired: the user must sign in with Google again. */
export class ReconnectRequired extends HttpProblem {
  constructor() {
    super(
      401,
      "Reconnect Google",
      "Google access was revoked or has expired. Sign in with Google again.",
    );
  }
}

const cacheKey = (userId: string) => `gtoken:${userId}`;
const SAFETY_S = 60;

/**
 * Refresh tokens: AES-256-GCM in Postgres (bound to the user id).
 * Access tokens: encrypted in Redis for their lifetime minus a minute, so we don't refresh
 * on every Gmail call.
 */
export class GoogleTokens {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly redis: Redis,
    private readonly cipher: TokenCipher,
    private readonly oauth: GoogleOAuth,
  ) {}

  async storeRefreshToken(userId: string, refreshToken: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { refreshTokenEnc: new Uint8Array(this.cipher.encrypt(refreshToken, userId)) },
    });
  }

  async cacheAccessToken(userId: string, accessToken: string, expiresIn: number): Promise<void> {
    const ttl = Math.max(1, expiresIn - SAFETY_S);
    const blob = this.cipher.encrypt(accessToken, `access:${userId}`).toString("base64");
    await this.redis.set(cacheKey(userId), blob, "EX", ttl);
  }

  async accessToken(userId: string): Promise<string> {
    const cached = await this.redis.get(cacheKey(userId));
    if (cached) {
      try {
        return this.cipher.decrypt(Buffer.from(cached, "base64"), `access:${userId}`);
      } catch {
        await this.redis.del(cacheKey(userId)); // key rotated or corrupt: refresh below
      }
    }
    const refreshToken = await this.refreshToken(userId);
    try {
      const t = await this.oauth.refresh(refreshToken);
      await this.cacheAccessToken(userId, t.accessToken, t.expiresIn);
      return t.accessToken;
    } catch (err) {
      if (err instanceof OAuthError && err.code === "invalid_grant") {
        // the user revoked access in their Google account: forget the dead token
        await this.prisma.user.update({ where: { id: userId }, data: { refreshTokenEnc: null } });
        throw new ReconnectRequired();
      }
      throw err;
    }
  }

  async invalidate(userId: string): Promise<void> {
    await this.redis.del(cacheKey(userId));
  }

  /** Revoke at Google (best effort) and forget the tokens locally. */
  async revoke(userId: string): Promise<boolean> {
    let revoked = false;
    try {
      revoked = await this.oauth.revoke(await this.refreshToken(userId));
    } catch {
      revoked = false;
    }
    await this.redis.del(cacheKey(userId));
    await this.prisma.user.updateMany({ where: { id: userId }, data: { refreshTokenEnc: null } });
    return revoked;
  }

  private async refreshToken(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { refreshTokenEnc: true },
    });
    if (!user?.refreshTokenEnc) throw new ReconnectRequired();
    try {
      return this.cipher.decrypt(user.refreshTokenEnc, userId);
    } catch {
      throw new ReconnectRequired(); // wrong key or tampered row: never use it
    }
  }
}
