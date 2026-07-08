# Single Shared PR-Data Fetch Layer

> Extracted from `.minsky/rules/hook-files.mdc` (mt#2620) — full incident narration,
> cross-references, and worked examples for this hook/guard. The compiled rule corpus
> carries only a terse index entry; this file is the durable detail.

`.claude/hooks/pr-context.ts` (source: `.minsky/hooks/pr-context.ts`) is the
ONE place the four `session_pr_merge` PreToolUse gates — Review Gate
(`require-review-before-merge.ts`), Execution-Evidence Gate
(`require-execution-evidence-before-merge.ts`), Deploy-Verification Gate
(`require-deploy-verification-before-merge.ts`), and Out-of-Band Merge Guard
(`block-out-of-band-merge.ts`) — ask `gh` for PR data (title/body/files/
head-SHA/base-branch/check-runs/reviews/branch-protection). Before mt#2617,
sharing was partial and ad hoc: deploy-verification imported helpers from
execution-evidence, but review-gate (the largest, ~40 `gh` references) had
zero shared-module imports and hardcoded `edobry/minsky` (6 places) plus a
hardcoded `main` base branch. A single merge attempt could issue 8+ separate
`gh` subprocess round-trips across the four gate processes.

**Each gate keeps its own pure parse/evaluate/check functions** (already
covered by that gate's own test suite, unchanged by this consolidation) —
`pr-context.ts` owns only the "how do we fetch it, and how many `gh` calls
does that cost" concern. Two consolidation levels:

1. **Within a single gate:** review-gate used to issue THREE separate
   `check-runs` queries with different query params (`per_page=1` for
   presence, `check_name=bundle-boot-smoke` for the bundle-boot gate,
   `per_page=100` for the required-checks gate). All three of its existing
   parse functions (`parseCheckRunsResponse`, `parseBundleBootSmokeResponse`,
   `parseAllCheckRunsResponse`) operate on the SAME raw `check-runs` response
   shape and filter/sort client-side — so ONE `fetchCheckRunsRaw`
   (`per_page=100`) fetch satisfies all three without changing what gets
   parsed or denied. Per-merge-attempt calls for review-gate: 6 -> 4 (PR
   ref+base = 1, reviews = 1, check-runs = 1 [was 3], branch-protection = 1).
2. **Across gates that resolve PR metadata by task:**
   execution-evidence and deploy-verification each used to do
   `resolvePrNumber` (1-2 calls) + a SEPARATE `fetchPrMeta` (1 call) = up to
   3 calls. `fetchPrContext` collapses PR-number resolution and metadata
   fetch into ONE `gh` call per attempt (`resolvePrMetaForTask`).

**Absorbed scope (mt#2653 item 5):** review-gate's 6 hardcoded
`edobry/minsky` references are replaced by `deriveRepoFromGit(cwd)` (same
git-remote-derivation helper the other three gates already used), and its
hardcoded `main` base branch (used by the branch-protection fetch) is
replaced by the PR's actual base branch, resolved dynamically as part of the
same `resolvePrRefByBranch` call that resolves the PR number and head SHA.
`block-out-of-band-merge.ts` also picked up dynamic repo derivation as a
low-risk byproduct of consuming the shared module (it previously hardcoded
`edobry/minsky` in two places; its own call count was already minimal at 1
call per code path and is unchanged).

**Back-compat re-exports:** `parseGitHubRemoteUrl`, `deriveRepoFromGit`,
`resolvePrNumber`, `makeProdPrDeps`, `PrFile`, `ExecFn`, `PrDeps`,
`FetchPrFilesResult` are re-exported verbatim from
`require-execution-evidence-before-merge.ts` so downstream consumers
(`deploy-surface-detector.ts`, `deploy-verification-after-merge.ts`) and
each gate's own test suite import unchanged. `resolvePrNumber`'s raw-stdout
parsing contract (`gh pr view --json number --jq .number` returning a bare
numeric string) is directly unit-tested and is kept byte-identical rather
than rewritten in terms of the newer JSON-object-returning meta functions.

**Timeout policy:** ONE default (`DEFAULT_GH_TIMEOUT_MS`, 10s) for every
call issued through this module — the pre-mt#2617 per-call timeouts ranged
10-15s inconsistently across the four gates. No retries: none of the four
gates retried before this module either, and adding retries now would
change gate DECISIONS under flaky-network conditions, which the
zero-behavior-change requirement for this consolidation forbids.

**Round-trip instrumentation:** `withCallCounter(exec)` wraps any `ExecFn`
so callers (and tests) can count how many `gh` subprocesses a code path
spawns. `fetchPrContext`'s result carries a `ghCallCount` field built this
way — the mechanism behind the before/after call-count evidence in mt#2617's
PR body.

**Not touched:** `block-subagent-merge-without-grant.ts` +
`merge-grant-store.ts` (landed on the same `session_pr_merge` matcher via
mt#2647, same day as this consolidation) don't fetch PR data and are outside
this module's scope.

**Cross-references:**

- mt#2617 — this module's tracking task; mt#2607 finding F3 — originating
  audit finding (duplicated PR-data fetch)
- mt#2653 item 5 — the review-gate repo/base-branch hardcoding fix, absorbed
  into mt#2617's scope
- `.claude/hooks/pr-context.ts` (source `.minsky/hooks/pr-context.ts`) —
  implementation; `.minsky/hooks/pr-context.test.ts` — tests
