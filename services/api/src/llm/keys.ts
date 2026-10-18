import type { PrismaClient, User } from "@prisma/client";

import type { ExtractOptions } from "../agent/types.js";
import type { TokenCipher } from "../lib/crypto.js";

/** Providers that take an API key (mirrors KeyedProvider in the contract). */
export const KEYED_PROVIDERS = [
  "gemini",
  "groq",
  "cerebras",
  "openrouter",
  "mistral",
  "github",
  "hf",
  "openai",
] as const;
export type KeyedProvider = (typeof KEYED_PROVIDERS)[number];
export type ProviderKeys = Partial<Record<KeyedProvider, string>>;

export const PROVIDER_LABEL: Record<string, string> = {
  gemini: "Google Gemini",
  groq: "Groq",
  cerebras: "Cerebras",
  openrouter: "OpenRouter",
  mistral: "Mistral",
  github: "OpenAI GPT (GitHub Models)",
  hf: "Hugging Face",
  openai: "OpenAI",
  ollama: "Ollama (local Llama)",
  heuristic: "Rules only (no AI)",
};

export const isKeyed = (name: string): name is KeyedProvider =>
  (KEYED_PROVIDERS as readonly string[]).includes(name);

/** What the UI may show about a saved key: never the key itself. */
export const keyHint = (key: string): string => `\u2022\u2022\u2022\u2022${key.slice(-4)}`;

const context = (userId: string) => `llm-keys:${userId}`;

/**
 * The user's saved model selection, or [] (automatic) if it names a provider that no longer
 * exists (e.g. one that was removed). Never half-applied: that would silently mean "rules only".
 */
export const selection = (order: string[]): string[] =>
  order.every((name) => name in PROVIDER_LABEL) ? order : [];

/**
 * Users' own LLM API keys (ADR 0006). Stored as one AES-256-GCM blob per user, bound to the
 * user id, under TOKEN_ENC_KEY. Decrypted only to forward to the agent for that user's own
 * requests; never logged and never sent back to the browser.
 */
export class LlmKeys {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly cipher: TokenCipher | null,
  ) {}

  get enabled(): boolean {
    return this.cipher !== null;
  }

  async get(userId: string): Promise<ProviderKeys> {
    if (!this.cipher) return {};
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { llmKeysEnc: true },
    });
    if (!row?.llmKeysEnc) return {};
    try {
      const saved = JSON.parse(this.cipher.decrypt(row.llmKeysEnc, context(userId))) as Record<
        string,
        string
      >;
      return Object.fromEntries(Object.entries(saved).filter(([name]) => isKeyed(name)));
    } catch {
      return {}; // TOKEN_ENC_KEY rotated or data tampered with: treat as no keys
    }
  }

  async set(userId: string, name: KeyedProvider, apiKey: string): Promise<void> {
    await this.save(userId, { ...(await this.get(userId)), [name]: apiKey });
  }

  async remove(userId: string, name: KeyedProvider): Promise<void> {
    const keys = await this.get(userId);
    await this.save(userId, Object.fromEntries(Object.entries(keys).filter(([k]) => k !== name)));
  }

  /** Model order and the user's own keys, for every agent call made on the user's behalf. */
  async options(
    user: Pick<User, "id" | "llmProviders">,
  ): Promise<Pick<ExtractOptions, "providers" | "provider_keys">> {
    const keys = await this.get(user.id);
    const providers = selection(user.llmProviders);
    return {
      ...(providers.length ? { providers } : {}),
      ...(Object.keys(keys).length ? { provider_keys: keys } : {}),
    };
  }

  private async save(userId: string, keys: ProviderKeys): Promise<void> {
    if (!this.cipher) throw new Error("TOKEN_ENC_KEY is not set");
    const empty = Object.keys(keys).length === 0;
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        llmKeysEnc: empty ? null : this.cipher.encrypt(JSON.stringify(keys), context(userId)),
      },
    });
  }
}
