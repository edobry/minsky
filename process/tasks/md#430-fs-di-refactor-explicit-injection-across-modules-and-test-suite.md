# FS DI refactor: explicit injection across modules and test suite

## Context

Goal: Replace module-level fs mocking with explicit dependency injection across the codebase and tests.

Scope:
- Introduce an `FsLike` interface (readFile, writeFile, mkdir, readdir, stat, unlink, rm, access) and a factory for real- and mock-fs implementations.
- Thread fs dependencies via constructors/factories for modules that perform filesystem I/O (e.g., taskIO, markdownTaskBackend, config sources, session path resolver, etc.).
- Update tests to pass a concrete mock FsLike explicitly, eliminating reliance on `mock.module("fs", ...)`.

Research & Tradeoffs:
- Compare explicit DI vs. module-level mocking:
  - Test isolation and determinism
  - Tooling (type checking, tree-shaking) and readability
  - Performance and ergonomics (boilerplate vs. clarity)
  - Compatibility with `no-dynamic-imports` rule and how to structure DI without dynamic import
- Document migration strategy and minimal disruption path (adapters, facades, codemods if needed).

Deliverables:
- Design doc outlining the DI approach, API surface of `FsLike`, and integration plan.
- Proof-of-concept patch for one subsystem (tasks) + updated tests.
- Rollout checklist for migrating remaining subsystems.

Acceptance Criteria:
- PoC tests run with explicit fs injection and no `mock.module("fs", ...)`.
- Documentation of tradeoffs and recommended approach approved.
- Backward-compatible adapter available to incrementally adopt.


## Requirements

## Solution

## Notes
