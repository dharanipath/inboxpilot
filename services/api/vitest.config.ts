import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    setupFiles: ["tests/env.ts"],
    // one shared Postgres test database + Redis db: run files one at a time
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
      reporter: ["text-summary", "text"],
    },
  },
});
