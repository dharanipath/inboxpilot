import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { defineConfig, devices } from "@playwright/test";

/**
 * E2E against the real stack: Python agent (heuristic only, no LLM keys) + gateway + Vite, with
 * Postgres and Redis from `docker compose up`. Google is a local fake (services/api/tests/
 * fake-google-server.ts) wired in with GOOGLE_EMULATOR_URL, so "Connect Gmail" runs the real
 * OAuth + Gmail code paths without a Google account. Dedicated ports, a separate database and
 * Redis db keep it clear of a running `docker compose` stack.
 */
const ROOT = resolve(import.meta.dirname, "..", "..");
const AGENT_DIR = resolve(ROOT, "services", "agent");
const API_DIR = resolve(ROOT, "services", "api");
const PYTHON =
  process.env.AGENT_PYTHON ??
  [
    resolve(AGENT_DIR, ".venv", "Scripts", "python.exe"),
    resolve(AGENT_DIR, ".venv", "bin", "python"),
  ].find((p) => existsSync(p)) ??
  "python";

const PORTS = { web: 5174, api: 4001, agent: 8001, google: 4555 };
const WEB = `http://localhost:${PORTS.web}`;
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY ?? "e2e-internal-key-123";

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1, // one fake Google inbox shared by every test
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: WEB,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    timezoneId: "Asia/Kolkata",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    {
      name: "mobile-375",
      use: { ...devices["Desktop Chrome"], viewport: { width: 375, height: 740 }, hasTouch: true },
    },
  ],
  webServer: [
    {
      name: "fake-google",
      command: "npx tsx tests/fake-google-server.ts",
      cwd: API_DIR,
      url: `http://127.0.0.1:${PORTS.google}/health`,
      reuseExistingServer: false,
      env: {
        FAKE_GOOGLE_PORT: String(PORTS.google),
        FAKE_GOOGLE_REDIRECT_URI: `${WEB}/api/auth/google/callback`,
      },
      timeout: 60_000,
    },
    {
      name: "agent",
      command: `"${PYTHON}" -m uvicorn app.main:create_app --factory --port ${PORTS.agent} --log-level warning`,
      cwd: AGENT_DIR,
      url: `http://localhost:${PORTS.agent}/v1/health`,
      reuseExistingServer: false, // needs this run's env (fake LLM)
      env: {
        INTERNAL_API_KEY,
        // self-contained: no Redis, so a REDIS_URL in your .env never makes the test agent touch real data
        REDIS_URL: "",
        // no server keys: only a user's own key (added in Settings) can enable a model.
        // Groq points at the fake LLM in fake-google-server.ts; Gemini is never called.
        LLM_PROVIDERS: "gemini,groq,heuristic",
        GEMINI_API_KEY: "",
        GROQ_API_KEY: "",
        GROQ_BASE_URL: `http://127.0.0.1:${PORTS.google}/llm/v1`,
      },
      timeout: 60_000,
    },
    {
      name: "api",
      command: "npx prisma migrate deploy && npx tsx src/index.ts",
      cwd: API_DIR,
      url: `http://localhost:${PORTS.api}/api/health`,
      reuseExistingServer: false,
      env: {
        PORT: String(PORTS.api),
        DATABASE_URL:
          process.env.E2E_DATABASE_URL ??
          "postgresql://inboxpilot:inboxpilot@localhost:5432/inboxpilot_test",
        REDIS_URL: process.env.E2E_REDIS_URL ?? "redis://localhost:6379/3",
        INTERNAL_API_KEY,
        JWT_SECRET: "e2e-jwt-secret-e2e-jwt-secret-0123456",
        AGENT_URL: `http://localhost:${PORTS.agent}`,
        WEB_ORIGINS: WEB,
        WEB_APP_URL: WEB,
        GOOGLE_CLIENT_ID: "test-client-id",
        GOOGLE_CLIENT_SECRET: "test-client-secret",
        GOOGLE_REDIRECT_URI: `${WEB}/api/auth/google/callback`,
        GOOGLE_EMULATOR_URL: `http://127.0.0.1:${PORTS.google}`,
        TOKEN_ENC_KEY: Buffer.alloc(32, 7).toString("base64"), // test-only key
        AUTO_SYNC_INTERVAL_S: "5",
        COOKIE_SECURE: "false",
        NODE_ENV: "test",
        LOG_LEVEL: "warn",
        RATE_LIMIT_PER_MIN: "10000",
      },
      timeout: 90_000,
    },
    {
      name: "web",
      command: `npx vite --port ${PORTS.web} --strictPort`,
      url: WEB,
      reuseExistingServer: false,
      env: { API_URL: `http://localhost:${PORTS.api}` },
      timeout: 60_000,
    },
  ],
});
