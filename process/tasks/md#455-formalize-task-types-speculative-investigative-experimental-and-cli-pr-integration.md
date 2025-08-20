# Formalize Task Types (Speculative/Investigative/Experimental) and Explore CLI/PR Integration

## Status
TODO

## Priority
MEDIUM

## Category
RESEARCH / ARCHITECTURE

## Context

Many tasks in this project are explicitly marked as SPECULATIVE, INVESTIGATIVE, and EXPERIMENTAL, producing research/documentation only (no code). This pattern should be captured explicitly in the task system as a first-class attribute ("task type"), with potential alignment to conventional-commit semantics and our `session pr` requirements for commit/PR types.

We should investigate:

- Whether to add a `task_type` field (e.g., `research`, `speculative`, `investigative`, `experimental`, `implementation`, `refactor`, `docs`, etc.) to task metadata
- How this type maps to PR types (`feat`, `fix`, `docs`, `refactor`, etc.) and whether predeclaring task type informs later PR creation
- If existing taxonomies or standards exist that we can reuse rather than inventing our own
- How to enforce “no code” outputs for certain types (policy-level, not code implementation in this task)

## Objectives

1. Survey existing approaches for labeling/typing tasks and linking them to PR types (conventional commits, Linear/Clubhouse/Issue labels, GitHub Issue types).
2. Propose a minimal taxonomy for task types suitable for this repository and workflows (e.g., `research`, `design`, `implementation`, `refactor`, `docs`, `test`, `chore`).
3. Specify where task type would live (task spec frontmatter/metadata DB) and how it propagates to CLI flows and `session pr` creation.
4. Define guardrails for types like `research`/`speculative` to ensure they yield documentation-only outputs (no code) unless explicitly converted to an implementation task.
5. Provide a migration/compatibility plan for existing tasks without types.

## Scope

Research/documentation only. No code changes or schema migrations in this task.

## Research Questions

- What existing taxonomies or standards are commonly used (e.g., conventional commits, GitHub issue types/labels)?
- Should task type be a single value or allow multiple facets (e.g., `kind=research`, `output=docs-only`)?
- How should type interact with task statuses (TODO/IN‑PROGRESS/IN‑REVIEW/DONE/CLOSED)?
- How should `session pr create --type` be informed or constrained by task type?
- How do we minimize friction while maximizing clarity and enforcement?

## Deliverables (Research Only)

1. A concise taxonomy proposal with definitions and examples.
2. A data placement proposal (where to store task type) and CLI interaction sketch.
3. Policy recommendations for docs-only research tasks (validation/guardrails, not implementation).
4. A follow-up implementation plan split into small tasks (schema, CLI, validations, docs).

## Dependencies / Related Work

- `md#413`: Conventional-commit title generation for `session pr create`.
- `md#407`, `md#315`: DB/metadata foundations if we later persist type in DB.
- `md#327`: Messaging/conversation model may use type hints for thread policies.

## Out of Scope

- No code or schema implementation; this task outputs research only.


