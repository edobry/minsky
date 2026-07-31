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
3. Compares `origin/<branch>..origin/main` — if main has commits the branch lacks, blocks.
4. Block message lists: the count of diverging commits, the first 10 commit subjects (oneline), and the instruction "Review the new commits on main before continuing."

**On block:** run `session_update` to rebase on main, review the merged PRs to check for
overlap, then retry the original operation. As of mt#2815, the common case of this — a
clean working tree and a merge that applies with no conflicts — is now handled inline (see
"Clean-tree auto-merge" below) and no longer requires this manual round-trip.

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
