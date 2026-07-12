# Module: Data Pipelines

Fold these sections into the spec spine when specifying a data pipeline, ETL job, or batch/stream processing system. The contract here is the **data contracts at each boundary plus the processing guarantees** (delivery, ordering, freshness). Specify those; leave the engine, framework, and storage open unless externally constrained.

## Sections to add

- **Sources & sinks.** Where data enters and leaves, with the schema or contract at each boundary — input schema(s) and output schema(s).
- **Data contracts & schemas.** Field names, types, units, nullability, and the schema-evolution policy (how a schema change is rolled out without breaking consumers).
- **Transformations.** The logical operations the pipeline performs, described as input→output mappings and business rules — not as engine-specific code.
- **Processing semantics.** Batch vs streaming; delivery guarantee (at-most-once / at-least-once / exactly-once); ordering guarantees; and, for streaming, windowing and watermark/late-data handling.
- **Idempotency & reprocessing.** Behavior on retries and backfills, and how duplicate or late records are handled so reprocessing is safe.
- **Data quality & validation.** The rules records must satisfy, what happens to records that fail (drop, quarantine, dead-letter), and how those failures are surfaced.
- **Latency & throughput targets.** Quantified freshness/SLA and the volume the pipeline must sustain.
- **Lineage & observability contract.** What must be traceable or auditable — which inputs produced which outputs, and what metrics must be exposed.
- **Failure handling.** Partial-failure behavior, checkpointing and recovery guarantees, and dead-letter handling.

## Cautions & conventions

- Specify data contracts and processing guarantees precisely; leave the processing engine and storage to the implementer unless constrained.
- Make **delivery semantics and idempotency explicit and testable** — they are the most-often-underspecified and highest-risk part of a pipeline, and "exactly-once" means very different things depending on the boundary.
- Reference established schema formats (Avro, Protobuf, JSON Schema) and state which governs each boundary.
- Prior-art prompt for research: how do comparable pipelines achieve the required delivery guarantee and handle late or duplicate data?
