import { execSync } from "node:child_process";

/** Apply migrations to the test database once per run (CI uses a Postgres service container). */
export default function setup(): void {
  const url =
    process.env.DATABASE_URL ?? "postgresql://inboxpilot:inboxpilot@localhost:5432/inboxpilot_test";
  execSync("npx prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
}
