# Branch Freshness Guard

> Extracted from `.minsky/rules/hook-files.mdc` (mt#2620) — full incident narration,
> cross-references, and worked examples for this hook/guard. The compiled rule corpus
> carries only a terse index entry; this file is the durable detail.

A PreToolUse hook on `mcp__minsky__session_commit`, `mcp__minsky__session_pr_create`, and
`mcp__minsky__session_pr_edit` blocks the call when `origin/main` has commits not reachable
from the session's branch. This is the structural fix (mt#1483) for the "branch-behind-main
during reviewer iteration" pattern that recurred four times across mt#1190, mt#1262, mt#1384,
and related tasks.

**Hook file:** `.claude/hooks/check-branch-fresh.ts`

**How it works:**

1. Detects the current HEAD branch from `input.cwd`.
2. Checks whether `origin/<branch>` exists — if not (fresh branch, not yet pushed), allows silently.
3. Compares `origin/<branch>..origin/main`. If main has no new commits, allows silently.
4. **(mt#3484)** If main IS ahead, asks the question that actually matters: do those commits
   touch anything this branch touches? `computeDiffOverlap` intersects `mainRef...branchRef`
   (this branch's own diff) plus the working tree against `branchRef...mainRef` (main's new
   changes). No intersection → **allow**, with a non-silent line saying the branch is behind
   but disjoint. Intersection → block.
5. Block message leads with the reason — the overlapping files (capped at 10), or the failed
   probe on the fail-closed path — then the diverging commit subjects and the remedy.

**On block:** review the named overlapping files for a sibling fix that subsumes this work,
then `session_update` (or `git_push` — see "Two states, opposite remedies" below) and retry.
As of mt#2815 a clean tree whose merge applies without conflicts is handled inline (see
"Clean-tree auto-merge" below).

**Override mechanism:** Set `MINSKY_SKIP_FRESHNESS=1` in your environment before invoking
the tool:

```bash
MINSKY_SKIP_FRESHNESS=1 minsky session commit ...
```

The override is **logged to session stdout** (tool name, ISO timestamp) for audit.
Use only when you have already reviewed main's new commits and confirmed no overlap.

**Clean-tree auto-merge (mt#2815):**

Before denying a blocked call, the hook attempts an inline `git merge --no-edit <mainRef>`
when the working tree is fully clean (no staged or unstaged changes — checked via
`git status --porcelain`). This closes the most common case observed in production: origin/main
advances by a handful of commits from sibling-PR work on disjoint files while an agent is
mid-task, and the resulting block is resolved by a plain `session_update` with zero actual
conflicts (mt#2815's investigation: 7+ such cycles across 3 conversations in one week, all
confirmed clean).

- **On a clean merge** (`git merge` exits 0): the merge commit is kept, the tool call is
  ALLOWED to proceed, and an audit line reports
  `[check-branch-fresh] auto-merged N commit(s) from origin/main into <branch> (clean tree, no
conflicts) — proceeding without a manual session_update round-trip.` The merge is
  **local only** — the hook never pushes; the guarded tool's own push step (`session_commit`
  always pushes; `session_pr_create`/`session_pr_edit` push as part of their own
  rebase-on-main step) carries the merge commit to `origin/<branch>`.
- **On a conflicting merge** (non-zero exit): the merge is immediately aborted
  (`git merge --abort`) and the hook falls back to the standard denial, with an added note
  that an auto-merge was attempted and hit conflicts (listing the conflicted files when
  available). The denial the agent sees is otherwise byte-for-byte the pre-mt#2815 path — no
  silent conflict resolution, ever.
- **Not attempted** when the working tree is dirty, the overall hook budget is already
  exhausted, or the freshness comparison never fully ran (missing `branchRef`/`mainRef`).
  In each of these cases behavior is completely unchanged from the pre-mt#2815 hook.

**Why a dirty tree is out of scope, and why "clean tree" does not itself imply "no
conflicts":** `session_commit` calls are usually dirty by construction (there is something to
commit), so this mechanism's practical reach is largest at `session_pr_create` /
`session_pr_edit` time, where the tree is clean by workflow convention. Clean-tree only rules
out the SEPARATE failure mode of local uncommitted edits colliding with the incoming merge —
conflicts BETWEEN COMMIT HISTORIES (origin/main's new commits vs. the branch's own
already-pushed commits) can still occur on a clean tree. That is why the mechanism attempts
the merge and verifies the outcome rather than skipping verification on the assumption that a
clean tree is sufficient.

**Protective property (regression-tested in `check-branch-fresh.test.ts`):** a failed merge
attempt is always aborted before the hook returns, so no `MERGE_HEAD` is ever left behind for
the _next_ hook invocation to misinterpret as an operator-driven mid-merge (which would
silently allow past a still-stale, still-unresolved branch — see the mt#1739 carve-out
above). Covered by a real-git integration test with a genuine line-level conflict.

**Behavioral Contract:**

- **Blocks** when `origin/main` is N commits ahead of `origin/<branch>`. The denial
  message lists the count, the first 10 commit subjects (oneline), and instruction
  to review before continuing.
- **Allows silently** (no stdout, no `additionalContext`) on these four paths — they
  are the "nothing to report" cases:
  - branch even with main
  - fresh branch (no upstream ref yet — typical of a brand-new session's first push)
  - detached HEAD (no current branch to compare against)
  - undetectable default branch (no `origin/main` or `origin/master` to compare to)
- **Allows with audit-line on stdout** when a **merge / rebase / cherry-pick is in
  progress** (mt#1739). Detected by `fs.existsSync` on five git transient-operation
  markers under the **resolved** git directory: `MERGE_HEAD`, `REBASE_HEAD`,
  `rebase-merge/`, `rebase-apply/`, or `CHERRY_PICK_HEAD`. The resolution step
  honours git's `.git`-as-file indirection (`gitdir: <path>` redirect used by
  `git worktree` checkouts and certain submodule layouts), so worktree-based
  session workspaces are covered. The operator is finalising a commit that
  _resolves_ main-ahead-of-branch staleness (not introducing fresh work on a stale
  branch); blocking would create a chicken-and-egg deadlock — the merge commit
  pushed by the resolution is what advances `origin/<branch>` past the staleness
  gap. The reason emits to stdout as
  `[check-branch-fresh] merge-in-progress (.git/<MARKER>) — freshness check skipped`
  so operators see that the hook recognised the merge state. Distinct from the four
  routine silent paths above: those are "nothing to report"; this one IS reported
  via the audit line, mirroring the `MINSKY_SKIP_FRESHNESS=1` override convention.
- **Warnings always surface** even on silent paths. If the pre-check `git fetch`
  failed (network down, auth issue, slow remote), the resulting "comparison may be
  against STALE refs" warning IS emitted regardless of whether the path is silent.
  This carve-out is intentional: silence means "nothing to report"; warnings mean
  "something the operator should know," and operators should always learn about
  staleness even on otherwise-silent allow paths.
- **Skipped** paths (budget exhausted, miscellaneous probe failures) emit their
  "freshness check skipped" reason for auditability — these are NOT in the silent
  list because they signal something operationally interesting (the hook ran but
  couldn't complete its check).

**Budget derivation (mt#1546):**

The hook's three timer constants (`OVERALL_BUDGET_MS`, `FETCH_TIMEOUT_MS`,
`GIT_TIMEOUT_MS`) derive at entrypoint time (before `hookStart` capture)
from the host-imposed `timeout` field in `.claude/settings.json` for this
hook's matcher entry. The read is deliberately deferred from module-load
to entrypoint so importing the module has no fs/env side effects (relevant
for tests and any non-entrypoint consumers). Bumping the host cap in
settings.json scales the internal budgets proportionally, with no source
edits required.

Three named ratios encode the design choices:

- `OVERALL_BUDGET_RATIO = 0.6` — overall budget = 60% of host cap.
- `FETCH_TIMEOUT_RATIO = 0.55` — fetch can use 55% of overall budget.
- `GIT_TIMEOUT_RATIO = 0.17` — each local git probe gets ~1/6 of budget.

At the current 15-second host cap the derived values are 9000 / 4950 /
1530 ms (overall / fetch / git). The `4950` and `1530` differ slightly
from the legacy hardcoded `5000` and `1500` ms — within ±10%, which the
test fixtures explicitly verify. The deviation is intentional: it is the
cost of removing the magic-number coupling between cap and constants.

Each derived value is also clamped to a minimum of 100 ms
(`MIN_DERIVED_BUDGET_MS`) so pathologically small caps cannot zero-out a
per-call budget. The clamp never fires for realistic caps (≥ 5s).

If `.claude/settings.json` cannot be read, parsed, or contains no matching
entry, the hook falls back to the 15-second default and emits a one-line
warning through the operator-warning channel. The shared
`readHostCap(hookFilename, projectDir?, options?)` helper in
`.claude/hooks/types.ts` exposes this pattern for reuse by future hooks
with the same constraint. The `events` option (default
`["PreToolUse"]`) scopes the matcher walk to a specific lifecycle event.
The walker performs exact-or-suffix path-segment matching against the
hook's basename — case-sensitive, separator-normalised so Windows-style
backslash paths in settings.json work cross-platform.

## Diff-overlap predicate (mt#3484)

Until mt#3484 the guard blocked on **ahead-count**: `origin/<branch>..origin/main` being
non-empty. That is a proxy for the question the guard's own rationale states — "sibling PRs
that merged may have already fixed the same bug, making the current work redundant or
conflicting" — and under concurrent-agent load the proxy fires constantly while the underlying
risk stays rare.

**The measurement that forced the change (2026-07-31, mt#3484).** The prescribed remedy cycle
took ~205s end-to-end (`session_update` 114–115s plus `git_push` 91–92s, both pushes hitting
their 90s bound). Over the same window main advanced every ~2.6 min on average — 12 PRs merged
between 19:36:57Z and 20:08:21Z, with sub-minute clusters. The precondition was re-invalidated
faster than its own remedy could satisfy it: **seven consecutive `session_commit` denials in
fifteen minutes** in one conversation, six more concurrently in another. Guard deny counts were
rising with fleet size (3 on 07-26 → 23 on 07-31) against flat allow volume. Not one of the
seven blocking batches touched a file the blocked PR's diff touched.

A second-order effect made it worse: each `session_update` writes a
`Merge remote-tracking branch 'origin/main' into task/mt-XXXX` commit that lands on main with
the PR, inflating every other agent's ahead-count. 16 of the 45 commits listed across that
incident's block messages (~36%) were other branches' merge-from-main commits. Complying with
the guard generated the load the guard measured.

**What did NOT change.** GitHub's `requiresStrictStatusChecks` ("Require branches to be up to
date before merging") is enabled on `main` and stays enabled. This guard was always an
_additional_, strictly earlier copy of that requirement, applied on every commit rather than
once per merge. Only the copy narrows; the merge-time guarantee is untouched.

**Fail-closed.** `computeDiffOverlap`'s probes return `string[] | null`, and `null` (a non-zero
`git` exit) is NOT "no overlap" — it forces `overlaps: true` with `undetermined` naming the
failed probe, and the block message says so. An empty array is distinct: it means the probe ran
and found nothing. Conflating the two would make every no-op diff fail closed; conflating them
the other way would let a broken probe read as a pass, which is the failure mem#704 names.
Budget exhaustion likewise falls back to the pre-mt#3484 ahead-count block rather than allowing.

**Working tree is included on the branch side.** At `session_commit` time the edit about to be
committed is not in any committed range yet, but it is exactly the content at risk. Rename
entries in `git status --porcelain` (`R  old -> new`) contribute the destination path.

### Two states, opposite remedies

When `origin/main` is ahead of `origin/<branch>` there are two situations, and the old message
conflated them:

| State                                  | What happened                   | Remedy           |
| -------------------------------------- | ------------------------------- | ---------------- |
| (a) local branch already contains main | someone merged and never pushed | **`git_push`**   |
| (b) local branch does not contain main | main genuinely advanced         | `session_update` |

`session_update` does not fix (a): a local branch that is already `ahead` short-circuits to
`skipped: "No update needed - session is current or ahead"`
(`packages/domain/src/git/conflict-detection.ts`) and returns via `finalize()` **before** its
push step (`session-update-operations.ts`), so `origin/<branch>` never advances and the guard
blocks again — indefinitely. mt#2815's own auto-merge CREATES state (a), because it merges
local-only and never pushes.

The agent cannot distinguish these from any tool it has: `git_status` against a session
workspace returns `upstream: null, ahead: null, behind: null`. `localBranchContainsMain` runs
`git merge-base --is-ancestor <mainRef> HEAD` and the message names the right remedy. Exit 0 is
yes, exit 1 is no, and any **other** exit is a real failure returning `null` — rendering the
generic guidance rather than confidently asserting the wrong remedy.

### Effect on the mt#2815 auto-merge

The clean-tree auto-merge now runs only when the guard has **positive overlap knowledge** —
`shouldAttemptAutoMerge` requires `overlap.overlaps === true`, which covers a real file overlap and
the `undetermined` probe (a clean merge resolves either). It deliberately does **not** run on the
budget-exhausted deny, where `overlap` is `undefined`: auto-merge WRITES to the branch, and
mutating a branch about which nothing was established is precisely what "narrowed scope" excludes.
That predicate is an exported function rather than an entrypoint conditional so it is testable —
"when do we mutate the branch?" should not live only in unreachable `import.meta.main` code
(PR #2536 R1). Its original justification — resolving disjoint-file staleness inline — is
obsolete: those cases no longer block at all, which is strictly better than resolving them by
mutating the branch. What remains is a genuinely useful narrower slot: the files overlap, but
git merges them cleanly, so absorb main and proceed. The protective property is unchanged — a
conflicting merge is aborted and the call denied.
