import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { PrismaClient, User } from "@prisma/client";

/**
 * "Remember this browser": after a Google sign-in, the browser keeps a random secret so the next
 * sign-in is one click ("Continue as …") with no trip to Google. Gmail access itself is the
 * stored refresh token; this only proves it is the same browser.
 *
 * - Cookie `ip_device` = `<device id>.<secret>`: httpOnly, SameSite=Lax, scoped to /api/auth.
 * - Only a SHA-256 of the secret is stored; it is compared in constant time.
 * - Rotated on every use, so a copied cookie stops working after the owner's next sign-in.
 * - Kept after a normal logout (that is the point); removed by "forget this browser", by
 *   deleting the account (cascade), and after 180 days.
 */
export const DEVICE_COOKIE = "ip_device";
export const DEVICE_PATH = "/api/auth";
export const DEVICE_TTL_S = 180 * 24 * 3600;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");

function parse(cookie: string | undefined): { id: string; secret: string } | null {
  if (!cookie) return null;
  const dot = cookie.indexOf(".");
  const id = cookie.slice(0, dot);
  const secret = cookie.slice(dot + 1);
  if (dot < 0 || !UUID.test(id) || !/^[\w-]{40,64}$/.test(secret)) return null;
  return { id, secret };
}

export class Devices {
  constructor(private readonly prisma: PrismaClient) {}

  /** Remember this browser for the user; returns the cookie value. */
  async remember(userId: string, now = new Date()): Promise<string> {
    const secret = randomBytes(32).toString("base64url");
    const device = await this.prisma.rememberedDevice.create({
      data: {
        userId,
        secretHash: hash(secret),
        expiresAt: new Date(now.getTime() + DEVICE_TTL_S * 1000),
      },
    });
    return `${device.id}.${secret}`;
  }

  /** The user this browser remembers, if the cookie is genuine and unexpired. */
  async find(
    cookie: string | undefined,
    now = new Date(),
  ): Promise<{ id: string; user: User } | null> {
    const parsed = parse(cookie);
    if (!parsed) return null;
    const device = await this.prisma.rememberedDevice.findUnique({
      where: { id: parsed.id },
      include: { user: true },
    });
    if (!device || device.expiresAt <= now) return null;
    const given = Buffer.from(hash(parsed.secret), "hex");
    const stored = Buffer.from(device.secretHash, "hex");
    if (given.length !== stored.length || !timingSafeEqual(given, stored)) return null;
    return { id: device.id, user: device.user };
  }

  /** New secret for the same device (on every use); returns the new cookie value. */
  async rotate(deviceId: string, now = new Date()): Promise<string> {
    const secret = randomBytes(32).toString("base64url");
    await this.prisma.rememberedDevice.update({
      where: { id: deviceId },
      data: {
        secretHash: hash(secret),
        lastUsedAt: now,
        expiresAt: new Date(now.getTime() + DEVICE_TTL_S * 1000),
      },
    });
    return `${deviceId}.${secret}`;
  }

  async forget(cookie: string | undefined): Promise<void> {
    const parsed = parse(cookie);
    if (parsed) await this.prisma.rememberedDevice.deleteMany({ where: { id: parsed.id } });
  }
}
