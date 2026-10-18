/** Thin fetch wrapper for the gateway. Errors arrive as RFC 7807 problem+json. */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail: string | null,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(detail ?? title);
  }
}

export async function api<T>(
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<T> {
  const { json, headers, ...rest } = init;
  const res = await fetch(path, {
    credentials: "same-origin",
    ...rest,
    headers: {
      accept: "application/json",
      ...(json !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });
  if (res.status === 204) return undefined as T;
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const p = (body ?? {}) as { title?: string; detail?: string | null } & Record<string, unknown>;
    throw new ApiError(res.status, p.title ?? res.statusText, p.detail ?? null, p);
  }
  return body as T;
}

export const isUnauthorized = (err: unknown): boolean =>
  err instanceof ApiError && err.status === 401;
