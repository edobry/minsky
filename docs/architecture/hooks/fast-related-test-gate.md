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
   - **Bounded by WALL-CLOCK, not by a related-test count (mt#3765).** Each
     partition gets `RELATED_TESTS_PARTITION` (60s) and the gate as a whole
     gets `RELATED_TESTS_TOTAL` (90s); both are enforced by
     `spawnWithWatchdog`, not by `Bun.spawnSync`'s non-enforcing `timeout`
     option. The former count cap (`RELATED_TEST_CAP` = 40) is **removed**: it
     skipped over-cap sets entirely and passed them, so a LARGER staged change
     was checked LESS than a smaller one.
   - **A TIMEOUT is reported and does NOT block the commit (mt#3765).** The run
     is deferred to the authoritative pre-push/CI full-suite gate. This is
     distinct from a truncation: fail-closed exists for the mt#2632 SILENT
     truncation defect, where completeness is unknowable, whereas a watchdog
     kill names its budget, elapsed time, and partition. A missing completion
     summary WITHOUT a timeout still fails closed.
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
   code. That wrapper is a **backstop, not the gate's bound** (mt#3765): it
   runs under `RELATED_TESTS_WRAPPER` (150s), comfortably above the gate's own
   90s total, so the gate always gets to report its own disposition. If the
   wrapper ever fires, the gate itself hung and a hard failure is correct.

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
  gate remains the authoritative backstop.

  **Over-inclusion is NOT free (corrected by mt#3765).** This section used to
  say it "only costs a little extra local runtime, not correctness." It costs
  passability: at BFS depth 6 a `packages/domain/src/transcripts/*` change
  pulled in the whole cockpit server suite — 32 files / 445 tests / 80s
  against a 60s budget — and a gate that cannot finish blocks the commit.

- **Bounded BFS depth (default 3, lowered from 6 by mt#3765).** Measured
  related-test counts by depth: `turn-writer.ts` 1/4/13/16/32/32 and
  `agent-transcript-ingest-service.ts` 2/11/14/30/30/30 for d1..d6. Depth 3
  keeps the sibling test plus near importers while taking the `turn-writer`
  set from 80s to 2.5s. Latency is bounded by the wall-clock budgets above,
  not by a count cap.
- **Graph scope is no longer identical to execution scope (mt#4521).** This section
  previously described one file scope serving both questions. They are now two
  constants in `scripts/run-tests-main.ts`: `ROOTS` (what the pre-push runner
  EXECUTES) and `GRAPH_ROOTS` = `ROOTS` + `GRAPH_ONLY_ROOTS` (what this gate's graphs
  SEE). The only selector-only root today is `./.minsky/hooks`.

  **Why they had to diverge.** The hooks tree holds ~6000 tests / ~22s (mem#1206) —
  too much for a gate mt#2716 slimmed for latency, so it stays out of EXECUTION scope.
  But while it was also out of GRAPH scope, no hooks file was a graph node in either
  direction, and the sibling heuristic was the only edge that could reach a hooks test.
  Measured: changing `.minsky/hooks/entity-linkify.ts` selected neither
  `bare-entity-ref-scan.test.ts` nor `linkify-liveness.test.ts`, both of which import
  it directly. mt#4508 patched one instance with a directory-census edge; mt#4521
  closed the general case.

  **Measured cost, against the over-inclusion warning above.** Graph build on a
  NON-hook change: 268.8ms → 307.2ms mean (+38.4ms, +14.3%), 6 alternating in-process
  reps per arm — alternating because comparing across two processes confounds the
  delta with cold-vs-warm cache. Selected set on that same change: 16 → 22 files,
  end-to-end gate 4.25s against the 60s budget. The 6 added files are not noise: a
  `deploy-surface.ts` change now correctly selects
  `require-deploy-verification-before-merge.test.ts` and its siblings, which consume
  that predicate and were previously invisible to this gate.

  **Keep `GRAPH_ONLY_ROOTS` minimal.** Every entry is walked on every invocation,
  including changes with nothing to do with it, and the budget above is the ceiling.

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
