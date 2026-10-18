import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

import type {
  AgentTask,
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

// ajv-formats ships CommonJS; under NodeNext the callable is on .default
const addFormats = addFormatsModule as unknown as typeof addFormatsModule.default;

/** Contract definition name -> its TypeScript type. */
export interface ContractTypes {
  ExtractRequest: ExtractRequest;
  ExtractResponse: ExtractResponse;
  AskRequest: AskRequest;
  AskResponse: AskResponse;
  BriefingRequest: BriefingRequest;
  Briefing: Briefing;
  ProvidersResponse: ProvidersResponse;
  ProvidersRequest: ProvidersRequest;
  ProviderTestRequest: ProviderTestRequest;
  ProviderTestResponse: ProviderTestResponse;
  Task: AgentTask;
}
export type ContractName = keyof ContractTypes;

export class ContractViolation extends Error {
  constructor(
    readonly contract: ContractName,
    readonly errors: string[],
  ) {
    super(`${contract} violates the agent contract: ${errors.slice(0, 3).join("; ")}`);
  }
}

export function defaultContractsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/agent -> repo root (also works from dist/agent)
  return resolve(here, "..", "..", "..", "..", "packages", "contracts");
}

export function loadContractSchema(dir = defaultContractsDir()): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(dir, "extract.schema.json"), "utf-8")) as Record<
    string,
    unknown
  >;
}

/** Validates payloads against packages/contracts/extract.schema.json ($defs/<Name>). */
export class ContractValidator {
  private readonly cache = new Map<ContractName, ValidateFunction>();
  private readonly ajv: Ajv2020;
  private readonly id: string;

  constructor(schema: Record<string, unknown> = loadContractSchema()) {
    this.ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(this.ajv);
    this.ajv.addSchema(schema);
    this.id = String(schema.$id);
  }

  errors(name: ContractName, data: unknown): string[] {
    let fn = this.cache.get(name);
    if (!fn) {
      fn = this.ajv.getSchema(`${this.id}#/$defs/${name}`);
      if (!fn) throw new Error(`unknown contract definition ${name}`);
      this.cache.set(name, fn);
    }
    if (fn(data)) return [];
    return (fn.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`);
  }

  assert<N extends ContractName>(name: N, data: unknown): ContractTypes[N] {
    const errors = this.errors(name, data);
    if (errors.length) throw new ContractViolation(name, errors);
    return data as ContractTypes[N];
  }
}
