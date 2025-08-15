# Enforce conventional-commit title validation on session pr edit

## Context

Investigate and fix missing conventional-commit title validation for session pr edit.\n\nProblem\n- session pr create enforces conventional-commits title validation\n- session pr edit appears to bypass the same validation, allowing invalid titles\n\nRequirements\n- Apply the same title validation path to pr edit as pr create (shared validator/middleware)\n- Block invalid titles with clear guidance (e.g., "feat(scope): ...")\n- Tests: unit + end-to-end for both create/edit; include positive/negative cases\n- Keep --no-status-update behavior intact; validation should run regardless\n\nAcceptance Criteria\n- Editing a PR with an invalid title fails with a helpful error\n- Editing a PR with a valid conventional-commit title succeeds\n- pr create behavior remains unchanged; shared logic verified\n\nNotes\n- Ensure compatibility with current PR title generation rules (md#308)\n- Document behavior in command help and developer docs\n

## Requirements

## Solution

## Notes
