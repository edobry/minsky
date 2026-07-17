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

## Git-binary resolution robustness + crash-safe spawn (mt#2810)

All four gates crashed with `ENOENT: posix_spawn 'git'` from
`deriveRepoFromGit` -> `execWithPath` -> `Bun.spawnSync(["git", ...])` on two
separate days (2026-07-14 in a session workspace, 2026-07-15 in the main
repo). Because every gate's `deriveRepoFromGit(cwd)` failure path was already
designed to fail-open, an uncaught crash before that path could even run was
indistinguishable to the harness from a clean allow — the merges went
through with zero gate enforcement, and the only trace was a raw
uncaught-exception stack instead of a diagnosable warning.

Two independent bugs, fixed once in the shared `types.ts` exec layer (not
per-gate):

1. **`Bun.spawnSync` throws on ENOENT instead of returning a failed result.**
   Verified directly: a missing/unresolvable binary makes `Bun.spawnSync`
   throw a synchronous `Error: Executable not found in $PATH: "git"` rather
   than returning `{ exitCode: <nonzero>, ... }` — despite `types.ts`'s own
   header comment always having claimed the opposite contract
   ("...without throwing"). `safeSpawnSync` (types.ts) now wraps every spawn
   in try/catch: a throw becomes a synthetic `{ exitCode: 127, ... }`
   `ExecResult` (so it fails open exactly like a normal non-zero exit,
   which `deriveRepoFromGit` and every downstream caller already handles)
   and emits a loud `console.error("[hook-exec] DEGRADED: ...")` naming the
   exact command that failed to spawn — visible even for a caller (like
   `require-review-before-merge.ts`, pre-mt#2810) with no fail-open warning
   of its own for this branch.
2. **Root-cause finding — why the hook spawn env lacked PATH.**
   `execWithPath`'s PATH augmentation
   (`/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}`) is a fixed
   PATH _prefix_, not a binary _resolution_ strategy: it never checks
   whether a `git` executable actually exists anywhere in the result, it
   just hopes one of two hardcoded directories both survives into the final
   PATH string and contains git. Two independent gaps can defeat that hope
   in a hook-spawn context: (a) a dispatched/backgrounded subagent process
   is not guaranteed to inherit the same interactive-shell PATH the main
   agent has (Homebrew on a fresh shell comes from `.zshrc`/`.zprofile`
   sourcing, which a non-interactive subprocess spawn can plausibly skip);
   (b) even a well-formed inherited PATH can point at a distro layout the
   hardcoded two-entry prefix doesn't anticipate (e.g. Debian/Ubuntu's
   default `/usr/bin/git`, never special-cased). `resolveGitBinary`
   (types.ts) replaces the hope with an actual resolution: `Bun.which`
   first (respects whatever real PATH is present), then a fixed
   `GIT_FALLBACK_PATHS` list checked via `existsSync` (no subprocess spawn,
   so this step can't itself throw), falling through to the bare
   `"git"` (now crash-safe via `safeSpawnSync`) only if truly nothing
   resolves. Cached for the hook process's lifetime.

`execSync`/`execWithPath` both route `git`-by-bare-name commands through
`resolveGitBinary` before spawning (`resolveGitCommand`), so every existing
caller of these two shared helpers — the four merge gates via
`pr-context.ts`'s `deriveRepoFromGit`, plus `check-branch-fresh.ts`,
`inject-git-state.ts`, `parallel-work-guard.ts`'s own `deriveRepoFromGit`,
`post-merge-pull.ts`, `block-subagent-merge-without-grant.ts`, and
`mcp-daemon-staleness-detector.ts` — picked up both fixes with zero
per-caller changes. `record-subagent-invocation.ts`'s one raw
`Bun.spawnSync(["git", ...])` (outside this shared layer) was audited and
left as-is — it was already wrapped in its own try/catch, so it doesn't
share this crash class.

`require-review-before-merge.ts` also stopped being the one gate of the four
that exited silently on `deriveRepoFromGit` failure — it now emits the same
`⚠️ [require-review] Could not derive owner/repo...` shape the other three
gates already used, so a genuine repo-derivation failure is never invisible
regardless of which gate hits it.

## Forge-CLI fallback on gh transport-class failure (mt#2888)

The 2026-07-16 GitHub-degradation incident (subsumed mt#2887/mt#2892) showed
`gh api` 503-ing repeatedly for ~90 minutes across three independent
actors while the SERVER's Octokit-backed forge client (used by
`forge_check_runs_list`, credited to `@octokit/plugin-retry`) kept working
throughout the same window — confirmed against githubstatus.com's "Degraded
REST API Availability" declaration. No merge-gate could complete a
`session_pr_merge` or bypass-merge attempt during the outage, and the
gate's own override (`MINSKY_SKIP_REQUIRED_CHECKS=1`) is a launch-time env
var an agent mid-session cannot self-serve.

`fetchCheckRunsRaw` (the function backing every gate's check-runs read —
see above) now retries via the `minsky forge check_runs_list <sha>` CLI
(same App-token client the server already holds — no new credential, no
localhost HTTP channel) whenever the primary `gh api` call fails with a
TRANSPORT-class signal:

- `isGhTransportClassFailure`: a timeout, an HTTP 5xx suffix in `gh`'s
  stderr, or `gh`'s own JSON-decode failure when GitHub serves an HTML
  error page instead of JSON (`invalid character '<' looking for beginning
of value` — the exact live-repro text from the 2026-07-16 incident).
  Deliberately does NOT match a genuine 404/401/422 — those get NO
  fallback, since a different transport can't fix a real API error.
- On a transport-class failure, the forge CLI's `{checks: [...]}` JSON
  output is synthesized into GitHub's raw Checks-API shape
  (`{total_count, check_runs[]}`) so every existing parser
  (`parseCheckRunsResponse`, `parseAllCheckRunsResponse`,
  `parseBundleBootSmokeResponse`) keeps working UNCHANGED against the
  fallback path.
- The returned result carries `viaFallback: true` when the fallback fired,
  letting callers emit an audit line (both `require-review-before-merge.ts`
  and `require-checks-on-bypass-merge.ts` do) without changing their
  parse/decision logic.
- If the forge-CLI fallback ALSO fails, the ORIGINAL `gh` result is
  returned unchanged — the caller's existing "transport/parse failure"
  denial fires exactly as before, with `require-checks-on-bypass-merge.ts`
  additionally offering the D8 grant-store escape valve (see
  `required-checks-bypass-merge-gate.md`) for the verified-green-but-
  unreadable case.
- Green path is unaffected: `isGhTransportClassFailure` returns `false` on
  success, so a healthy `gh api` call issues exactly one subprocess, same
  as before mt#2888.

**Cross-references:**

- mt#2617 — this module's tracking task; mt#2607 finding F3 — originating
  audit finding (duplicated PR-data fetch)
- mt#2653 item 5 — the review-gate repo/base-branch hardcoding fix, absorbed
  into mt#2617's scope
- mt#2810 — the git-binary-resolution + crash-safe-spawn fix (this section);
  mt#2806 — parent gap-analysis task
- mt#2888 — the forge-CLI fallback (this section); mt#2887/mt#2892 —
  subsumed sibling incident filings whose acceptance tests this absorbs
- `.claude/hooks/pr-context.ts` (source `.minsky/hooks/pr-context.ts`) —
  implementation; `.minsky/hooks/pr-context.test.ts` — tests
- `.claude/hooks/types.ts` (source `.minsky/hooks/types.ts`) —
  `safeSpawnSync` / `resolveGitBinary` / `execSync` / `execWithPath`;
  `.minsky/hooks/types.test.ts` — unit tests;
  `.minsky/hooks/merge-gates-git-path-regression.test.ts` — real-subprocess
  regression test spawning all four gate entrypoints under a broken PATH
- `required-checks-bypass-merge-gate.md` — the D8 escape valve consuming
  this module's `viaFallback` signal
