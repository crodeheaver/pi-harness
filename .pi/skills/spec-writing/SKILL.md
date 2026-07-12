---
name: spec-writing
description: >-
  Produce an implementation-ready specification for a software project from a high-level idea, acting as the subject-matter expert who fleshes out the details and makes reasoned decisions so the user only has to supply intent. Use whenever the user wants to write, draft, create, plan, design, or "spec out" a spec, design doc, PRD, requirements doc, or technical specification — including for APIs and services, programming languages, compilers, interpreters, DSLs, operating systems, kernels, game engines, runtimes, drivers, libraries/SDKs, data pipelines, command-line tools, or clean-room reverse-engineering efforts. Trigger this even when the user just describes an idea and asks to plan or design it before building, and especially when the resulting spec will be handed to AI agents to implement. This skill produces the spec itself; turning a finished spec into a technical or phased implementation plan (tech stack, phases, sequencing) is the implementation-planner skill.
compatibility: Pi coding-agent harness; sub-agent orchestration, network research, and external analysis require the corresponding optional harness capabilities.
---

# Spec Writing

> **Pi harness:** Before executing this skill, read [`PI-HARNESS.md`](../../PI-HARNESS.md). It defines the available-tool, sub-agent dispatch, question, research, git, and validation conventions that override generic runtime wording below.

Turn a high-level idea into a specification an AI agent can implement accurately. The user supplies the goal and intent; **you act as the subject-matter expert** — you flesh out the details, make the reasonable engineering decisions, and produce a spec that is precise enough to build from. The user reviews and adjusts before it is final.

The output describes **what** the thing must do and **why**, not **how** it is built internally. It stays implementation-agnostic (no language, framework, or tech-stack mandates) except where a choice is a genuine externally-imposed constraint.

## What you produce

A single specification file at **`.spec/spec.md`** — the first document in a shared `.spec/` workspace that every later stage reads and writes. The downstream skills depend on it by name: `implementation-planner` reads `.spec/spec.md` to build the technical plan, and the requirement IDs you assign here (`REQ-NNN`) are the key that the initial plan's traceability matrix, the phase docs, and the implementation reviewer all reference. Lock those IDs and your terminology before handoff so the chain stays stable end to end.

## Core principles

- **Specify the contract, not the internals.** The contract is anything observable from outside or that two components must agree on: behavior, inputs/outputs, interfaces, data shapes, error semantics, guarantees. The internals are how a single component achieves that: data structures, algorithms, frameworks, file layout. Specify the first; leave the second to the implementer. "No implementation details *unless necessary*" resolves to exactly this line.
- **Name a technology only when it is a real constraint.** If the thing must run on existing Postgres, or target a specific ISA, that is part of the spec — tag it `[Constraint: <reason>]`. Otherwise, stay silent on tech and let the implementer choose.
- **Every requirement is testable.** Pair each one with acceptance criteria. If you cannot write a pass/fail check for a requirement, it is too vague — sharpen it until you can.
- **Write for an AI implementer.** Be unambiguous. Use requirement levels (MUST / SHOULD / MAY). Define every domain term in a glossary and use it consistently. Ban vague adjectives ("fast," "intuitive," "robust") unless quantified — agents take ambiguity literally and will fill the gap with a guess.
- **Surface every decision; bury nothing.** When you make a call the user might have made differently, it goes in the Decisions section with a one-line rationale — not hidden in prose. This is what makes the user's review fast and meaningful. These are *product-level* decisions; downstream the same surface-every-call discipline recurs at finer grain — `implementation-planner` logs **Technical Decisions**, and `implementation-orchestrator` logs **ADRs**.
- **Right-size to the project.** Depth scales with complexity and risk. Omit sections that genuinely do not apply (and say so) rather than padding. A small feature should not get a kernel-sized spec.
- **Act like the expert.** Decide craft and structure yourself. Ask the user only what they alone know — intent, priorities, and constraints. When their idea contains a contradiction, gap, or infeasibility, name it and propose options rather than nodding along.
- **Do not bluff.** In deep domains (kernel ABIs, language semantics, protocol formats), ground specific claims in research. Where your knowledge is genuinely thin, flag it as an Open question or Assumption instead of inventing detail.

## Workflow

> **Sub-agents are part of this workflow.** Run the **Research** (phase 2) and **Review** (phase 4) phases as dedicated sub-agents — a separate, clean context catches more and keeps the main thread legible. Spawn each with the matching skill: `spec-research` for phase 2 and `spec-review` for phase 4. You supply their inputs and consume their structured output; you do not do their work in the main thread.

1. **Intake & interview.** Restate the goal in your own words. If a material ambiguity remains, use Pi's `ask_user` for one structured, high-leverage decision at a time (see *The interview*); do not ask for routine confirmation.
2. **Research — verify before you assert.** Spawn a research sub-agent directed to use the **`spec-research`** skill. Give it the project type and your list of claims and unknowns (anything version-specific, domain-specialized, or where prior art should inform the design). Fold its verified facts into the draft and turn its unverifiable items into Open questions. Skip this phase only when the project is genuinely within common knowledge.
3. **Draft.** As SME, write the spec using the **universal spine** below plus the matching **project-type module(s)** from `references/`. Make the decisions; log each one in the Decisions section as you go.
4. **Consistency & accuracy review.** Spawn a review sub-agent (fresh context) directed to use the **`spec-review`** skill, and give it the draft. It returns a categorized, severity-ranked issue list; apply the fixes, blockers first. Re-run it if you made large changes.
5. **User review gate.** Present the spec with **Decisions, Assumptions, and Open questions visible up top** so the user can sanity-check your choices quickly. Ask targeted questions only where their answer would actually change the spec. Iterate on their feedback.
6. **Finalize and hand off.** Resolve the remaining open questions or mark them explicitly deferred. Lock terminology and requirement IDs so downstream references stay stable, then write the spec to **`.spec/spec.md`**. From there the **`implementation-planner`** skill takes over — it reads `.spec/spec.md` and turns *what* into *how*. Spec-writing makes no technical decisions; the planner owns those.

## The interview

Cover these dimensions — but **ask only what you cannot reasonably decide yourself**:

- Problem & motivation — what pain does this remove, and why now?
- Users / consumers — who or what uses it (people, calling systems, other components)?
- Success criteria — what does "done and good" look like, and how is it measured?
- In-scope capabilities — what must it do?
- Non-goals — what will it explicitly *not* do? (People under-specify this; probe it actively.)
- Hard constraints — platforms it must run on or integrate with, performance/latency/footprint budgets, compliance, deadlines.
- Failure modes — what should happen on the unhappy path?
- Conformance — existing systems, formats, or standards it must match.

**Rules of the interview.** Ask only questions that materially change the spec. Pi's `ask_user` accepts one structured question per call, so offer distinct actionable options and allow a custom answer instead of emulating a Claude-style multi-question batch. Reflect understanding back before drilling deeper. When the idea contains a contradiction or infeasibility, name it and offer options. If the user defers ("you decide"), decide it and log the decision rather than re-asking.

## Universal spec spine

Always produce these sections (drop one only if truly N/A, and say so explicitly):

```
# <Title>
Summary            — one paragraph: what this is and who it serves.
Problem & motivation
Goals & success metrics
Non-goals          — explicit, list form.
Users / consumers
Functional requirements   — IDs + levels + acceptance criteria (format below).
Interfaces & contracts    — the externally-observable surface only.
Data model / key entities — if any; fields, types, units, invariants.
Constraints        — each tagged with its source/reason.
Edge cases & error handling
Decisions          — choices you made, each with a one-line rationale.
Assumptions        — things taken as given.
Open questions     — what still needs the user or further research.
Glossary           — every domain term, defined once.
```

## Requirement format

One requirement = one verifiable behavior.

```
REQ-001 (MUST) — <single, testable statement>
  Rationale: <optional — why this exists>
  Acceptance:
    - Given <context>, when <action>, then <observable result>
    - <or a checklist of objectively verifiable conditions>
```

Use MUST for hard requirements, SHOULD for strong defaults that may be traded off with justification, MAY for genuine options. If a requirement has no acceptance check, it is not yet a requirement.

## Choosing project-type modules

After drafting the spine, read the matching reference file(s) and fold their sections in:

- API or networked service → `references/api-and-services.md`
- Programming language, compiler, interpreter, or DSL → `references/programming-languages.md`
- Operating system, kernel, game engine, runtime, driver, or embedded/firmware → `references/systems-software.md`
- Reusable library, package, or SDK that other code depends on → `references/libraries-and-sdks.md`
- Data pipeline, ETL job, or batch/stream processing → `references/data-pipelines.md`
- Command-line tool or CLI → `references/cli-tools.md`
- Clean-room reverse engineering of any of the above → `references/reverse-engineering.md` (combine it with the module for the artifact type)

If the project fits none of these, build an equivalent module from first principles using the same pattern each file follows: *What is the externally-observable contract? What are the failure modes? What conventions or standards already exist? What must remain open for the implementer?*

## Quality checklist

Run this before presenting; it is also the basis for the review sub-agent.

- [ ] Every requirement has acceptance criteria.
- [ ] Requirement IDs are unique and stable, and nothing references a missing ID — these IDs are the key the whole downstream pipeline traces against, so lock them before handoff.
- [ ] No requirement names a technology unless tagged as a genuine constraint.
- [ ] Non-goals are explicit.
- [ ] Every defined term is used consistently and appears in the Glossary.
- [ ] No two requirements contradict each other.
- [ ] Every decision you made is logged with a rationale.
- [ ] Vague adjectives are quantified or removed.
- [ ] Specific technical claims are backed by research or flagged as assumptions.
- [ ] Depth matches the project — no padding, no gaps.
- [ ] A competent implementer could build it without contacting the author for missing *intent*; anything genuinely unknown lives in Open questions, not as a silent guess.

## The phase skills

Research and review are their own skills so a sub-agent can load each directly. Spawn the sub-agent, point it at the skill, and hand it the inputs below; it returns structured output you fold back in.

- **`spec-research`** — the research arm. Inputs: the project type + your list of claims and unknowns. Returns verified facts (each with a source), recommended conventions and standards, a prior-art summary, and a list of items it could not verify. It supplies grounded inputs; it does not design the spec.
- **`spec-review`** — the QA arm, run with a fresh context. Input: the draft spec. Returns issues grouped by category with location, suggested fix, and severity, plus a ready / needs-revision verdict. It audits and reports; it does not rewrite.

Both skills carry their own copies of the relevant rubric, so they are self-contained when invoked.
