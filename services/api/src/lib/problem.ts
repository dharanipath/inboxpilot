import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

/** An error that becomes an RFC 7807 problem+json response. */
export class HttpProblem extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail?: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(detail ?? title);
  }
}

export const notFound = (what: string): HttpProblem =>
  new HttpProblem(404, "Not Found", `${what} not found`);
export const unauthorized = (): HttpProblem =>
  new HttpProblem(401, "Unauthorized", "Sign in to continue");

export function sendProblem(
  reply: FastifyReply,
  request: FastifyRequest,
  status: number,
  title: string,
  detail?: string,
  extra: Record<string, unknown> = {},
): FastifyReply {
  return reply
    .status(status)
    .type("application/problem+json")
    .send({
      type: "about:blank",
      title,
      status,
      detail: detail ?? null,
      traceId: request.id,
      ...extra,
    });
}

const TITLES: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  413: "Payload Too Large",
  415: "Unsupported Media Type",
  429: "Too Many Requests",
};

export function registerProblemHandlers(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) =>
    sendProblem(
      reply,
      request,
      404,
      "Not Found",
      `${request.method} ${request.url} does not exist`,
    ),
  );

  app.setErrorHandler((error: FastifyError | Error, request, reply) => {
    if (error instanceof HttpProblem) {
      return sendProblem(reply, request, error.status, error.title, error.detail, error.extra);
    }
    if (error instanceof ZodError) {
      // never echo the offending input values back
      const errors = error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
      return sendProblem(
        reply,
        request,
        400,
        "Invalid request",
        `${errors.length} invalid field(s)`,
        {
          errors,
        },
      );
    }
    const status =
      "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 500;
    if (status >= 500) {
      request.log.error({ err: error }, "unhandled error");
      return sendProblem(
        reply,
        request,
        500,
        "Internal error",
        "Something went wrong on our side.",
      );
    }
    return sendProblem(reply, request, status, TITLES[status] ?? "Error", error.message);
  });
}
