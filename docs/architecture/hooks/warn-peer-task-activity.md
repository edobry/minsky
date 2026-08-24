# `warn-peer-task-activity`

Advisory PreToolUse observer on `mcp__minsky__tasks_status_set` and `mcp__minsky__tasks_spec_patch`. Reads the task event ledger and
injects an advisory when it shows activity the caller may not have caused. **It never denies.**

That matches mt#4494's `## Success Criteria`, whose fifth criterion was **amended 2026-08-24
(PR #3281 R2)** from "a guard denies" to "a guard surfaces (advisory, never denies)". The original
wording and both reasons for the change are recorded in the criterion itself, not only here — see
§What it deliberately does NOT do below. A reader checking spec against implementation should find
them agreeing; if they ever diverge again, the criterion is the side to fix.

Source: `.minsky/hooks/warn-peer-task-activity.ts`. Task: mt#4494.

## Why it exists

`user-preferences.mdc §Probe before claiming a shared resource` prescribes a five-step probe
sequence for "is another actor on this task?". The sequence has been in force since 2026-05 and its
originating incident recurred under it.

**mt#1965 (2026-05-20)** — an agent recommended `/implement-task mt#1964` without detecting that
another agent had advanced it PLANNING→READY during the same session. The rationale doc's own
words: _"the status change was a visible signal not interpreted as evidence."_

**mt#4439 (2026-08-24)** — an agent actioning a handoff ran the sequence, concluded "no peer," and
ran a full parallel `/plan-task` while a peer walked the same task TODO → PLANNING (13:38:45) →
READY (13:48:36) → `session.started` (13:52:04, session `6ef3fabf-…`). It then appended two
sections to a spec the peer was mid-flight on. The `updatedAt` anomaly was noticed, written down as
"suspicious," and explained away — the same field, the same sentence, three months later.

## The structural finding: the sequence had no member that could answer

| probe                        | returned, in the mt#4439 incident     | why it did not settle it                                                                                                                                              |
| ---------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 — `tasks_claims_list`      | 2 fresh claims                        | the rule calls this "a signal, not proof" and routes to 1–4 — correct, and deliberately non-decisive. One of the two was the agent's OWN read under a stale proxy id. |
| 1 — task-status state-change | `updatedAt` moved 20s before the read | the signal was in hand; the rule said "identify them" and named no procedure.                                                                                         |
| 2 — `session_list`           | timed out twice (120s each)           | the only LEADING probe, and unavailable.                                                                                                                              |
| 3 — PR probe                 | clean                                 | LAGGING — a peer with a session and no push is invisible by construction.                                                                                             |
| 4 — recent commits           | clean                                 | LAGGING — same.                                                                                                                                                       |

Probes 3 and 4 can only see a peer that has already produced output, so their clean results
corroborated nothing while reading as corroboration. That leaves probe 0's signal plus an
**interpretation step**, and an interpretation step is where a motivated reading enters — most
strongly at the moment an agent has just been handed a task to start.

**Every probe in that sequence reads an ACTOR-side artifact** — a claim's id, a conversation's
transcript mtime, a session list — so all of them inherit the attribution problem mt#3889 / mt#3900
/ mt#4440 have spent three tasks repairing.

**How badly that axis misreads, measured under control (2026-08-24):** a task 24 seconds old, known
to no other actor, carried a presence claim under a DIFFERENT conversation's id 190ms after its
author's own write. Re-tested with the prediction registered first, one `tasks_get` moved that
claim's `lastRefreshedAt` from 14:05:12.251 to 14:07:15.248 — still under the wrong id. So the
claims table can **invent** a peer as readily as it can **hide** one. mem#952 measured the hiding
direction; mem#1231 the inventing one.

Task events are keyed to the TASK and written by the backend. The row exists whether or not any
process can name itself correctly, which is what makes this the one signal in the family that
answers instead of suggesting.

## What it fires on

Two triggers, deliberately asymmetric:

- **`session.started` — no recency window.** A session is a durable claim: a workspace exists on
  disk with its branch checked out, so an old one is still a peer rather than a stale signal. This
  is the row that resolved the mt#4439 incident.
- **`task.status_changed` — only inside `STATUS_CHANGE_WINDOW_MS`.** Every task accumulates these
  from its own lifecycle, so an unwindowed version would fire on every call and be tuned out
  immediately.

**The window reuses `PRESENCE_CLAIM_TTL_MS` (15 minutes)** rather than picking a number. That
constant answers the same question — how long a liveness signal stays believable — and carries its
own grounding at `packages/domain/src/presence/types.ts`: _"A working agent touches the task well
inside 15m (grounded per decision-defaults §Thresholds)."_ The value is duplicated in the hook so
its domain imports stay dynamic (`domain-bootstrap.ts` layer 1); a test asserts the two agree.

## What it deliberately does NOT do

**It attributes exactly one thing, and says so (revised in PR #3281 R1).** The first version
attributed nothing, on the reasoning that the hook's Claude Code `session_id` and a Minsky
workspace session id are different id spaces. The reviewer was right that this left the task's own
acceptance test unmet — _"the guard does not fire when the caller is the actor that started the
session"_ — and there IS a signal: a session workspace lives at
`~/.local/state/minsky/sessions/<sessionId>/`, and `input.cwd` is that root or a subdirectory of
it, so the id is an ancestor path segment (`callerSessionIdFromCwd`).

So the caller's OWN `session.started` row is filtered out. Without that, the guard warns every
implementing agent about itself on every transition and is tuned out within a day.

`task.status_changed` rows are still NOT attributed — they carry no session or actor at all — and
the advisory text says which is which rather than implying uniform attribution. A caller outside
any session workspace (the mt#4439 case) matches nothing and suppresses nothing, which is the safe
direction: it still warns.

**It does not deny.** Denying is the _prevention_ side of the substrate RFC's Open question 4
(Notion `367937f0`, Draft): _"Should the substrate detect contention (surface it to operators) or
prevent it (block a second agent from claiming a task already claimed)? … This is a design
philosophy question with significant UX implications."_ That is queued for principal discussion and
must not be settled as a side effect of adding a probe. Detection is also what the existing hook
model does for this class.

Note this is **advisory by design, not by calibration ladder.** ADR-024's ladder scopes itself to
`UserPromptSubmit` guidance hooks matching trigger phrases in the agent's own output; this reads a
structured ledger and has no paraphrase axis, so that ADR does not govern it. (mt#4494's own spec
initially cited ADR-024 here and gate (j) caught it.)

## Relationship to ADR-042 row (g)

ADR-042 assigns gate (g) a **transcript join** at the `ready` seam — did the three probe calls
happen. **That mechanism would have PASSED the mt#4439 incident, because they did.** A join over
calls covers the SKIPPED-probe failure and is structurally blind to the WRONG-CONCLUSION failure.
This hook reads the ledger instead: a different trace at the same seam, not a duplicate.

**Standalone, not dispatcher-registered.** `tasks_status_set` already carries standalone PreToolUse
hooks (`tasks-status-set-guard.ts`, `check-task-spec-read.ts`), so this follows that seam's existing
convention and does not incur the new `registry-status-set-guards.ts` wiring ADR-042 books to
mt#4172.

## Failure posture

Fail-open on every path, which for an advisory is the only safe direction — but the fire-log
distinguishes the two silences, because they are not the same:

- `guardOutcome: "decided"` — the ledger was read and evaluated.
- `guardOutcome: "crashed"` — the read failed (bootstrap, provider, or the `READ_DEADLINE_MS`
  race). A DEGRADED probe failing open, which must never read as clean: if the DB path breaks,
  every call goes quiet and that is indistinguishable from "no peer" without this marker.
- unset — the guard did not run (different tool, or no usable `taskId`).

`READ_DEADLINE_MS` is 8s, a CEILING over `domain-bootstrap.ts`'s own measurement of a cold
hook-shaped provider resolve (4.3–5.5s cold, 3.3–3.7s warmed) plus a small query — not a measured
typical (`decision-defaults.mdc §Thresholds`, CEILING case). ADR-042 notes a registration's
`timeoutMs` is declarative and unenforced, so the hook bounds itself.

## Override

**None, and that is deliberate** — a hook that cannot deny needs no escape hatch, and ADR-028 D3
(re-confirmed by ask#9323) forbids minting a new per-guard `MINSKY_*` name.

## Cross-references

mt#4494 · mem#1231 (originating incident + measurement) · mem#952, mem#595 (prior measurements of
the actor-side axis) · mt#4440 (writer-identity axis) · mt#3958 / mt#3086 (the same failure on the
machine path) · mt#2569 (product-tier fleet-state view) · ADR-042 · substrate RFC `367937f0` ·
`docs/rules-rationale/user-preferences.md §The sequence had no member that could answer the question`
