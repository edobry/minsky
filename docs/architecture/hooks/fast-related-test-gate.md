# Fast Changed-File-Scoped Related-Test Pre-Commit Gate

> Extracted from `.minsky/rules/hook-files.mdc` (mt#2620 pattern) — full rationale,
> design decisions, and cross-references for this hook/guard. The compiled rule
> corpus carries only a terse index entry; this file is the durable detail.

A step in the pre-commit pipeline (`src/hooks/pre-commit.ts`'s "Runtime checks
(tests)" section, after secret scanning and before the niche ESLint-rule
tooling tests) runs only the tests **related to the staged/changed files** and
blocks the commit if any of them fail or the run looks truncated. Like the
NUL-byte, deploy-domain, and immutable-migration guards documented elsewhere
in this file, this is a true git pre-commit step run by the `PreCommitHook`
TypeScript class invoked from `.husky/pre-commit` — not a Claude Code
PreToolUse hook.

## Why this exists (mt#2932, complementing mt#2716)

mt#2716 moved the full unit suite (~8300 tests, ~4.3 min) out of pre-commit
into `.husky/pre-push` + CI (`scripts/run-tests-gated.ts`) — a per-commit gate
that slow is the documented "slow hook → developers `--no-verify` it → worse
than no hook" anti-pattern. That left a real gap: **zero automated test
signal at commit time**. The community middle ground for this gap is running
only the tests related to changed files (`jest --findRelatedTests`, `vitest
related`, lint-staged) — `bun test` has no native equivalent, so this gate
builds one.

## Pipeline

1. **Mapping layer** (`scripts/find-related-tests.ts`) — given the
   staged/changed files (`git diff --cached --name-only --diff-filter=ACM`),
   returns the related `*.test.ts` files via two heuristics:
   - **Sibling test** — `src/foo/bar.ts` changed → `src/foo/bar.test.ts` (if it
     exists) is related. A changed test file is related to itself.
   - **Bounded reverse-dependency-graph walk** — builds a regex-based (not
     AST) import graph over the same file scope `scripts/run-tests-main.ts`
     uses (`ROOTS` minus `EXCLUDE_DIR_PREFIXES`), then BFS-walks the REVERSE
     edges (importers) from each changed file up to `maxDepth` hops (default
     6). Any test file reached this way — because it imports the changed
     file, or imports something that transitively does — is related too.
   - Both `@minsky/domain/*` / `@minsky/shared/*` bare-specifier imports
     (resolved via each package's `package.json` `exports` map, including
     wildcard patterns) and relative imports are resolved.
   - All filesystem access is routed through an injectable `FsLike`
     interface (default: real `node:fs`) so tests use an in-memory mock
     (`createMockFilesystem`) instead of touching disk, per
     `eslint-rules/no-real-fs-in-tests.js`.
2. **Fast runner** (`scripts/run-related-tests.ts`) — runs only the related
   tests found above:
   - **Zero related tests** → exit 0 (nothing to run locally; this is a fast
     _signal_, not exhaustive coverage — the full suite at push time + CI
     remains authoritative).
   - **More than `RELATED_TEST_CAP` (40) related tests** → exit 0 with a
     warning instead of running them. A widely-imported low-level module
     (e.g. a shared logger) can otherwise pull a large fraction of the suite
     into the reverse-dependency-graph walk, defeating the "fast" purpose of
     this gate; rely on the pre-push/CI full-suite gate for that case.
   - Any related test under `src/mcp/**` runs in its own isolated `bun test`
     process, mirroring `scripts/run-tests-mcp-isolated.ts` — per mt#2665,
     `src/mcp` test files are known to silently truncate when run in
     combination with other files.
   - **Fail-closed gating REUSES** `evaluateBunTestSummary` from
     `scripts/run-tests-gated.ts` (the mt#2716 gate) — not a
     reimplementation. A silently truncated related-test run (exit 0, no
     "Ran N tests across M files" completion summary) fails this gate
     exactly like it fails the full-suite one.
3. **Pre-commit wiring** (`src/hooks/pre-commit.ts`'s `runFastRelatedTests()`,
   delegating spawn+capture to `src/hooks/related-tests-check.ts`) — spawns
   `scripts/run-related-tests.ts` and blocks the commit on a non-zero exit
   code.

## Measured latency

`bun scripts/run-related-tests.ts packages/domain/src/rules.ts` (a
moderately-central domain file): 16 related test files found (sibling +
transitive importers via the graph walk), 166 tests run, ~3.1s wall time —
well under the 60–90s bypass-risk threshold this gate targets. A narrower
single-sibling-test case (`packages/domain/src/rules.ts` before the
reverse-dependency-graph fix landed) completed in ~1.0s.

## Override mechanism

Set `MINSKY_SKIP_RELATED_TESTS=1` (or `true` / `yes`) before committing:

```bash
MINSKY_SKIP_RELATED_TESTS=1 minsky session commit ...
```

The override emits an audit-log line to stdout naming the env-var value and
the ISO timestamp — the full-suite gate at push time (`.husky/pre-push`) and
CI remain the authoritative backstop regardless of this override, so skipping
here never lets a genuine regression merge unnoticed.

**Env-var registration:** `MINSKY_SKIP_RELATED_TESTS` is registered in
`HOOK_ONLY_ENV_VARS` at
`packages/domain/src/configuration/sources/environment.ts` so the
env-var-to-config dot-path parser skips it at boot (per the
`custom/no-unregistered-minsky-env-var` ESLint rule from mt#1788).

## Design tradeoffs (documented, not silently applied)

- **Regex-based import scanning, not a full TS/AST parse.** Meant to be fast
  (a pre-commit-time budget), not exhaustive. Under-inclusion (a related test
  the graph walk misses) is an accepted risk because the mt#2716 full-suite
  gate remains the authoritative backstop; over-inclusion only costs a
  little extra local runtime, not correctness.
- **Bounded BFS depth (default 6) + a total related-test-count cap (40).**
  Both exist to keep this gate fast even when a changed file sits near the
  root of a large dependency fan-in (e.g. a shared utility).
- **`src/mcp/**`exclusion from the reverse-dependency-graph scope** mirrors`scripts/run-tests-main.ts`'s own exclusion (mt#2665 truncation risk). A
directly-changed `src/mcp/\*.ts` file's sibling test is still found (the
  sibling heuristic operates on the changed-file path directly, independent
  of the graph scope) and runs isolated per mt#2665's established mitigation.

## Cross-references

- mt#2932 — this gate's tracking task
- mt#2716 — parent/sibling task (moved the full suite to pre-push + CI, built
  `scripts/run-tests-gated.ts` and its `evaluateBunTestSummary` fail-closed
  gate, reused here rather than reimplemented)
- mt#2665 — `src/mcp` test-truncation investigation (`scripts/run-tests-main.ts`
  exclusion list, `scripts/run-tests-mcp-isolated.ts` per-file isolation)
  this gate's scope and mcp-isolation split both mirror
- mt#1788 — ESLint rule + `HOOK_ONLY_ENV_VARS` (env-var registration)
- `docs/testing-patterns.md` — broader testing-tier documentation this gate
  is a tier of
- `eslint-rules/no-real-fs-in-tests.js` — the rule that motivated this
  module's injectable `FsLike` design
