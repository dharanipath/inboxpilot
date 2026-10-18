import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import type { RouteContext } from "../app.js";
import { type SyncEvent, TERMINAL } from "../jobs/events.js";
import { notFound } from "../lib/problem.js";

const SyncBody = z
  .object({
    days: z.number().int().min(1).max(30).default(14),
    reprocess: z.boolean().default(false),
  })
  .strict()
  .default({});
const JobParams = z.object({ jobId: z.string().uuid() });
const RunsQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) });
const HEARTBEAT_MS = 15_000;

function runJson(r: {
  id: string;
  status: string;
  days: number;
  stats: unknown;
  trace: unknown;
  providerUsage: unknown;
  briefing: unknown;
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}) {
  return {
    id: r.id,
    status: r.status,
    days: r.days,
    stats: r.stats,
    trace: r.trace ?? [],
    provider_usage: r.providerUsage ?? [],
    briefing: r.briefing,
    error: r.error,
    started_at: r.startedAt.toISOString(),
    finished_at: r.finishedAt?.toISOString() ?? null,
  };
}

export const syncRoutes =
  (ctx: RouteContext): FastifyPluginAsync =>
  async (app) => {
    app.post(
      "/api/sync",
      { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
      async (req, reply) => {
        const user = await ctx.currentUser(req);
        const body = SyncBody.parse(req.body ?? {});
        const { runId } = await ctx.sync.start(user.id, body, req.id);
        return reply.status(202).send({
          jobId: runId,
          events: `/api/sync/${runId}/events`,
          status: `/api/sync/${runId}`,
        });
      },
    );

    app.get("/api/sync/runs", async (req) => {
      const user = await ctx.currentUser(req);
      const { limit } = RunsQuery.parse(req.query);
      const runs = await ctx.prisma.syncRun.findMany({
        where: { userId: user.id },
        orderBy: { startedAt: "desc" },
        take: limit,
      });
      return { items: runs.map(runJson) };
    });

    app.get("/api/sync/:jobId", async (req) => {
      const user = await ctx.currentUser(req);
      const { jobId } = JobParams.parse(req.params);
      const run = await ctx.prisma.syncRun.findFirst({ where: { id: jobId, userId: user.id } });
      if (!run) throw notFound("Sync run");
      return runJson(run);
    });

    /**
     * Server-Sent Events: replays the run's event log, then streams live events until done/error.
     * Supports Last-Event-ID for reconnects.
     */
    app.get("/api/sync/:jobId/events", { config: { rateLimit: false } }, async (req, reply) => {
      const user = await ctx.currentUser(req);
      const { jobId } = JobParams.parse(req.params);
      const run = await ctx.prisma.syncRun.findFirst({ where: { id: jobId, userId: user.id } });
      if (!run) throw notFound("Sync run");

      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
        "x-request-id": req.id,
      });

      let lastSeq = Number(req.headers["last-event-id"]) || 0;
      // mutated from callbacks, so it lives in an object (TS flow analysis can't see closures)
      const stream = { closed: false };
      let replaying = true;
      const buffered: SyncEvent[] = [];

      const send = (e: SyncEvent) => {
        if (stream.closed || e.seq <= lastSeq) return;
        lastSeq = e.seq;
        raw.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
        if (TERMINAL.has(e.type)) close();
      };
      // subscribe BEFORE reading history so nothing published in between is lost
      const unsubscribe = await ctx.events.subscribe(jobId, (e) => {
        if (replaying) buffered.push(e);
        else send(e);
      });
      const heartbeat = setInterval(() => {
        if (!stream.closed) raw.write(": ping\n\n");
      }, HEARTBEAT_MS);
      function close() {
        if (stream.closed) return;
        stream.closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        raw.end();
      }
      req.raw.on("close", close);

      const history = await ctx.events.history(jobId);
      for (const e of history) send(e);
      replaying = false;
      for (const e of buffered.sort((a, b) => a.seq - b.seq)) send(e);

      // event log expired (1 h) but the run is finished: synthesise the terminal event
      if (
        !stream.closed &&
        !history.length &&
        (run.status === "succeeded" || run.status === "failed")
      ) {
        send({
          seq: lastSeq + 1,
          type: run.status === "succeeded" ? "done" : "error",
          at: (run.finishedAt ?? run.startedAt).toISOString(),
          data:
            run.status === "succeeded"
              ? ((run.stats as Record<string, unknown> | null) ?? {})
              : { message: run.error },
        });
      }
    });
  };
