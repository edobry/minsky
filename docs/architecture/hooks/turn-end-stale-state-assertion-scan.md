# turn-end-stale-state-assertion-scan

**Event:** `Stop` · **Posture:** calibration-first, record-only · **Override:**
`MINSKY_SKIP_STALE_STATE_ASSERTION_SCAN` · **Task:** mt#4199 · **Family:**
`assertion-without-verification` (mem#669)

## What it catches

A turn's closing message says an ask or task is **waiting on the principal**, and the substrate
says that entity is already terminal. The principal goes to act on it and finds nothing to act on.

## Why a guard, when a cue already said this

`/check-premise` cue (i) — "An open item still needing the principal's action" — names this exact
shape and prescribes the exact falsifier: _re-read the item's LIVE state THIS turn_. It shipped as
mt#3216 on 2026-07-25, after R16. The assertion then recurred twice:

| R   | Date       | Shape                                                                                                                    |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------------------ |
| R16 | 2026-07-25 | ask asserted pending from a 26-minute-old read; the agent's own merge had triggered the sweep that closed it             |
| R17 | 2026-08-16 | ask asserted pending from a **three-day-old** read, across a conversation boundary; the principal answered it in the gap |
| R18 | 2026-08-17 | not a stale read at all — a MECHANISM asserted to work because the call arming it returned success (cue (h)'s surface)   |

R17 and R18 failed for one structural reason, and it is not "the cue needs widening": both triggers
land while composing the CLOSING MESSAGE, where there is no tool call to gate on, and
`/check-premise` is invoke-on-demand. mt#4191 then measured the general case — **the skill has never
been invoked, zero times across 558 conversations and 1488 transcript files, while eight tasks have
been filed to improve its cue text.** The cue tier here is inert, not weak.

Stop is the only interception point that runs at composition time. That is the whole argument for
this guard.

## How it decides

Two halves, deliberately ordered.

**1. The prose gate (no IO).** Over the last `TAIL_WINDOW_CHARS` of the message, with quoted and
fenced spans elided:

- a **pending-on-principal assertion** — "still with you", "waiting on you", "needs your decision",
  "awaiting your answer", "your call", "in your inbox", "for you to decide";
- an **entity ref** the substrate can resolve — bare `ask#N` / `mt#N`, or a `minsky://ask|task/...`
  link target;
- the two within `PROXIMITY_CHARS` of each other.

Proximity is what separates a claim from a coincidence. Without it, any message mentioning a task
anywhere and signing off anywhere would fire.

**2. The substrate read (only on a gate hit).** One query resolving each claimed ref's live state,
bounded by `LOOKUP_TIMEOUT_MS` and fail-open: every failure becomes a recorded suppression reason,
never a fire. Terminal means `closed` / `responded` / `cancelled` / `expired` for an ask,
`DONE` / `CLOSED` for a task. **`routed` and `suspended` are deliberately open** — a suspended ask
genuinely IS awaiting the principal, and that true negative is the one this guard must not spoil.

### Cost

A cold hook DB connect measures 3.3–5.5s (mt#2430's staged breakdown), which is why the gate runs
first and unconditionally. On the overwhelmingly common turn this guard costs a few regex scans and
never touches the database. The registration carries `timeoutMs: 8000` against the guard's own
4s lookup bound so a slow read cannot consume the whole budget.

### An unresolved ref is dropped, never treated as terminal

A ref the substrate does not know is most often a uuid-form link or an id from another backend.
Treating it as terminal would manufacture a contradiction out of a lookup miss — the failure
direction that would make this guard worse than nothing. `classifyResolved` drops it, and the
suppression is recorded.

## Scope

**In:** asks and tasks, resolved from Postgres.

**Out:** PRs. A PR's state lives on GitHub, so resolving one would put a network round-trip inside a
Stop hook. Deferred deliberately rather than smuggled in.

**Out:** enforcement. This emits no `additionalContext` — the record is its whole output, per
ADR-024's Rung-1 posture. The evaluation stream records suppressed gate-hits beside fired ones
(`fired: false` plus a reason) so both the false-positive rate and the miss rate are measurable
before any enforcement posture is chosen.

## The scope question left open

mem#669 R18 is the same family and would NOT be caught here: it was an assertion about a
MECHANISM's effect, not about an entity's state. The durable shape is _an assertion in the closing
message that the substrate contradicts_, of which the pending-entity case is one instance. Widening
to that is a scope decision and should be driven by this guard's own replay evidence, not assumed —
recorded in mem#669 R18 rather than pre-empted here.

## Testing

`turn-end-stale-state-assertion-scan.test.ts` splits along the same seam as the implementation: the
IO-free gate (`findPendingClaims`) carries every precision property, and the pure
`classifyResolved` carries the terminal-vs-open decision, driven by two state maps rather than a
patched database. Negative controls run before the first commit — removing the proximity bound,
treating an unresolved ref as terminal, and counting `suspended` as terminal each break exactly one
test.

## Cross-references

mem#669 (family record, R16–R18) · mt#3216 (the cue) · mt#4191 (the never-invoked measurement) ·
mt#4194 (the `/plan-task` skill-text sibling) · mt#2544 (family anchor) ·
`turn-end-unescalated-incident-scan.md` (the hybrid phrase-trigger/state-check template) ·
`duplicate-signature-scan.md` (the bounded fail-open substrate-read template)
