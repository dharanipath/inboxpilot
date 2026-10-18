# @inboxpilot/contracts

`extract.schema.json` is the single source of truth for the gateway ↔ agent contract (v1). All types live under `$defs`. Validate against a fragment:

- Node (Ajv 2020): `ajv.getSchema(schema.$id + "#/$defs/ExtractResponse")`
- Python: `jsonschema.Draft202012Validator({"$ref": "#/$defs/ExtractResponse", **schema})`

`fixtures/` holds a request/response pair, and `priority_cases.json`: the read-time re-scoring table that both the agent (`prioritize.combine`) and the gateway (`lib/priority.ts`) must reproduce exactly. The agent's tests assert that its output validates. The gateway's tests assert that it can consume `extract.response.json`. A breaking change means `/v2` and a new ADR.
