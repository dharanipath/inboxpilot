import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * AES-256-GCM for OAuth tokens at rest. Layout: iv(12) | tag(16) | ciphertext.
 * `context` (the user id) is bound as additional authenticated data, so a ciphertext copied
 * onto another user's row fails to decrypt.
 */
export class TokenCipher {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error("TokenCipher needs a 32-byte key");
  }

  encrypt(plaintext: string, context: string): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(context, "utf8"));
    const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]);
  }

  /** Throws if the data was tampered with, or the key or context is wrong. */
  decrypt(blob: Uint8Array, context: string): string {
    const buf = Buffer.from(blob);
    if (buf.length < IV_BYTES + TAG_BYTES) throw new Error("ciphertext too short");
    const decipher = createDecipheriv("aes-256-gcm", this.key, buf.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([
      decipher.update(buf.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  }
}
