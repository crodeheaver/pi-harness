---
name: code-review
description: Reviews a working-tree diff, staged changes, commit, or requested files for correctness, security, maintainability, and missing tests. Use when asked for code review or before finalizing a risky change.
---

# Code Review

Review behavior, not formatting preferences.

## Procedure

1. Establish the intended behavior and review scope.
2. Read the complete diff and enough surrounding code to understand contracts and callers.
3. Check for:
   - incorrect logic, edge cases, and error handling
   - security, authorization, secret handling, and injection risks
   - races, resource leaks, and destructive behavior
   - compatibility and migration concerns
   - missing or misleading tests
4. Validate suspected findings against the actual code. Do not report speculative issues as facts.
5. Rank findings by impact and include precise file/line references and a concrete failure scenario.

## Output

Present findings first, highest severity first. Keep summaries brief. If no actionable findings remain, say so and identify residual validation gaps.
