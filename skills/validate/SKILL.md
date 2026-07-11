---
name: validate-change
description: Determines and runs focused validation for code changes, including formatting, linting, type checks, tests, builds, and diff inspection. Use after implementation or when asked to verify a repository change.
---

# Validate Change

Validate the change with evidence, not assumptions.

## Procedure

1. Inspect repository guidance and package/build configuration to discover canonical commands.
2. Inspect the changed-file list and diff. Do not broaden validation blindly.
3. Run the cheapest relevant checks first:
   - formatter or format check for touched files
   - focused linter/type checker
   - nearest unit or integration tests
   - broader build/test only when justified
4. If a check fails, determine whether it is caused by the change. Fix in-scope regressions; report unrelated failures distinctly.
5. Re-inspect the final diff for accidental generated files, debug output, secrets, and scope creep.

## Report

List each command run and its result. State what was not run and why. Never claim that a check passed unless it actually ran successfully.
