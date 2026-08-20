# `gate-walk-provenance`

Records, at the merge seam, whether the bound task was **ever gated at all**.

- **Task:** mt#1880 (child of mt#2755; ADR-042's `merge` row for gates (g)/(h))
- **Event / matcher:** `PreToolUse` on `mcp__minsky__session_pr_merge`
- **Family:** none — standalone, alongside the six existing merge guards. This seam has no
  dispatcher (ADR-042 §Family placement), so the registration lives directly in
  `.claude/settings.json`.
- **Posture:** RECORD-ONLY (calibration-first per ADR-024; `tuningOwnership: advisory`)
- **Override:** `MINSKY_SKIP_GATE_WALK_PROVENANCE=1`
- **Calibration log:** `.minsky/gate-walk-provenance-calibration.jsonl`
- **Replay:** `bun scripts/replay-gate-walk-provenance.ts [--limit N] [--since ISO] [--json]`

## The question it asks, and why it is not the one the task was filed with

mt#1880 was filed in 2026-05 asking a merge-time hook to "run gate (g) and gate (h) against the
linked task's spec." That is not implementable at this seam, and the reason is not a limitation of
the implementation:

| Gate | Where its discharge actually lives                                                       |
| ---- | ---------------------------------------------------------------------------------------- |
| (g)  | three probe calls — `list_pull_requests` + `get_files`, `tasks_search`, `tasks_children` |
| (h)  | the consumer sweep's directory arguments                                                 |

Both are **tool calls in the PLANNING session's transcript**. At `session_pr_merge` a guard sees
the MERGING session's transcript — routinely a different conversation — and for the bypass paths
this guard exists to catch there is no planning session at all. There is no transcript join
available here, so "run gate (h) against the spec" has no artifact to run against.

ADR-042 §Sibling reconciliation states the question this seam _can_ answer, and distinguishes it
from the sibling's in the same bullet:

> **mt#4171, at `pr`** — the sweep ran; did it cover the directories gate (h) prescribes? It
> presupposes the gate was walked and checks the SCOPE of what it did.
> **mt#1880, at `merge`** — was this task ever gated at all? It presupposes nothing, which is the
> whole point.

**Existence, not scope.** mem#416 enumerates four ways to reach shipped code with `/plan-task`
never running — `TODO → IN-PROGRESS` directly via `session_start`, shipping under a different task
id, a manual `tasks_status_set`, and external advancement past PLANNING. Merge is the only seam all
four pass through, which is why the two guards are complements rather than duplicates.

## The signal

A `task.status_changed` system event with `newStatus: "READY"` for the bound task id — a row read
against a table, with no paraphrase axis, which is ADR-042's discriminator for a mechanizable row.

Three measured properties shape the implementation:

**1. One emitter.** `src/adapters/shared/commands/tasks/status-commands.ts:172` is the only call
site, so the stream sees the `tasks.status.set` COMMAND path and nothing else.

**2. That asymmetry favours this check and would sink a different one.** Over the 500 most recent
events at planning time:

```
235  TODO -> PLANNING
223  PLANNING -> READY
  5  IN-PROGRESS -> DONE
  4  READY -> IN-PROGRESS
  2  READY -> DONE
  0  IN-PROGRESS -> IN-REVIEW
```

`READY → IN-PROGRESS` is set by `session_start` and `IN-PROGRESS → IN-REVIEW` by
`session_pr_create`; neither routes through the command, so both are nearly or entirely absent. The
transition this check needs — `→ READY` — is the one `/plan-task` makes via the command, and it is
the best-covered transition in the stream. A check that needed `IN-REVIEW` could not be built on
this substrate at all.

**3. Two reasons absence is not evidence.** Both set the posture; neither is a reason to skip the
check.

- **Emission horizon.** Emission began 2026-06-10T18:28:16.479Z — the value the guard reads live,
  and the same window mt#2340 bounded at planning time by two queries returning 0 and 141. A task
  that reached READY before then has no row and never will.
- **Best-effort emission.** `status-commands.ts:49` logs `"task.status_changed: event emission
failed (best-effort, swallowed)"` and continues, so a genuine gate-walk can leave no row.

Both are `claim-confidence.mdc §Absence in a derived view`: the stream is accurate about ITSELF and
silent about whether the gate ran.

## Mechanism

Three indexed reads on one connection, bounded by a 10s in-guard deadline (the registration's
`timeoutMs` is declarative and unenforced per ADR-042 §Family placement, and this seam has no
dispatcher to enforce it):

1. `min(created_at)` over `system_events` where `event_type = 'task.status_changed'` — the
   **emission horizon**.
2. `created_at` from `tasks` for the bound id.
3. the earliest row where `related_task_id = <task>` and `payload->>'newStatus' = 'READY'`.

The task id comes from `resolveMergeGateTaskId` — the shared resolver the other merge gates already
use, which tries `tool_input.task`, then the `cwd` branch's `task/mt-N`, then the workspace named by
`sessionId`. Its `tool_input` channel passes caller text through verbatim, so the guard normalizes
`mt1880` to `mt#1880` before querying: an unqualified id would match no row and read as `ungated`,
which is the false-positive direction.

**The horizon is READ, never carried.** A hardcoded date fails in the silent direction — it keeps
parsing, keeps comparing, and quietly reclassifies tasks as the stream's real history moves.

### The four outcomes

`classifyGateWalk` / `classifyMerge` are pure functions of those three facts:

| Outcome   | When                                                                                                                     |
| --------- | ------------------------------------------------------------------------------------------------------------------------ |
| `gated`   | a `→ READY` row exists                                                                                                   |
| `ungated` | no such row, and the task was created **after** the horizon                                                              |
| `skipped` | the task predates the horizon — the stream cannot answer                                                                 |
| `skipped` | no task id resolved (dependabot, a manual branch), the stream is empty, the task has no `created_at`, or the read failed |

**`skipped` is not a flavour of `ungated`.** Property 3 gives two ways a genuinely-gated task leaves
no row, so collapsing them would make "we cannot tell" indistinguishable from "nobody gated this" in
the very corpus a posture decision would be made from. Every `skipped` record carries a `reason`
naming which channel came up empty.

**A failed read is `skipped`, and it is a distinct field rather than three nulls.** A broken probe
and a healthy-but-empty stream produce identical nulls and mean opposite things; a guard whose
broken-probe path returned the same value as its healthy path would report an outage as a run of
correct behaviour (mem#704). `GateWalkFacts.unavailable` is what keeps them apart, and it carries
the actual cause — a hook process exits immediately after its decision, so that string is typically
the only account of the failure anyone ever reads.

**Order is load-bearing.** A found `→ READY` row settles the question _before_ any horizon
reasoning: a positive is a positive even for a row predating the computed horizon. Reversing the two
would let a bookkeeping question override direct evidence.

## Measured behaviour

`bun scripts/replay-gate-walk-provenance.ts`, run 2026-08-19 against the live substrate. The
population is every task with status DONE — by construction, every task under whose id code has
merged, which is the historical population of `session_pr_merge` invocations this guard would have
seen.

```
emission horizon  2026-06-10T18:28:16.479Z
examined          2954
gated             1204
ungated            180
skipped           1570   (all pre-horizon)
adjudicable       1384   (ungated 13.0%)
```

Note what the `skipped` column is: **53% of the corpus is outside this substrate's reach**, entirely
because it predates emission. That fraction shrinks on its own as history advances, and reporting it
as its own bucket rather than folding it into either verdict is the point of the four-outcome split.

**A hand-confirmed `ungated` (mt#1880 AT5): mt#4264.** Created 2026-08-18T20:25:09Z, DONE by
22:21Z — under two hours, `kind: implementation`. Two independent channels agree it was never
gated: the event stream holds **zero** `task.status_changed` rows for it (so no transition ever went
through `tasks.status.set`), and its spec carries **no `## Planning Audit` section** — the artifact
`/plan-task`'s gate battery writes. That is mem#416's first path, caught at the only seam that sees
it.

## What this check does NOT claim

- **It cannot tell whether a walked gate was walked WELL.** That is `enumeration-scope-check`'s
  question at `pr`, and it is not answerable here for the reason in §The question it asks.
- **It cannot see a task gated before 2026-06-10.** `skipped`, not `ungated` — and this guard's own
  task, mt#1880 (created 2026-05-17), is one of them.
- **A `gated` record proves a `→ READY` transition happened, not that the gate battery ran
  rigorously.** The row is evidence that `/plan-task`'s status call fired, nothing more.

## Posture

Record-only. ADR-042 §Posture ships every new row calibration-first per ADR-024's ladder and assigns
the (g)/(h) rows `tuningOwnership: "advisory"`, with the reason stated there: a provenance check
joins a claim against a record, and a missed record is a false positive fired at an author who did
the work. Property 3 above names two independent ways that can happen here.

Posture is operator-reserved. A flip to injecting or denying is a decision, not an implementation
step — and the 13.0% adjudicable-population rate above is the input it would be made from, not a
verdict on it.

## Cross-references

- ADR-042 — the row, its seam, and its posture
- `.minsky/hooks/enumeration-scope-check.ts` + `docs/architecture/hooks/enumeration-scope-check.md`
  — the sibling at `pr` (scope, not existence)
- mem#416 — the four paths to shipped code with `/plan-task` never running
- mt#2514 — the other merge-seam task-binding check (PR-task _correspondence_, vs this one's
  _provenance_); both parse `task/mt-N`, and `merge-gate-task-resolution.ts` is the shared parse
- mt#2340 — the `task.status_changed` emission this reads
