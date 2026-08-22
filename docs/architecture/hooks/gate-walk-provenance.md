# `gate-walk-provenance`

Records, at the merge seam, whether the bound task was **ever gated at all**.

- **Task:** mt#1880 (child of mt#2755; ADR-042's `merge` row for gates (g)/(h))
- **Event / matcher:** `PreToolUse` on `mcp__minsky__session_pr_merge`, **and** on
  `Bash|mcp__minsky__session_exec` for the `gh api PUT .../pulls/<N>/merge` bypass. Both merge
  surfaces, deliberately: a merge routing around `session_pr_merge` is exactly where a never-gated
  task most plausibly reaches main, so a corpus blind to it would under-count `ungated` in the very
  measurement the posture decision is made from. On the shell matcher a command that is not a merge
  exits before any database work and writes **no** record — "not a merge" is not a merge outcome,
  and one record per shell command would bury the signal.
- **Family:** none — standalone, alongside the six existing merge guards. This seam has no
  dispatcher (ADR-042 §Family placement), so the registration lives directly in
  `.claude/settings.json`.
- **Posture:** RECORD-ONLY (calibration-first per ADR-024; `tuningOwnership: advisory`)
- **Override:** `MINSKY_SKIP_GATE_WALK_PROVENANCE=1`
- **Calibration log:** `.minsky/gate-walk-provenance-calibration.jsonl`
- **Declared at:** `scripts/lib/standalone-guard-canaries.ts` (`calibrationLog: "gate-walk-provenance"`).
  Required, and easy to forget for a guard wired straight from `.claude/settings.json`: that is a
  third wiring shape, present in neither surface `buildCalibrationLogToGuards` reads. Without the
  declaration the log has no join key, so `/calibration-review` never sweeps it and
  `check-coverage-receipts` can only ever report `[FLAGGED] … Unmapped` — which reads as a dead
  detector and is not one (mt#4390).
- **Record timestamp field:** `timestamp` — NOT `ts`. Every shared reader keys on `timestamp`
  (`checkCoverageReceipt` drops an entry whose `Date.parse` is NaN; the sweep renders
  `rec.timestamp`). Records written before mt#4390 carry `ts` and are invisible to both; they age
  out of the rolling window rather than being backfilled, since the log is gitignored local
  telemetry that differs per machine.
- **Replay:** `bun scripts/replay-gate-walk-provenance.ts [--limit N] [--since ISO] [--json]`
  — replays against the LIVE substrate, not the JSONL, so it is unaffected by the record schema.

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

`bun scripts/replay-gate-walk-provenance.ts`, run against the live substrate. The population is
every task with status DONE — by construction, every task under whose id code has merged, which is
the historical population of `session_pr_merge` invocations this guard would have seen.

```
                  2026-08-19   2026-08-20
emission horizon  2026-06-10T18:28:16.479Z (both runs)
examined                2954         2984
gated                   1204         1232
ungated                  180          182
skipped                 1570         1570   (all pre-horizon, both runs)
adjudicable             1384         1414
ungated rate           13.0%        12.9%
```

Two runs a day apart are reported rather than one, because a single number cannot show whether the
rate is stable or drifting — and a posture decision would be made from the rate. The `skipped`
count is identical across both, which is the expected shape: its membership is fixed by a horizon
that does not move, so every new task lands in `gated` or `ungated` and the bucket can only shrink
as a share.

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
- **It cannot see a task GATED before 2026-06-10.** Those record `skipped`, not `ungated`.

  Read that bound precisely: it is about when the task was **gated**, not when it was **created**.
  This guard's own task is the worked example, and it goes the other way from the obvious guess —
  mt#1880 was created 2026-05-17, well before the horizon, and records **`gated`**, because it was
  re-planned on 2026-08-19 and that `→ READY` transition went through the command. Creation date
  selects nothing; it is consulted only when there is no row to find. (Verified live — see
  §Live verification.)

- **A `gated` record proves a `→ READY` transition happened, not that the gate battery ran
  rigorously.** The row is evidence that `/plan-task`'s status call fired, nothing more.

## Live verification

The unit tests are all seam-injected — they hand `classifyGateWalk` a `GateWalkFacts` literal and
never touch a database. That validates the logic and says nothing about the BINDING: whether the
real hook process, started by the harness, reaches the real Postgres and writes a real record.
Exercised directly (2026-08-20), a synthetic `PreToolUse` payload piped into the shipped
`.claude/hooks/gate-walk-provenance.ts` for three tasks chosen to hit three different verdicts:

```
$ printf '{"session_id":"live-probe","tool_name":"mcp__minsky__session_pr_merge",
           "cwd":"<session>","tool_input":{"task":"<id>"}}' | bun .claude/hooks/gate-walk-provenance.ts
exit(mt#4320)=0   exit(mt#4264)=0   exit(mt#1880)=0

{"taskId":"mt#4320","outcome":"gated",
 "reason":"a → READY event exists (2026-08-19T06:20:08.140Z)",
 "readyEventAt":"2026-08-19T06:20:08.140Z","horizonAt":"2026-06-10T18:28:16.479Z",
 "taskCreatedAt":"2026-08-19T04:58:38.770Z"}
{"taskId":"mt#4264","outcome":"ungated",
 "reason":"no → READY event, and the task was created after the emission horizon (…)",
 "readyEventAt":null,"horizonAt":"2026-06-10T18:28:16.479Z",
 "taskCreatedAt":"2026-08-18T20:25:09.987Z"}
{"taskId":"mt#1880","outcome":"gated",
 "reason":"a → READY event exists (2026-08-19T06:01:04.987Z)",
 "readyEventAt":"2026-08-19T06:01:04.987Z","horizonAt":"2026-06-10T18:28:16.479Z",
 "taskCreatedAt":"2026-05-17T23:31:27.571Z"}
```

Every exit is 0 — the guard never denies — and the horizon is the same value in all three records,
read live rather than carried.

**This run corrected a false claim in this page.** §What this check does NOT claim previously said
mt#1880 itself would record `skipped` as a pre-horizon task. It records `gated`: created
2026-05-17, but re-planned 2026-08-19, and the ordering rule puts a found row ahead of any horizon
reasoning. The unit test _"a found event outranks a horizon question"_ asserts exactly that, and the
seam-injected version of it could not have caught the documentation error — only running the real
binding against real rows did.

## Posture

Record-only. ADR-042 §Posture ships every new row calibration-first per ADR-024's ladder and assigns
the (g)/(h) rows `tuningOwnership: "advisory"`, with the reason stated there: a provenance check
joins a claim against a record, and a missed record is a false positive fired at an author who did
the work. Property 3 above names two independent ways that can happen here.

Posture is operator-reserved. A flip to injecting or denying is a decision, not an implementation
step — and the ~13% adjudicable-population rate above is the input it would be made from, not a
verdict on it.

## Cross-references

- ADR-042 — the row, its seam, and its posture
- `.minsky/hooks/enumeration-scope-check.ts` + `docs/architecture/hooks/enumeration-scope-check.md`
  — the sibling at `pr` (scope, not existence)
- mem#416 — the four paths to shipped code with `/plan-task` never running
- mt#2514 — the other merge-seam task-binding check (PR-task _correspondence_, vs this one's
  _provenance_); both parse `task/mt-N`, and `merge-gate-task-resolution.ts` is the shared parse
- mt#2340 — the `task.status_changed` emission this reads
