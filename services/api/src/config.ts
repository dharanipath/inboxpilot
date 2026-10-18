import { z } from "zod";

const bool = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().default("redis://localhost:6379/0"),
  AGENT_URL: z.string().url().default("http://localhost:8000"),
  AGENT_TIMEOUT_MS: z.coerce.number().int().positive().default(90_000),
  INTERNAL_API_KEY: z.string().min(8, "INTERNAL_API_KEY must be at least 8 characters"),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  WEB_ORIGINS: z.string().default("http://localhost:5173,http://localhost:4000"),
  COOKIE_SECURE: bool.optional(),
  SYNC_MAX_EMAILS: z.coerce.number().int().min(1).max(200).default(50),
  SYNC_CHUNK_SIZE: z.coerce.number().int().min(1).max(200).default(12),
  SYNC_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(2),
  RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(300),
  CONTRACTS_DIR: z.string().optional(),
  // Google sign-in + Gmail: required to use the app (sign-in is Google-only)
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().url().default("http://localhost:5173/api/auth/google/callback"),
  TOKEN_ENC_KEY: z.string().optional(), // 32 bytes, base64 or hex: AES-256-GCM key for OAuth tokens
  WEB_APP_URL: z.string().url().default("http://localhost:5173"),
  GMAIL_BACKOFF_BASE_MS: z.coerce.number().int().min(0).default(500),
  GMAIL_FETCH_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(5),
  // background re-sync of every connected inbox; 0 disables
  AUTO_SYNC_INTERVAL_S: z.coerce.number().int().min(0).max(86_400).default(120),
  // tests only: send every Google call (and the sign-in redirect) to a local emulator
  GOOGLE_EMULATOR_URL: z.string().url().optional(),
});

export interface Config {
  env: "development" | "test" | "production";
  host: string;
  port: number;
  logLevel: string;
  databaseUrl: string;
  redisUrl: string;
  agentUrl: string;
  agentTimeoutMs: number;
  internalApiKey: string;
  jwtSecret: string;
  webOrigins: string[];
  cookieSecure: boolean;
  syncMaxEmails: number;
  syncChunkSize: number;
  syncWorkerConcurrency: number;
  rateLimitPerMin: number;
  contractsDir: string | undefined;
  google: GoogleConfig | null;
  /** TOKEN_ENC_KEY: encrypts Google refresh tokens and users' own LLM API keys at rest. */
  tokenKey: Buffer | null;
  webAppUrl: string;
  gmailBackoffBaseMs: number;
  gmailFetchConcurrency: number;
  autoSyncIntervalS: number;
  googleEmulatorUrl: string | undefined;
}

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tokenKey: Buffer;
}

/** TOKEN_ENC_KEY must decode to exactly 32 bytes (hex or base64). */
export function parseTokenKey(raw: string): Buffer {
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("TOKEN_ENC_KEY must be 32 bytes (64 hex chars or base64)");
  return key;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid configuration:\n  ${problems.join("\n  ")}`);
  }
  const e = parsed.data;
  if (e.GOOGLE_EMULATOR_URL && e.NODE_ENV === "production") {
    throw new Error(
      "Invalid configuration: GOOGLE_EMULATOR_URL is for tests and cannot be used in production",
    );
  }
  const tokenKey = e.TOKEN_ENC_KEY ? parseTokenKey(e.TOKEN_ENC_KEY) : null;
  let google: GoogleConfig | null = null;
  if (e.GOOGLE_CLIENT_ID || e.GOOGLE_CLIENT_SECRET) {
    const missing = [
      !e.GOOGLE_CLIENT_ID && "GOOGLE_CLIENT_ID",
      !e.GOOGLE_CLIENT_SECRET && "GOOGLE_CLIENT_SECRET",
      !e.TOKEN_ENC_KEY && "TOKEN_ENC_KEY",
    ].filter(Boolean);
    if (missing.length) {
      throw new Error(`Invalid configuration:
  Google sign-in also needs ${missing.join(", ")}`);
    }
    google = {
      clientId: e.GOOGLE_CLIENT_ID ?? "",
      clientSecret: e.GOOGLE_CLIENT_SECRET ?? "",
      redirectUri: e.GOOGLE_REDIRECT_URI,
      tokenKey: tokenKey ?? parseTokenKey(""),
    };
  }
  return {
    env: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    agentUrl: e.AGENT_URL.replace(/\/+$/, ""),
    agentTimeoutMs: e.AGENT_TIMEOUT_MS,
    internalApiKey: e.INTERNAL_API_KEY,
    jwtSecret: e.JWT_SECRET,
    webOrigins: e.WEB_ORIGINS.split(",")
      .map((o) => o.trim())
      .filter(Boolean),
    cookieSecure: e.COOKIE_SECURE ?? e.NODE_ENV === "production",
    syncMaxEmails: e.SYNC_MAX_EMAILS,
    syncChunkSize: e.SYNC_CHUNK_SIZE,
    syncWorkerConcurrency: e.SYNC_WORKER_CONCURRENCY,
    rateLimitPerMin: e.RATE_LIMIT_PER_MIN,
    contractsDir: e.CONTRACTS_DIR,
    google,
    tokenKey,
    webAppUrl: e.WEB_APP_URL.replace(/\/+$/, ""),
    gmailBackoffBaseMs: e.GMAIL_BACKOFF_BASE_MS,
    gmailFetchConcurrency: e.GMAIL_FETCH_CONCURRENCY,
    autoSyncIntervalS: e.AUTO_SYNC_INTERVAL_S,
    googleEmulatorUrl: e.GOOGLE_EMULATOR_URL?.replace(/\/+$/, ""),
  };
}
