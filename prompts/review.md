---
description: Review current changes for actionable defects
argument-hint: "[focus]"
---
Review the current working-tree and staged changes. Focus especially on: ${ARGUMENTS:-correctness, security, error handling, compatibility, and missing tests}.

Read enough surrounding code to verify each finding. Present actionable findings first in severity order with precise file references and concrete failure scenarios. Do not modify files unless explicitly asked after the review.
