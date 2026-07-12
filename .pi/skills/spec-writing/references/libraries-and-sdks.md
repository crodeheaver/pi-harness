# Module: Libraries & SDKs

Fold these sections into the spec spine when specifying a reusable library, package, or SDK that other code depends on. The **public API is the contract** — it is what every consumer builds against and what you are not free to break. Everything not marked public is the implementer's to change.

## Sections to add

- **Public API surface.** The exported types, functions, and entry points with their signatures: parameters, return values, types, and units. Mark clearly what is public vs internal.
- **Semantics & invariants.** What each operation guarantees: preconditions and postconditions, ordering guarantees, and any invariants that hold across calls.
- **Error model.** How failures are surfaced (as a conceptual model — raised errors, result values, status codes — not a language mechanism) and the categories of error a consumer must handle.
- **State & lifecycle.** Initialization, configuration, resource ownership and cleanup, and whether instances are reusable or single-use.
- **Concurrency.** Thread-safety guarantees, async behavior, cancellation, and what is safe to call from where.
- **Extensibility points.** Hooks, callbacks, plugins, or interfaces consumers are expected to implement, with their contracts.
- **Compatibility & versioning.** The versioning policy (e.g., semver), what counts as a breaking change, the deprecation path, and the stability tier of each part of the surface.
- **Side effects & dependencies.** What the library touches outside itself (I/O, global state, environment) and what it expects of its dependencies.
- **Performance characteristics** (where part of the contract). Complexity guarantees or allocation behavior consumers may rely on.

## Cautions & conventions

- The public API is the contract; internal modules and helpers are not. State explicitly what consumers must **not** depend on, so the implementer keeps room to change it.
- Keep the error model and API shape language-agnostic in concept; if the SDK targets a specific language or platform, that is a tagged constraint, not a default.
- Follow the idioms of the target ecosystem — naming, error conventions, and packaging norms — since consumers expect them.
- Prior-art prompt for research: how do well-regarded libraries in this space shape comparable APIs and lifecycles?
