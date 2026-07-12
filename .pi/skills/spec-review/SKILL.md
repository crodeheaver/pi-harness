---
name: spec-review
description: >-
  Audit a specification draft for consistency, testability, completeness, and leaked implementation detail, returning a categorized, severity-ranked issue list without rewriting it. This is the QA arm of the spec-writing workflow, designed to be invoked as a sub-agent with a fresh context — use it when a review or QA sub-agent is dispatched to check a draft spec, and also when a user explicitly asks to review, audit, or critique a specification, design doc, or requirements doc for contradictions, untestable requirements, missing non-goals, undefined terms, or implementation detail that should not be there. Reach for this whenever a spec draft needs a fresh-eyes consistency and accuracy pass before it goes to the user.
compatibility: Pi coding-agent harness; sub-agent orchestration, network research, and external analysis require the corresponding optional harness capabilities.
---

# Spec Review

> **Pi harness:** Before executing this skill, read [`PI-HARNESS.md`](../../PI-HARNESS.md). It defines the available-tool, sub-agent dispatch, question, research, git, and validation conventions that override generic runtime wording below.

You are the **QA arm** of a spec-writing effort, working with a fresh context so you catch what the author's primed context glides over. **Audit and report — do not rewrite the spec.** A precise issue list the author can act on is the deliverable.

## Input you receive

The draft spec. (The audit checklist below is self-contained; you do not need anything else.)

## Audit checklist

Check the draft against every item and record each failure:

- [ ] Every requirement has acceptance criteria that are objectively pass/fail.
- [ ] Requirement IDs are unique and stable; nothing references a missing ID.
- [ ] No requirement names a technology (language, framework, library, storage) unless it is tagged as a genuine external constraint.
- [ ] Interfaces and contracts describe only the externally-observable surface, not internal mechanics.
- [ ] Non-goals are explicit, not merely implied.
- [ ] Every domain term is defined once, used consistently, and present in the glossary.
- [ ] No two requirements contradict each other.
- [ ] Every decision the author made is logged with a rationale.
- [ ] Vague adjectives ("fast," "intuitive," "robust") are quantified or removed.
- [ ] Specific technical claims are backed by research or flagged as assumptions.
- [ ] Each major capability has its edge cases and failure behavior covered.
- [ ] Depth matches the project — no padding, no gaps.
- [ ] An implementer could build it without contacting the author for missing *intent*; anything genuinely unknown lives in Open questions rather than as a silent guess.

## Output format

```
Verdict: <ready | needs revision>
Top must-fixes: <the few blockers, if any>

Issues by category
  [contradiction]            <location / REQ-ID> — <what is wrong> → <suggested fix> (severity: blocker|major|minor)
  [untestable requirement]   ...
  [missing/implicit non-goal] ...
  [undefined/inconsistent term] ...
  [leaked implementation detail] ...
  [unflagged decision]       ...
  [unsupported claim]        ...
  [coverage gap]             ...
```

## Principles

- **Report, don't rewrite.** Point precisely; let the author make the change.
- **Cite specific locations** — section name or requirement ID — so each issue is actionable.
- **Prioritize by severity** so the author fixes blockers first.
- **Read like a literal-minded implementer.** If a sentence could be read two ways, that ambiguity is itself an issue — flag it.

## Related roles

This is the spec stage's review arm. The same fresh-context audit recurs downstream: plan and phase docs are checked by the `plan-review` skill, and implemented code is checked by the `code-reviewer` skill. All are independent reviewers that report issues rather than rewriting — only the rubric changes by stage.
