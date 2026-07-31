# Merge-Gate Task Resolution

> Shared mechanism, not a guard of its own. Cross-referenced by the five `session_pr_merge`
> PreToolUse gates listed below; there is no `hook-files.mdc` index entry because it adds no
> new guard, no new override env var, and no new decision.

`session_pr_merge` accepts **two** optional selectors — `task` and `sessionId`. Until mt#3355,
five merge gates read only `tool_input.task` and exited `allow` the moment it was empty, so a
merge invoked by `sessionId` — a documented, first-class way to call the tool — bypassed all of
them at once with no warning emitted.

`.minsky/hooks/merge-gate-task-resolution.ts` is the one place that resolution now happens.

## The defect this closes (mt#3355)

Measured over 316–318 recorded invocations per gate in `~/.local/state/minsky/fire-log.jsonl`:
**36 real merges (11.4–11.6%) were evaluated by no gate at all.** An `allow` from a gate that
evaluated the PR and an `allow` from a gate that never fetched it were byte-identical in the
fire log except for `durationMs` (0–10 ms vs the ~2400–3500 ms a real evaluation costs).

This is the second shape of the invocation-path failure class in `CLAUDE.md §Invocation path
required for event/poll mechanisms`: _it runs; a dependency inside it is dead, and the failure
is converted into the same value a legitimately clean result produces._

The three `mt#3244` defect merges (PRs #2324, #2329, #2330, all 2026-07-26) are all in that
set. PR #2324 added 12 new test files and 3 new `scripts/*.ts` with no `Execution evidence`
marker and no `[unverified-tests]` prefix — under an evaluating gate it would have been a hard
**deny**.

## Resolution order

1. **`tool_input.task`** — the common form; source `tool_input`.
2. **The `task/mt-<id>` branch checked out in `cwd`** — source `branch-fallback`. At merge time
   `cwd` is typically the session workspace, whose branch follows that convention.
3. **Neither** — source `unresolved`. The gate emits an operator-visible warning and records
   `decision: "warn"`. It must never exit `allow` here: that is precisely the defect above.

The fallback is deliberately **DB-free** — not the DB-backed session lookup
`record-subagent-invocation.ts` uses — to preserve the hooks' self-containment invariant
(`.minsky/hooks/SPEC.md`). That constraint was recorded by the resolver's original home,
`block-subagent-merge-without-grant.ts`, which mt#3355 lifted the implementation out of; that
guard now delegates and keeps its `string | null` signature, since it treats an unresolvable id
as default-deny and has no use for the source.

## What the fallback does NOT recover

A `session_pr_merge` invoked from the **main workspace** with a `sessionId` selector — the
`/merge-coordination` main-agent pattern — sits on branch `main`, fails the branch regex, and
resolves to `unresolved`. Those merges are correctly _warned about_ rather than silently
allowed, but they are **not** recovered into a full check.

The fire log records neither `cwd` nor `tool_input`, so the split between recovered and
merely-warned merges could not be measured before this shipped. That is what
`FireLogEntry.taskResolutionSource` exists for: it makes the recovery rate observable instead of
assumed. `mt#3350` depends on that signal to know whether its own calibration sample is
complete.

## Fire-log field

`taskResolutionSource: "tool_input" | "branch-fallback" | "unresolved"` — written by
`merge-gate-fire-log.ts`'s `makeRecordAndExit` via a mutable `MergeGateFireLogContext` the gate
fills in immediately after resolving.

The holder is mutable by design. A gate has many exit points downstream of task resolution;
threading the source through each one as an argument would make "forgot to pass it at exit
point N" a live failure mode — the same shape as the bug this mechanism fixes. With a shared
holder, every exit point after the assignment carries the source by construction.

## Consumers

- `require-review-before-merge.ts`
- `require-execution-evidence-before-merge.ts`
- `require-deploy-verification-before-merge.ts`
- `require-growth-justification-before-merge.ts`
- `block-out-of-band-merge.ts` — resolves inside its `session_pr_merge` branch, _after_ repo
  derivation. Its pre-mt#3355 defect was subtler: it passed `""` to `resolvePrBodyFromTask`,
  which returns `null` on an empty task, and `null` was treated as "no PR exists for this
  branch — legitimate, allow silently". The non-evaluation was indistinguishable from a genuine
  no-PR result. (mt#3355 Success Criterion 4 asked whether this gate was affected; it was, and
  it is fixed the same way.)
- `block-subagent-merge-without-grant.ts` — delegates via `resolveTaskIdFromInput`.

## Tests

`.minsky/hooks/merge-gate-task-resolution.test.ts`. The subprocess layer spawns each gate as a
real process against a throwaway git repo with no `origin` remote (same trick, and same
rationale, as `merge-gates-git-path-regression.test.ts`), with `MINSKY_STATE_DIR` pointed at a
temp directory so the real fire log stays clean.

Payload shapes come from `.minsky/hooks/fixtures/session-pr-merge-payloads.json` rather than
being hand-authored — per mem#705, a hand-written fixture tests the reader against itself, which
is how mt#3066's verification passed while production skipped every merge.

## Cross-references

mt#3355 (this mechanism) · mt#3244 (the gates' trigger sets and evidence standards — a
different concern) · mt#3339 (evidence under non-canonical headings) · mt#3350 (depends on the
`taskResolutionSource` signal) · mt#3084 (the fire-log wiring that made the defect measurable).
