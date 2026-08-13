# Handoff — mt#3824

## Done

- Root-caused and fixed `.minsky/hooks/guard-feedback-shape.test.ts`'s size-ceiling failure.
  `calibration-review-cadence-detector`'s `formatCadenceWarning` rendered one line per
  review-due calibration log with no cap, so its size scaled with due-log count — driven both
  by real repo activity and by wall-clock time alone (every registry entry with a
  `liveSinceDate` ages toward `"never-fired"` as its `reviewByDays` window closes, independent
  of file content, including inside the guard's own isolated canary).
- Fix: capped `formatCadenceWarning` at `MAX_DUE_LOGS_LISTED = 2` named lines +
  `cappedEvidenceLines`'s `"…and N more"` tail (mt#3705's shared bound), trimmed the
  `never-fired` reason clause, and re-declared `registry.ts`'s
  `denialMessageSizeChars` from 450 → 800 (the true measured worst case, proven identical at 2
  vs 20 due logs once capped).
- Corrected `guard-feedback-shape.test.ts`'s stale `FEEDBACK_SHAPE` comment (claimed a
  nonexistent `slice(0, 8)` cap).
- Added hermetic `formatCadenceWarning` tests in
  `.minsky/hooks/calibration-review-cadence-detector.test.ts` proving the ceiling holds
  identically at 1/3/8 due logs (pure function, no fs/wall-clock).
- Verified BOTH directions of success criterion 2 live: guard-feedback-shape.test.ts green with
  a real log due (current repo state); `run()` returns `null` in an isolated temp workspace with
  every registered log's watermark freshly advanced (none due).
- Negative control: `git stash` reproduces the original `"639 chars > declared 450"` failure;
  `git stash pop` restores green.
- `validate_typecheck` / `validate_lint`: both clean.
- Investigated but did NOT reproduce the spec's `## CORRECTION` section's suspected second cause
  (`duplicate-signature-scan` dropping out of the producing set) — its canary is
  `expects: "calibration"` by design (recorded skip, no DB in canary) and it isn't in the
  current `producing` array at all. Not a live issue; not addressed.
- Created PR #2701 (https://github.com/edobry/minsky/pull/2701), commit `f66cb0962`.
- Reviewer round 1: CHANGES_REQUESTED, one BLOCKING finding —
  `.minsky/hooks/calibration-review-cadence-detector.test.ts:470` hardcoded
  `DECLARED_CEILING = 800` duplicating the registry's value (drift risk).
- **Fixed locally**: read the ceiling from `GUARD_REGISTRY` directly instead
  (`.minsky/hooks/calibration-review-cadence-detector.test.ts`, import `GUARD_REGISTRY` from
  `./registry`). Committed locally as `20f4c0b3e` — verified green
  (`bun test --preload ./tests/setup.ts --timeout=15000
./.minsky/hooks/calibration-review-cadence-detector.test.ts
./.minsky/hooks/guard-feedback-shape.test.ts` → 54 pass, 0 fail), typecheck/lint clean.
- PR body updated via `session_pr_edit` to describe the R1 fix (title/body only — does not push
  code).

## In progress / blocked

**Commit `20f4c0b3e` is NOT pushed to the PR branch yet.** Confirmed via
`mcp__minsky__git_log(ref: "origin/task/mt-3824")` — remote HEAD is still `f66cb0962`.

Every push mechanism tried fails deterministically with the SAME unrelated failure:
`mcp__minsky__git_push` (plain and `force: true`), `mcp__minsky__session_commit`,
`mcp__minsky__session_update` (plain and `force: true`) — all fail-close on
`scripts/run-tests-gated.ts`'s pre-push hook, which is red on
`src/adapters/shared/commands/calibration.test.ts:345` (`observability.calibration-review —
--ack covers all review-due legs (mt#2878) > still skips a newly-covered-leg log whose ask is
open when no askId is supplied` — `Expected: false / Received: true`).

**This is mt#3818's bug, not mine** — confirmed via `mcp__minsky__git_diff(from: "main", to:
"HEAD", nameOnly: true)`: my diff touches 6 files, none of them
`src/adapters/shared/commands/calibration.test.ts`. mt#3818's own spec (read directly) diagnoses
this exact failure as a calendar time-bomb: the `knowledge-acquisition` registry entry's
`liveSinceDate: "2026-07-23"` + `reviewByDays: 14` crossed today (2026-08-06), flipping an
unrelated process-global `watermarkAdvanced` flag the test asserts on instead of the per-path
property it should. mt#3818 is IN-REVIEW with PR #2699 as of this writing (checked repeatedly,
still IN-REVIEW, not yet merged).

One push DID succeed once — `session_pr_create`'s own internal push (used to create PR #2701 and
land `f66cb0962`) — but that mechanism isn't independently invocable for an existing PR; every
tool I could find that updates an EXISTING PR's code (`git_push`, `session_commit`,
`session_update`) goes through the hook-enforced path and fails identically. Do not keep retrying
these blindly — 4 attempts already made, all identical.

## Remaining

1. Poll `mcp__minsky__tasks_status_get(taskId: "mt#3818")` until it reaches `DONE` (or check PR
   #2699 merged).
2. Once merged, push commit `20f4c0b3e` (try `mcp__minsky__session_update` first — a rebase onto
   the now-fixed main should make the gated suite green again; fall back to
   `mcp__minsky__git_push` if needed).
3. Re-run `mcp__minsky__session_pr_wait-for-review(reviewer: "minsky-reviewer[bot]", since: "2026-08-06T19:13:37Z")`
   (the R1 review's `submittedAt`) to pick up the bot's re-review of the R1 fix.
4. On APPROVE: **do NOT merge** — the dispatching task explicitly said "Do not merge." Report
   status and stop. On further CHANGES_REQUESTED: iterate per the standard convergence loop.
5. Confirm CI's `build` job green on the PR (success criterion 4) — check via
   `mcp__minsky__session_pr_checks` or `mcp__minsky__forge_check_runs_list` once pushed.

## Known issues

- None beyond the push blocker above. All local verification (both test files, typecheck, lint,
  both directions of the state-independence claim, negative control) is solid and unaffected by
  the push blocker — it's purely a remote-sync problem caused by an unrelated in-flight task.
