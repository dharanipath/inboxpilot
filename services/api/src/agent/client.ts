import { type ContractName, type ContractTypes, ContractValidator } from "./contract.js";
import type {
  AskRequest,
  AskResponse,
  Briefing,
  BriefingRequest,
  ExtractRequest,
  ExtractResponse,
  ProvidersRequest,
  ProvidersResponse,
  ProviderTestRequest,
  ProviderTestResponse,
} from "./types.js";

/** What the gateway needs from the Python agent. Tests inject a fake. */
export interface AgentApi {
  extract(req: ExtractRequest, requestId?: string): Promise<ExtractResponse>;
  ask(req: AskRequest, requestId?: string): Promise<AskResponse>;
  briefing(req: BriefingRequest, requestId?: string): Promise<Briefing>;
  /** Provider status as one user sees it (their own keys and those keys' cooldowns). */
  providers(req?: ProvidersRequest, requestId?: string): Promise<ProvidersResponse>;
  /** One tiny call to check a key before it is saved. */
  testProvider(req: ProviderTestRequest, requestId?: string): Promise<ProviderTestResponse>;
  health(): Promise<boolean>;
}

export class AgentError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

interface Options {
  baseUrl: string;
  internalKey: string;
  timeoutMs: number;
  validator?: ContractValidator;
  fetchImpl?: typeof fetch;
}

export class HttpAgentClient implements AgentApi {
  private readonly validator: ContractValidator;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: Options) {
    this.validator = opts.validator ?? new ContractValidator();
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  extract(req: ExtractRequest, requestId?: string): Promise<ExtractResponse> {
    return this.call("POST", "/v1/extract", "ExtractResponse", req, requestId);
  }

  ask(req: AskRequest, requestId?: string): Promise<AskResponse> {
    return this.call("POST", "/v1/ask", "AskResponse", req, requestId, 30_000);
  }

  briefing(req: BriefingRequest, requestId?: string): Promise<Briefing> {
    return this.call("POST", "/v1/briefing", "Briefing", req, requestId, 30_000);
  }

  providers(req: ProvidersRequest = {}, requestId?: string): Promise<ProvidersResponse> {
    return this.call("POST", "/v1/providers", "ProvidersResponse", req, requestId, 5_000);
  }

  testProvider(req: ProviderTestRequest, requestId?: string): Promise<ProviderTestResponse> {
    // the probe makes one real (tiny) LLM call: allow for a slow provider
    return this.call("POST", "/v1/providers/test", "ProviderTestResponse", req, requestId, 30_000);
  }

  async health(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.opts.baseUrl}/v1/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async call<N extends ContractName>(
    method: "GET" | "POST",
    path: string,
    contract: N,
    body: unknown,
    requestId?: string,
    timeoutMs = this.opts.timeoutMs,
  ): Promise<ContractTypes[N]> {
    const headers: Record<string, string> = { "x-internal-key": this.opts.internalKey };
    if (requestId) headers["x-request-id"] = requestId;
    if (body !== undefined) headers["content-type"] = "application/json";

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? null : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const reason =
        err instanceof Error && err.name === "TimeoutError" ? "timed out" : "unreachable";
      throw new AgentError(`agent ${reason} (${method} ${path})`);
    }
    if (!res.ok) {
      // the agent answers with problem+json; surface only its title, never the request body
      let title = res.statusText;
      try {
        const problem = (await res.json()) as { title?: unknown };
        if (typeof problem.title === "string") title = problem.title;
      } catch {
        /* non-JSON error body */
      }
      throw new AgentError(`agent ${method} ${path} failed: ${res.status} ${title}`, res.status);
    }
    return this.validator.assert(contract, await res.json());
  }
}
