# `warn-stale-forward-reference`

**Task:** mt#4535, seam corrected by mt#4545 · **Posture:** advisory, log-only — it cannot deny,
and has no override because there is nothing to override.

**Events — two surfaces, and the distinction matters:**

| Surface                         | Event         | When it fires                                                                                                |
| ------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------ |
| `mcp__minsky__session_pr_merge` | `PostToolUse` | On a SUCCESSFUL merge. **This is the one that fires in practice** — merge is where DONE is written.          |
| `mcp__minsky__tasks_status_set` | `PreToolUse`  | Only when an agent sets `status: DONE` explicitly, which `task-status-workflow-protocol.mdc` says not to do. |

> **mt#4535 shipped with the status-set surface ALONE, and consequently never fired.**
> At merge, `packages/domain/src/session/session-merge-status-sync.ts:239` calls
> `taskService.setTaskStatus()` — a direct domain-service call no tool-level hook can see.
> Caught within minutes of merge by checking the fire log for a coverage receipt: one record,
> `guardOutcome` unset (the process ran; the guard never evaluated), against 249 for the sibling
> `warn-peer-task-activity` on the same matcher. Every unit test passed throughout, because they
> exercised the pure matcher and nothing asserted the trigger was reachable. mt#4545 added the
> merge surface and a registration test. The frame that names the error is ADR-042's own:
> _"each backstop fires at the seam where that trace first exists."_
>
> The event-ledger seam is NOT an alternative: `task.status_changed` is emitted from
> `src/adapters/shared/commands/tasks/status-commands.ts` — the command adapter — so it has the
> identical blind spot. That is also why the ledger shows 1372 PLANNING→READY rows against 36
> READY→IN-PROGRESS.

## What it catches

When a task ships, nothing reconciles the artifacts that named its deliverable as FUTURE
WORK. Those artifacts keep presenting a shipped mechanism as pending, and the next agent
reads them as current.

This is a distinct decay from a claim that was WRONG when written. The artifacts were
**accurate at authoring time**; the world moved and the text did not. There is no error
to notice on a careful re-read — which is why it survives review, and why per-instance
repairs kept being needed with no mechanism owner:

| Instance | What went stale                                                               |
| -------- | ----------------------------------------------------------------------------- |
| ADR-006  | Layer 3's "upgrade path if that bites" — mt#3900 shipped exactly that mapping |
| mem#706  | Cited mt#3726 as "TODO, alive"; it went DONE 2026-08-20                       |
| mt#4326  | ADR-042 reads Proposed while three children shipped against it                |
| mt#4282  | ADR-042's cross-references describe a retired detector as live                |
| mt#4501  | ADR-025 superseded after `transcript_lines` became the landing zone           |

Five repairs, two of them made by hand in the session that filed this task. That is the
per-instance tier doing a mechanism's job.

## The match, and why it is not the task id

A paragraph qualifies when it carries a **forward-looking marker** AND either:

- **the task id** — exact, and the reason the advisory can be trusted where it fires; or
- **≥2 distinct tokens from the task's title** — the heuristic half.

The title path is load-bearing rather than decorative. ADR-006 named no task: it described
the mechanism in prose ("a SessionStart hook writing a `<claude-pid> -> sessionId` mapping
the proxy re-reads per request"). **An id-only reverse index would have missed this hook's
own originating instance** — it is accurate about artifacts that happen to cite a task and
silent about exactly the class that matters. `warn-stale-forward-reference.test.ts` asserts
this with a negative control: id-only matching returns zero on that paragraph.

The title is the only description of the deliverable available at transition time, which is
what makes the descriptive path reachable at all. It is read from `tasksTable` behind an 8s
deadline; a failed read degrades to the id-only path and records `guardOutcome: "crashed"`
so a persistently dead title read is never mistaken for a clean corpus.

## Measured behaviour

Against the live corpus (98 documents: 44 ADRs + the `.minsky/rules` tree), replaying
mt#3900's DONE transition:

```
corpus docs: 98 | title tokens: 10
TOTAL HITS: 12
ADR-006 hits: 4
  line=63 via=description marker="upgrade path"   <- the originating instance
  line=79 via=id          marker="upgrade path"
  line=196 via=description marker="deferred"
  line=212 via=description marker="planned"
```

Lines 196 and 212 are the heuristic's false-positive shape: other ADR-006 paragraphs
sharing tokens like `identity` / `conversation`. That rate is the reason this ships
log-only.

## Why log-only

Per ADR-024's calibration LADDER — cited for the ladder, not as governance; that ADR's own
scope is the guidance-hook family matching phrases in the agent's output, and this is a
cross-reference check over artifacts. Two things are unmeasured: the description path's
false-positive rate against this corpus, and how often a DONE transition has any
forward-reference at all. Every invocation writes a fire-log record, fired or not, so the
miss rate has a denominator.

Reporting rather than acting is also the shape the accepted task-state-machine RFC already
uses at this seam: _"a DONE-reopen records a divergence and routes to operator attention
instead of silently un-finishing merged work"_ (Notion `3a4937f0`, Accepted 2026-07-21).
This is a second check in that shape, not a new posture.

## Deliberate carve-outs

- **CLOSED is not covered.** A CLOSED task's forward references are stale too, but
  differently — the work is abandoned, so the reconciliation is "this will never come"
  rather than "this already shipped". Firing the shipped-it text on abandoned work would be
  worse than silence. Left to a follow-up once the DONE case has calibration data.
- **Task specs are not in the corpus.** A spec describing its own work as pending is the
  normal state, not a defect.
- **It does not decide.** A match is a CANDIDATE. Whether a paragraph is genuinely stale
  needs a reader who knows what shipped.

## Registries

Adding this module obliged all of: `.claude/settings.json` registration ·
`enforcement-mapping.ts` (`NON_ENFORCEMENT_CLAUDE_HOOKS`, advisory) ·
`interceptor-descriptions.ts` · `interceptor-coordinates.ts` ·
`docs/architecture/hook-module-inventory.md` (row + bucket + totals) · this page ·
`hook-observers.mdc`. See mem#1206 — the pre-push gated runner cannot execute
`.minsky/hooks/**`, so run `bun run test:hooks` before pushing a hook change.

## Cross-references

mt#4535 (this hook) · mt#4326, mt#4282, mt#4501 (per-instance repairs this retires the need
for) · mem#706 (the assertion-without-verification family root) · mt#2901 / mt#2589 (the
retrospective-triggered, task-scoped recurrence-after-DONE check whose trigger and scope
this complements) · `warn-peer-task-activity.md` (the sibling advisory on the same seam).
