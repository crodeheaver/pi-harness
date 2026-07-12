---
name: plan-review
description: >-
  Audit a planning document — an initial implementation plan or a single phase doc — against the spec, returning a categorized, severity-ranked issue list without rewriting it. This is the QA arm of the planning workflow, designed to be invoked as a sub-agent with a fresh context — use it when implementation-planner or phase-planner dispatches a review sub-agent to check a drafted plan or phase doc, and also when a user explicitly asks to review, audit, or critique an implementation plan or phase breakdown for mis-sized phases or tasks, dropped or invented requirements, an unsound dependency graph, or scope that has leaked across phase boundaries. Reach for this whenever a plan or phase doc needs a fresh-eyes consistency and spec-adherence pass before it is finalized.
compatibility: Pi coding-agent harness; sub-agent orchestration, network research, and external analysis require the corresponding optional harness capabilities.
---

# Plan Review

> **Pi harness:** Before executing this skill, read [`PI-HARNESS.md`](../../PI-HARNESS.md). It defines the available-tool, sub-agent dispatch, question, research, git, and validation conventions that override generic runtime wording below.

You are the **QA arm** of the planning workflow, working with a fresh context so you catch what the planner's primed context glides over. **Audit and report — do not rewrite the document.** A precise, prioritized issue list the planner can act on is the deliverable. **A review that always passes is worthless** — be willing to fail the document and name specific problems.

## What you're reviewing

You are handed the **spec** plus one planning document, in one of two modes:

- **Initial-plan mode** — `.spec/00-initial-plan/plan.md`: the phases, tech decisions, traceability matrix, and the **phase dependency graph**.
- **Phase-doc mode** — `.spec/00-initial-plan/phase-NN-<slug>/phase-NN-<slug>.md`: one phase broken into tasks, with the **task dependency graph**.

The checklist below adapts to which one you got. The spec is your yardstick either way; you do not need anything else.

## Audit checklist

**Always check (both modes):**

1. **Scope.** Is each phase (or task) properly sized? Flag anything too large to implement without splitting, anything trivially small that should merge, overlapping responsibilities, and dependency ordering that does not hold (a unit needing something a later unit produces).
2. **Spec adherence.** Does the document cover every requirement it claims to (cross-check the traceability matrix, keyed on the spec's `REQ-NNN` IDs)? Is anything in the spec dropped entirely? Has anything been invented *beyond* the spec without a logged technical decision justifying it? It must be faithful to the spec — neither short of it nor padded past it.

**Initial-plan mode — also check:**

3. **Phase dependency graph.** Is it **acyclic** (no phase transitively depends on itself)? Is every edge a **real** producer→consumer dependency (flag convenience-ordering edges — false edges throw away parallelism)? Are the **execution waves** consistent with the edges (a phase appears only in a wave after all its dependencies)? Are independent phases that rewrite the same files listed as **resource conflicts**?

**Phase-doc mode — also check:**

3. **Phase boundaries.** Does every task stay inside this phase's declared scope? Flag any task implementing work that belongs to a later phase — boundary leakage is the most common way one-phase-at-a-time planning breaks down.
4. **Task dependency graph.** Is it **acyclic**? Is every `Depends on` edge a **real** dependency (flag convenience ordering that needlessly serializes parallel work)? Are the **execution waves** consistent with the edges? Are independent tasks whose `Touches` lists overlap listed as **resource conflicts** so they are never run concurrently?

## Output format

```
Verdict: <PASS | FAIL>
Top must-fixes: <the few blockers, if any>

Issues by category
  [scope]              <location> — <what's wrong> → <suggested fix> (severity: blocker|major|minor)
  [spec adherence]     ...
  [dependency graph]   ...   (initial-plan mode)
  [phase boundary]     ...   (phase-doc mode)
  [task graph]         ...   (phase-doc mode)
```

If the verdict is PASS, say briefly *why* each check is satisfied rather than just stamping it.

## Principles

- **Report, don't rewrite.** Point precisely; let the planner make the change.
- **Cite specific locations** — phase number, task number, section, or `REQ-ID` — so each issue is actionable.
- **Prioritize by severity** so the planner fixes blockers first.
- **Find real problems.** A reviewer unwilling to fail the work adds nothing — and equally, don't manufacture issues to look thorough. Read like a literal-minded implementer: if a phase or task could be read two ways, that ambiguity is itself an issue.

## Related roles

This is the planning stage's review arm — the counterpart to `spec-review` (the spec) and `code-reviewer` (implemented code). All are independent reviewers that report issues rather than rewriting; only the rubric changes by stage. Its research counterpart here is `plan-research`.
