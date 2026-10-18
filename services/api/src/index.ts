import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Redis } from "ioredis";
import { pino } from "pino";

import { buildApp, loggerOptions } from "./app.js";
import { loadConfig } from "./config.js";
import { createContainer } from "./container.js";
import { scheduleAutoSync } from "./jobs/autosync.js";
import { scheduleRetention } from "./jobs/retention.js";

// Local dev convenience: read the repo-root .env (never overrides real env vars). Docker passes env.
const rootEnv = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..", ".env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const config = loadConfig();
const logger = pino(loggerOptions(config.logLevel) as pino.LoggerOptions);
const container = createContainer(config, { log: logger });
const app = await buildApp(container.deps, { loggerInstance: logger });
// nightly data-retention job (docs/SECURITY.md); BullMQ needs its own connection
const maintenanceConn = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
const maintenance = await scheduleRetention(maintenanceConn, container.deps.prisma, logger);
// background inbox checks so new mail shows up without pressing Sync
const autosync = await scheduleAutoSync(
  maintenanceConn,
  container.deps.prisma,
  container.deps.sync,
  config.autoSyncIntervalS,
  logger,
);

const shutdown = async (signal: string) => {
  logger.info({ signal }, "shutting down");
  await app.close();
  await autosync?.worker.close();
  await autosync?.queue.close();
  await maintenance.worker.close();
  await maintenance.queue.close();
  await maintenanceConn.quit();
  await container.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ host: config.host, port: config.port });
