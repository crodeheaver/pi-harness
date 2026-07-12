# Module: APIs & Services

Fold these sections into the spec spine when specifying an API or networked service. The wire contract **is** the spec here — specify it precisely. Storage, framework, and language remain the implementer's choice.

## Sections to add

- **Resource / method model.** For each endpoint or RPC method: name, purpose, request shape, response shape. Specify field names, types, units, and which are required vs optional — at the contract level, not as internal handlers.
- **Error semantics.** The error model: status/error codes, the error response shape, which conditions map to which errors. State idempotency for each mutating operation and the expected client retry behavior.
- **Authentication & authorization.** What the contract requires — credential/token type, scopes or permissions needed per operation — without prescribing how auth is implemented.
- **Versioning & compatibility.** How versions are expressed, what counts as a breaking change, and the deprecation policy.
- **Pagination, filtering, sorting.** The conventions for collection endpoints (cursor vs offset, parameter names, defaults, limits).
- **Rate limits & quotas.** Stated as observable behavior: limits, the response when exceeded, and how clients learn their remaining budget.
- **Validation rules.** Per-field constraints that requests must satisfy and the error returned on violation.
- **Events / webhooks** (if any). Payload shapes, delivery semantics (at-least-once vs exactly-once), ordering guarantees, and retry behavior.
- **Non-functional contract.** Quantified latency, throughput, and availability targets.

## Cautions & conventions

- Specify wire contracts exactly (field names, types, status codes) — these are the agreement every client and the server depend on, so they belong in the spec.
- Leave storage engine, server framework, and language open unless externally constrained.
- Reference established standards rather than reinventing: HTTP semantics, OAuth2 / OIDC for auth, JSON Schema for payload shapes, and a description format such as OpenAPI for the contract itself.
- Prior-art prompt for research: how do comparable, well-regarded APIs shape similar resources and errors? Match prevailing conventions unless there is a reason not to.
