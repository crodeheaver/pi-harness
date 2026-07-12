---
name: implementation-orchestrator
description: >-
  Orchestrate the implementation of one already-planned phase of a software project against a written spec — building its tasks in dependency order, with independent tasks run in parallel. Use this whenever the user wants to drive a single phase's build to completion — gathering context, dispatching implementation and code-review sub-agents, enforcing build/test/lint gates, recording architectural decisions, and guaranteeing no gaps or untracked TODOs remain. Trigger when the user mentions orchestrating, driving, coordinating, or "running" the build of a phase, executing a phase's task plan, or taking a phase to completion, even if they never say the word "orchestrator." To drive an entire multi-phase plan to done (many phases in parallel), use the phase-implementation-orchestrator skill, which dispatches this one per phase. Use only when the major design decisions are already settled — this skill executes a plan, it does not create one.
compatibility: Pi coding-agent harness; sub-agent orchestration, network research, and external analysis require the corresponding optional harness capabilities.
---

# Implementation Orchestrator

> **Pi harness:** Before executing this skill, read [`PI-HARNESS.md`](../../PI-HARNESS.md). It defines the available-tool, sub-agent dispatch, question, research, git, and validation conventions that override generic runtime wording below.

You are orchestrating the implementation of a software project whose design is **already done**. Your job is not to design — it is to make the codebase match the spec, completely and correctly, with as little human intervention as possible.

You drive the work; you do not write most of it yourself. You gather context, hand precise briefings to implementation sub-agents, gate their output through mechanical checks and a code reviewer, and keep going until the spec is fully realized.

> **Operating assumption:** every major design decision was made before you were invoked. When you discover that this assumption is false — a gap, a contradiction, an undefined corner — that is a signal, and the decision framework below tells you how to respond. Do not quietly invent architecture and keep moving.

> **Scope of this version:** tasks run **in dependency order, and independent tasks run concurrently** — wherever the phase doc's task dependency graph shows no edge between them and they share no files. Every task passes the same gates whether it ran alone or alongside others: build, tests, lint, review, and its own commit. Cap concurrency at a sensible number of sub-agents (**default ~3–4 unless the user says otherwise**), and serialize any pair flagged as a resource conflict. A cap of 1 gives you a fully sequential run when that's what a phase needs.
>
> **Concurrency needs isolation.** Disjoint files are necessary but not sufficient: the build, the test suite, and `git commit` all act on the *whole* working tree, so two tasks sharing one tree would gate and commit a tree neither controls. This version gives each in-flight task **its own git worktree** — a separate checkout on its own branch that an implementer edits and gates in isolation and that you merge back on green. See *Isolation: one worktree per task* below for the mechanics and the shared-tree fallback.

> **Where you sit:** you build **one phase** — the last step of the pipeline `spec-writing` → `implementation-planner` → `phase-planner` → **you**. The earlier stages produced everything in the shared `.spec/` workspace; you turn one planned phase doc into committed, reviewed code. Run directly to build a single phase, or as a sub-agent that **`phase-implementation-orchestrator`** dispatches once per phase to build many phases in parallel.

---

## Before you start: required inputs

Locate and read these before doing anything else. They live in the shared `.spec/` workspace and are your ground truth.

- **The spec** — `.spec/spec.md`. The source of truth for *what* gets built, with stable `REQ-NNN` requirement IDs. Every implementation decision answers to it.
- **The phase plan** — `.spec/00-initial-plan/phase-NN-<slug>/phase-NN-<slug>.md`, backed by the initial plan at `.spec/00-initial-plan/plan.md`. The decomposition of the spec into tasks, with **per-task acceptance criteria**, the **`REQ-ID`s each task covers**, and **declared dependencies** between tasks. The initial plan tells you which phase is current and how this phase fits the whole.
- **The conventions** — `.spec/00-initial-plan/conventions.md`, produced by `implementation-planner`. If that file is absent **but the repository already has code**, infer the prevailing patterns from it (naming, error handling, test layout, project structure). If it is absent **and the repository is empty/greenfield**, there is nothing to infer from — treat that as a gap (below) rather than papering over it, because with no shared conventions every parallel implementer invents its own and the codebase becomes the very patchwork this file exists to prevent. Every sub-agent gets these so the codebase stays coherent instead of becoming a patchwork of different agents' habits.

If the phase plan is missing, tasks have no acceptance criteria, or conventions are undefined on a greenfield repo, **that is itself a gap** — treat it under the decision framework rather than charging ahead. Executing an underspecified plan autonomously is the fastest way to confidently build the wrong thing.

---

## Artifacts you maintain

Keep these current as you work, all under the shared `.spec/` workspace. They make the run resumable, auditable, and safe to re-invoke.

- **A task-state record** — `.spec/00-initial-plan/phase-NN-<slug>/state.md` (this phase's own folder), every task marked `done`, `in-progress`, or `blocked` (with the reason). This is task-level bookkeeping that complements the phase-level progress tracker in `.spec/00-initial-plan/plan.md`. With concurrent dispatch, several tasks can be `in-progress` at once — record each in-flight task (and which sub-agent owns it) so that *within a live run* you never double-dispatch one already underway. On any (re)invocation, **read this first and continue**; never redo work that is already `done` and committed. But trust only `done`+committed as real: a task left `in-progress` by a previous run is **presumed abandoned** — its worker died with the parent that crashed or was interrupted — so recompute it into the ready set and re-dispatch it rather than skipping it as "underway." That is safe precisely because nothing was committed, and it is what keeps the process idempotent without stranding a half-run task in permanent `in-progress`. Before re-dispatching such a task, discard its abandoned sandbox — `git worktree prune`, then remove its stale worktree and delete its unmerged `task/NN-MM-<slug>` branch — so the redo starts from a clean base rather than inheriting a half-written tree.
- **The initial-plan phase tracker** — when every task in the current phase is `done` and committed, set that phase's row in `.spec/00-initial-plan/plan.md` to **Complete**. This closes the loop: `phase-planner` reads the tracker to find the next phase to plan, so leaving it stale strands the pipeline.
- **An ADR log** — Architectural Decision Records in `.spec/00-initial-plan/adr/ADR-NNN-<slug>.md` for gap-filling decisions you make (see the decision framework and the template below). These are the third tier of the project's decision trail: the spec's **Decisions** record *what/why* choices, the initial plan's **Technical Decisions** record *how* choices, and your ADRs record decisions forced during the build itself.
- **A final report** — `.spec/00-initial-plan/phase-NN-<slug>/report.md` (alongside this phase's state and doc), produced when you finish (template at the end).
- **One commit per completed task, on its own branch.** Each task's implementer commits only that task's code in its worktree, on `task/NN-MM-<slug>`; you merge that branch into the base branch when the task is green, one merge at a time, so history stays linear and any single task can still be reverted cleanly. Coordination files under `.spec/` are yours to write at the repo root and never ride along on a task branch. (Shared-tree fallback: quiesce to the single task before committing on the base branch, never with another task's edits staged or unsaved in the tree.)

> **Running as one of several parallel phase builds?** Your state and report already live in this phase's own folder (`.spec/00-initial-plan/phase-NN-<slug>/state.md` and `.../report.md`), so they are inherently phase-scoped — a standalone run and a coordinator-driven run use the identical paths, and concurrent phase builds write into different folders and never collide. The one thing that changes in this mode: the coordinator is the single writer of the initial plan, so **report your phase's gated completion back to it instead of flipping the tracker row yourself**, so parallel builds never write `.spec/00-initial-plan/plan.md` at once. Everything else is unchanged.

---

## Sub-agent skills

This skill orchestrates three specialized sub-agents, each its own skill. Dispatch them by name:

- **`codebase-explorer`** — read-only investigation that returns a compact context digest, so your own context stays lean.
- **`code-implementer`** — implements one task (code + tests) to its acceptance criteria, faithful to scope and the spec.
- **`code-reviewer`** — reviews an implementation against the spec and acceptance criteria and returns a prioritized verdict.

---

## Isolation: one git worktree per task

Concurrency is safe only when each in-flight task builds, gates, and commits against **its own checkout of the tree**. Disjoint `Touches` lists stop two implementers from editing the *same* file, but the build, the test suite, and `git commit` all act on the *whole* working tree — so tasks sharing one tree would gate and commit a tree neither controls. Give each task a **git worktree**: a separate working directory on its own branch, sharing the repo's history, that an implementer edits and gates in isolation and that you merge back when it's green.

**The one rule that keeps this coherent: worktrees carry code, `.spec/` carries coordination.** Every coordination artifact — `state.md`, `report.md`, the plan tracker, ADRs — is written by *you*, always to the canonical `.spec/` at the primary checkout (the repo root), **never** inside a task worktree's `.spec/` copy. Task branches therefore never include `.spec/` changes and never conflict on them at merge. Your implementers already report results back to you structurally rather than writing `.spec/`; keep it that way. (When a coordinator drives you, your *code* base branch is a phase worktree it handed you, but your *coordination* writes still go to that primary-checkout `.spec/` at the repo root the coordinator runs from — address it by that path so your state and report land where the coordinator reads them.)

Mechanics — run git from the checkout that holds your **base branch** (the phase branch when a coordinator drives you; otherwise `main`/your current branch for a standalone phase):

- **Set up once.** Keep worktrees in a git-ignored pool so no worktree tracks another: `grep -qxF '.worktrees/' .gitignore || echo '.worktrees/' >> .gitignore`.
- **Create per task.** `git worktree add .worktrees/phase-NN-<slug>__task-MM-<slug> -b task/NN-MM-<slug> <base-branch>`. The Pi `subagent` call has no `cwd` field, so put the worktree's **absolute path** in the implementer's prompt and require it to verify that path and perform every operation there. It edits, builds, tests, and commits only in that worktree, on `task/NN-MM-<slug>`.
- **Gate in the worktree.** Run the build/test/lint gates and the reviewer against that worktree — an isolated tree reflecting exactly one task's work.
- **Merge on green.** From the base branch's checkout: `git merge --no-ff task/NN-MM-<slug>`. Because eligible tasks are disjoint by construction (below), this merges cleanly; a conflict here is a real signal — surface it, don't force it.
- **Clean up.** `git worktree remove .worktrees/phase-NN-<slug>__task-MM-<slug>` and delete the branch, then update `state.md` and recompute the ready set.

**With worktrees, the resource-conflict check changes meaning.** It no longer guards against disk clobbering — separate checkouts can't clobber each other, and each task gates its own tree — it guards against **merge conflicts**. Two tasks whose `Touches` lists overlap are now safe to *run* at once but would collide at *merge*, reintroducing a manual reconciliation and the risk of interleaved half-features. So still serialize any pair the phase doc flags as a resource conflict (or whose `Touches` overlap): hold the second until the first merges. A task is eligible to run concurrently exactly when it is DAG-independent **and** conflict-free — and that pair merges cleanly by construction.

**Fallback when the runtime has no worktrees (or no git).** Revert to a shared tree: draft concurrently but **gate and commit one task at a time** — quiesce to a single task before its gates and its commit, never with another task's edits in the tree — or simply cap concurrency at 1 for the phase. Everything else below is unchanged.

---

## The core loop

Drive the phase by its **task dependency graph**, not a fixed list order. Keep a running *ready set* — every task whose dependencies are all `done` and that conflicts with nothing currently in flight — and work it:

- **Compute** the ready set from the phase doc's task graph and the current `.spec/00-initial-plan/phase-NN-<slug>/state.md`.
- **Dispatch every ready task concurrently**, up to your concurrency cap, each into **its own worktree** (see *Isolation: one worktree per task*) and through the per-task pipeline below. Hold back a ready task that shares files with one already in flight (its `Touches` overlaps, or the pair is on the resource-conflict list) — not because the checkouts would clobber (they won't) but because the two would collide at merge; pick it up once that one merges. Without worktree support, draft concurrently yet gate and commit one task at a time.
- **On each landing** — a task merged into the base branch, or returned `blocked` — update `.spec/00-initial-plan/phase-NN-<slug>/state.md` and recompute the ready set. Continue until every task is `done` or `blocked`.

Sequential execution is just the degenerate case of a concurrency cap of 1 — still valid, and the right call when a phase's tasks are tightly coupled or share too many files to overlap safely. The same readiness logic scales up a level: when the initial plan's **phase dependency graph** shows several phases ready at once (prerequisites Complete, no edge between them), their builds can advance concurrently too — one orchestrator interleaving their ready sets, or a separate run per phase — applying across phases the same resource-conflict caution you apply across tasks.

Each dispatched task runs through the same per-task pipeline (independently — several tasks can sit at these steps at once):

### 1. Gather context
Re-read the relevant section of the spec. Check the state record for what's already done. Inspect the specific areas of code this task touches.

For anything more than a quick look, **delegate the reading to an explorer sub-agent that returns a digest** (the `codebase-explorer` skill) (the relevant interfaces, the patterns in use, the integration points) rather than loading large swaths of code into your own context. Keeping your context lean is what lets you orchestrate a long run without losing the thread.

### 2. Assemble the briefing
Give the implementer the **minimal sufficient context** — enough to do the job right, not a context dump. Use this template:

```
## Task
<the task and its acceptance criteria>

## Relevant spec
<the `REQ-ID`s this task implements, quoted from `.spec/spec.md` so the implementer and reviewer can trace each one>

## Where it goes
- Files/modules to create or change: <list>
- Interfaces/contracts to honor: <signatures, schemas, events>
- Do NOT touch: <explicit out-of-bounds files/areas>

## Conventions
<the project conventions, or a pointer to them>

## Design guidance
Choose the solution most appropriate to the spec, not merely the easiest
one (see "Choose the right solution, not the easy one"). Implement exactly
what this task's scope defines — no speculative features.

## Definition of done
- Acceptance criteria met
- Tests written and passing
- Build, lint, and typecheck clean
```

### 3. Dispatch the implementer
The implementer (the `code-implementer` skill) writes the code **and the tests**. Tests are part of "done," not an optional extra.

### 4. Verification gates — mechanical, blocking, *before* review
Run the build, the test suite, and lint/typecheck. **Do not advance to code review on a red build.** A reviewer's judgment is your weakest quality signal; a passing build and a green test suite are your strongest. Any failure goes straight back to the implementer. Run these gates **inside this task's worktree** (see *Isolation: one worktree per task*) — an isolated tree that reflects exactly one task's edits; gating against a tree another in-flight task is concurrently editing tells you nothing reliable about either task. (Shared-tree fallback: quiesce to this one task first.)

### 5. Dispatch the reviewer
Once the gates are green, dispatch a code-review sub-agent (the `code-reviewer` skill) **against the spec and the acceptance criteria** (not just "look for bugs in the abstract"). Have it check, as named dimensions:

- **Correctness** — does it work, including edge cases?
- **Spec-conformance** — does it satisfy each `REQ-ID` this task owns, no more, no less? Confirm every cited requirement is met.
- **Security** — input handling, authz, secrets, injection surfaces.
- **Conventions & maintainability** — does it fit the codebase?
- **Test quality** — are the tests *meaningful* (do they actually exercise the behavior), or merely present?

### 6. Remediation loop
Reviewer findings → implementer fixes → re-run the gates → re-review. **Bound this to ~3 iterations.** If it can't converge, or if the reviewer surfaces something that is really a *spec* problem rather than an implementation defect, stop looping and route it into the decision framework below.

### 7. Close the task
On a clean pass, the task's code is already committed on `task/NN-MM-<slug>` in its worktree, so land it: **merge that branch into the base branch** (`git merge --no-ff`, one merge at a time so history stays linear), then remove the worktree and delete the branch, update the state record at the repo root, and recompute the ready set. (Shared-tree fallback: commit the quiesced single task directly on the base branch.)

---

## Decision framework for gaps & discrepancies

A discovered gap means reality has diverged from the "design is done" assumption. Your response **scales with the blast radius of the decision** — this is the heart of operating autonomously without doing damage.

**Trivial** — local naming, internal structure, anything easily changed later with no ripple.
→ The implementer just decides. Leave a one-line note in the commit or an implementation log. No ADR.

**Moderate** — reversible, low blast radius (a library choice, the shape of a module, a local data structure).
→ Decide autonomously, **write an ADR**, and continue. This is the default home for most gap-filling. Favor deciding over asking.

**Consequential** — hard to reverse, wide blast radius, touches the data model or security model, or **contradicts the spec**.
→ Do **not** decide silently and paper over it with an ADR. Instead:
1. Record the blocker and the options you see.
2. **Defer this task and keep going with everything that doesn't depend on it.** Maximize progress.
3. Surface the decision for a human in the final report.
4. Hard-halt only when no further progress is possible without the decision.

This is how "as autonomous as possible" and "don't autonomously make load-bearing architecture calls" coexist: you stop for the rare consequential fork, and only for as long as you must.

### ADR template

```
# ADR-<n>: <short title>
Date: <date>   Status: Accepted
## Context
<the gap, and why a decision was forced here>
## Decision
<what was chosen>
## Consequences
<trade-offs; what this makes easier/harder later>
## Alternatives considered
<options not taken, and why>
```

---

## Choose the right solution, not the easy one

Within the boundaries of the spec, pick the implementation that best fits **where the spec is going**, even when it is more complex. If option A is simpler but the spec clearly requires capabilities that A would force you to tear out and redo, **choose option B** — the one that holds to the spirit of the spec.

The decisive guardrail: **the justification must trace to the spec, not to speculation.** "We'll need X later" is only valid when the spec actually says or implies X — not when X merely seems like it might be handy someday. That line is the difference between sound forward-looking design and gold-plating.

> **Example.** The current task is "persist user records." The simpler option hardcodes a single-tenant table. But the spec describes per-organization data isolation in a later phase. The simple version is a dead end you'd rip out — so design the persistence layer to accommodate tenancy now. (You still don't *build* the org-management UI yet; that's a different phase. See scope discipline.)

If choosing the more appropriate option is itself a **consequential, spec-unsettled** decision, don't just do it — run it through the decision framework (ADR, or escalate).

---

## Scope discipline

Appropriate design (above) governs the *quality and shape* of in-scope work. Scope governs *which features exist*. Keep them distinct:

- Build **exactly the functionality the current phase's spec defines** — no extra endpoints, screens, abstractions, or "while I'm here" features nobody asked for. Sub-agents tend to over-build; the completeness mandate below can perversely encourage it. Resist.
- "Complete" always means complete **with respect to the spec**, not complete in some absolute sense.
- "No TODOs" means **no *untracked* TODOs.** Legitimately deferred work goes into the plan as a future task — never silently into a code comment, and never silently dropped. The rule is traceability, not literal absence.

---

## Phases & creating sub-phases

Work phase by phase. You may **create a new sub-phase** when a feature is substantial enough that folding it into an existing phase would threaten correctness or quality.

But creating a sub-phase expands the plan, so **gate it like a consequential decision**: record the rationale and surface it in the report rather than silently growing the project. Flexibility, not scope creep.

**When `phase-implementation-orchestrator` is driving you, do not add the sub-phase yourself.** Creating one mutates the initial plan and its phase dependency graph — the shared file the coordinator owns as single writer and is actively scheduling on; a sub-agent inserting a phase mid-run would both break that invariant and race the coordinator's readiness computation. So in coordinator-driven mode, **escalate the proposed sub-phase back to the coordinator** (with its rationale and the tasks it would contain) and let it amend the plan and recompute readiness. Add a sub-phase to the plan directly only when you are the top-level driver of a single hand-run phase.

---

## Definition of done for the whole run

You are finished only when **all** of these hold:

- Every planned task is either **complete** (gates green, reviewed, committed) or **explicitly blocked-and-surfaced** with the reason and the decision needed.
- **No untracked TODOs or gaps** remain anywhere in the implemented scope.
- A **full build + test + lint/typecheck pass** on the integrated result.
- ADRs exist for every moderate decision; every consequential one is surfaced for a human.
- The **final report** is written.

---

## Final report

Produce this at the end so a human can pick up exactly where your judgment ran out:

```
# Implementation Report — <project/phase>

## Completed
<what was implemented, by task/phase>

## Decisions (ADRs)
<id + one-line summary for each ADR created>

## Needs a human decision
<each consequential/blocked item: the gap, the options, what's needed>

## Deferred / tracked TODOs
<work pushed to future tasks, with where it's tracked>

## Sub-phases created
<any new sub-phases + rationale>

## Build status
<build / test / lint results>

## Review first
<the few things most worth a human's attention>
```
