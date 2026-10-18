// Test environment. Never points at dev data: separate database and Redis db 15.
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://inboxpilot:inboxpilot@localhost:5432/inboxpilot_test";
process.env.TEST_REDIS_URL ??= "redis://localhost:6379/15";
process.env.REDIS_URL = process.env.TEST_REDIS_URL;
process.env.INTERNAL_API_KEY = "test-internal-key";
process.env.JWT_SECRET = "test-secret-test-secret-test-secret-0123";
process.env.AGENT_URL = "http://127.0.0.1:1"; // unused: tests inject a fake agent
process.env.WEB_ORIGINS = "http://localhost:5173";
process.env.LOG_LEVEL = "silent";
process.env.RATE_LIMIT_PER_MIN = "10000";
// test-only key (encrypts users' LLM API keys in tests); never a real secret
process.env.TOKEN_ENC_KEY = Buffer.alloc(32, 9).toString("base64");
