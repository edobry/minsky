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
overlap, then retry the original operation.

**Override mechanism:** Set `MINSKY_SKIP_FRESHNESS=1` in your environment before invoking
the tool:

```bash
MINSKY_SKIP_FRESHNESS=1 minsky session commit ...
```

The override is **logged to session stdout** (tool name, ISO timestamp) for audit.
Use only when you have already reviewed main's new commits and confirmed no overlap.

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
