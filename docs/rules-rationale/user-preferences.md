# User Preferences — extended rationale

> Extracted from `.minsky/rules/user-preferences.mdc` (mt#3052 corpus trim). The compiled rule
> corpus carries only the per-turn directive (trigger phrases, probe sequences, thresholds);
> this file holds the incident narratives and extended cross-reference detail. Nothing here
> changes agent behavior — the directive text in the rule is the complete behavioral contract.

## Probe before deferring (mt#1819)

**Originating incident:** mt#1811 (2026-05-13). Wrote "Operator follow-up — requires Railway
access" in PR #1100 body and spec outcome despite `railway` CLI being on PATH, the
`railway:use-railway` skill being in the available-skills list, and
`feedback_railway_config_dot_path_fails_silently` being in injected memory.
Time-from-pushback-to-verified-in-production: <5 minutes. Time-to-probe-before-writing-the-
deferral: would have been <30 seconds.

This rule is the dual direction of `decision-defaults.mdc §Build vs buy — anti-pattern checklist`
(4th bullet, "Build-path-as-research at action-execution-time"). Both are instances of: at
action-execution time, agent defaults to the path requiring the least new tool-acquisition or
boundary-crossing, even when other options are available.

The `/implement-task` skill's §7 Convergence Checklist has a paired Preventive-phase sub-step
that enforces the same probe at the PR-creation gate. This rule covers all artifact surfaces;
the skill step covers the implement-task pipeline specifically.

### Why all three shapes take the same probe (mt#4047)

The three trigger-phrase families in the rule defer to different things — a PERSON's access, a
LATER TIME, a STANDING INSTRUCTION — and it is tempting to treat them as three rules. They are
one. All three assert the same proposition: _I am unable to do this at this moment._ That is a
claim about your PRESENT capability, and it needs evidence rather than assumption regardless of
what the sentence defers TO.

What differs is only the FORM the evidence takes. For the first two it is a tool call — try it.
For the third it is a question — ask. A deferral to a later time is not self-justifying because it
names no person; "can't verify until X ships" is exactly as much a capability claim as "requires
Railway access."

### Worked deferral records (the shape a justified deferral takes)

A bare deferral fails the rule. A justified one names the probe results AND the scope/safety
basis inline, so a reader can see the check happened:

> "Probed: `which gh` → not on PATH; no GitHub-org-admin skill; no `scripts/gh-admin/`; no memory
> matches. Deferred — requires user with GitHub org-admin access."

> "Probed: railway CLI available and authenticated. Action out-of-scope for this task (spec
> §Out of scope explicitly lists Railway env-var changes as a separate concern). Deferred."

The second is the one worth studying: the probe SUCCEEDED and the deferral still stands. A probe
that returns "tooling is available" unblocks the assumption of unavailability; it does not
override the scope and safety gates. Proceed only when the action is in-scope under the task's
acceptance criteria AND carries no destructive side-effect the spec has not authorized.

### The standing-instruction shape (mt#3930)

The first two shapes defer to a PERSON's access or to a LATER TIME, and both are probed with a
tool call — try it and see. The third shape has no tool call to make, which is exactly why it
went unnamed for so long: the canonical probe sequence (CLI, skill, repo, memory) runs to the end
and produces nothing to do, so the deferral passes the rule as written.

**Incident (2026-08-10, mt#3894).** A success criterion needed one throwaway subagent dispatch to
verify a fix against a live row. This project carries a standing instruction not to call the Agent
tool unless the principal requests it. The agent wrote that instruction down as settling the
question, filed a follow-up task (mt#3912) to own the criterion, described it as "closing by
itself on the next raw dispatch anyone makes", and reported the work complete-except-for-that — in
a message it was writing to the principal at that moment.

The principal's reply: _"I mean go ahead and dispatch a test subagent to test the thing like you
should have done that to confirm."_ The dispatch then took under five seconds and closed the
criterion immediately.

Cost: a follow-up task that should not exist, a criterion reported unmet for two hours, and a
round-trip to authorize something that would have been authorized instantly.

**Why it survives self-review.** The deferral sentence is _true_. "The standing instruction is not
to call the Agent tool unless the principal asks" is an accurate statement of a real rule, and
writing it feels like compliance rather than avoidance. What it omits is not a fact about the rule
but a fact about the situation: the principal was already the audience of the sentence. That is
the discriminator to look for — not "is this restriction real?" but "am I telling this to the one
person who could lift it?"

**The boundary that keeps this honest.** The shape must not become a licence to act through
restrictions. The stopping test is whether the action is destructive, or falls under a nameable
category in `principal-context.mdc §Decisions Eugene reserves` — and "nameable" is doing the work,
per the same positive-citation test the chain-walk halt conditions use. If no category is
nameable and the principal would plausibly just say yes, the restriction is a default and the
correct move is to ask. If one IS nameable, stop and route it through the Ask substrate.

**Tier.** Prose, deliberately and with a known weakness: the corpus's own measurement is that
prose checklist items contain their class poorly. The mechanizable sibling is the
`operator-deferral` observer, which already matches capability-deferral and permission-deferral
prose on a calibration-first footing; whether it should also match this shape is a question for
its calibration log, not something to assert here. What prose buys in the meantime is the phrase
shape — the point is to recognize the sentence as it is being written, which is the moment the
tool call would not have helped anyway.

## Probe before self-improvising (mt#3154)

**Originating incident:** the 2026-07-24 reviewer outage (mem#707). An mt#3117 source-cutover left
the reviewer Railway service building a DIFFERENT app from the repo — the Minsky MCP server — which
booted fine and answered `/health` with 200. Bot review was down fleet-wide for hours.

The root cause was identified early. The ~2 hours were lost entirely in the RECOVERY step: the
agent improvised `railway redeploy`, which replays the last build artifact and therefore
re-deployed the same wrong image, three times, reporting success each time. Both the
`railway:use-railway` skill and mem#700 documented the actual recovery — force a fresh deploy from
CURRENT source via a service-VARIABLE change. Neither was loaded.

**Why the existing rule did not catch it.** `§Probe before deferring` keys on deferral prose ("I
lack access", "operator follow-up"). None was emitted here — the agent never claimed it _couldn't_
act; it acted, confidently and wrongly. mt#2459's planned deferral-prose detector would also have
missed it for the same reason. The tell on this path is an ACTION taken without the probe, which is
why the generalization is to the act path rather than a wider vocabulary of deferral phrases.

**Two failure directions, one probe.** Deferring assumes you lack a capability you have;
self-improvising assumes you have knowledge you lack. The skill probe and memory probe answer both.

**The compounding factor** was that 2-strikes counted only tool ERRORS. Three redeploys all exited
0, so nothing tripped — the agent had no mechanical signal to stop. `error-investigation.mdc
§2-strikes counts wrong OUTCOMES` closes that half; this section closes the other.

## Probe before claiming a shared resource (mt#1965 → mt#1990)

**Originating incident:** mt#1965 closeout (2026-05-20). After completing mt#1965 (OOB-merge
guard agent-attestation gap investigation), the agent recommended `/implement-task mt#1964`
without detecting that another agent had advanced mt#1964 PLANNING→READY during the same
session. The status change was a visible signal not interpreted as evidence; the principal
informed the agent of the collision. The substrate RFC (mt#1990) explores the structural fix —
claim primitives, agent presence, status-machine intent states — that would turn this probe
sequence into a single substrate read. A FIRST slice has shipped: task-grain presence claims
(mt#2562; write-path fix mt#2567), now probe step 0 in the rule — but it is a best-effort
SIGNAL (opaque, churning `actorId`), not yet the "single read" that replaces the sequence. The
unified-fleet-state view that would close that gap is mt#2569. Until then, this rule stays
checklist-driven discipline with presence as the cheap first pass.

This rule is the dual of `§Probe before deferring`: that rule guards the "skipping the easy path
because I assume it's blocked" failure (claiming tooling is unavailable without verifying); this
rule guards the "taking the easy path because I assume it's unclaimed" failure (recommending
action on a shared resource without verifying who holds it). Both are instances of: at
action-execution time, the agent defaults to the lowest-cost-check path without verifying the
underlying assumption.

**Future structural enforcement:** the unified fleet-state view (mt#2569) may fold probes 0–4
into a single query, or eliminate the need to probe entirely via active edges + presence
broadcast. When that lands, this rule retires.

### Reading the presence probe (mt#2562) without over-reading it

Probe step 0 (`tasks_claims_list`) is the cheapest first check, and every one of its outputs is
easy to over-read. Four things it does NOT tell you:

- **A fresh claim with an unfamiliar `actorId` is "possible other actor", not "other actor."** For
  an undeclared caller the id is an opaque `unknown:hash:<...>` (ADR-006) that **churns per
  process and per staleness-respawn**. So "N claims" is NOT "N distinct agents," and your OWN
  claims from a prior respawn read back as someone else's. The probe says _when_ to do the
  forensics, never _who_ holds the task — confirm any hit with probes 1–4.
- **An empty result is "no claim visible," not "nobody."** Presence is best-effort and
  fire-and-forget; absence is inconclusive. Claims self-stale at ~15 minutes, which is why the
  default fresh-only view is the one you want.
- **After a `/clear`, a "fresh claim by another actor" may be YOUR OWN.** The proxy resolves the
  conversation id once at spawn, so your own touches read back under an unrecognized id. mt#3900
  fixed this, but the fix reaches a process only on MCP reconnect — assume attribution is stale.
- **`lastRefreshedAt` IS trustworthy**, as of mt#3889: probing no longer refreshes the claims it
  reports, so the timestamp reflects the peer's activity rather than your own read.

### The precedence rule, and why an enumeration of causes was not enough (mt#3967)

mt#3889 added a falsifier for the phantom-collision case: before treating a presence hit as a
collision, check whether the cited conversation is alive by looking at its transcript's mtime, since
"a transcript last written hours ago is not a live sibling."

That check produces a FALSE NEGATIVE in the case it most needs to handle. Observed 2026-08-10 while
running the dispatch watchdog on mt#3812:

```
tasks_dispatch-recover mt#3812 → status: "contested"
  peerLastRefreshedAt: 2026-08-10T15:48:16Z          (36 seconds before the call)
ls -l ~/.claude/projects/…/bff0cf98-….jsonl
  → last written Aug  8 23:33                        (~2 days earlier)
```

Applied literally, the heuristic yields _no live peer_ and licenses a redispatch into a workspace
something is actively touching — the mt#3086 / mt#3958 double-dispatch race, reached by following
the rule's own advice. **On 2026-08-11 mt#3812 reached DONE: the peer was alive and finished the
work.** The agent that refused was right, and it was right by NOT following the text.

**Why the signals disagree.** They answer different questions. A fresh claim proves _a process is
running_. A conversation id only labels _who that process thinks it is_ — and that label is exactly
what goes stale on a `/clear`, a resume, a fork, or any process whose proxy outlived its
conversation (mt#3900). So the transcript check tests the reliability of the LABEL, and the original
text let it be read as a verdict on the ACTIVITY.

**Why a third cause-specific bullet would not have fixed it.** mt#3958 had already added one: a
dispatched subagent writes to `<session-dir>/subagents/agent-<id>.jsonl`, so a stale parent
transcript is no evidence about it. Correct, and an enumeration. `/clear` staleness (mt#3900) is a
second cause. Adding a third on the next recurrence is the arms-race shape that ADR-024 names for
detectors and that `/plan-task` Step 4's halt-citation test names for rationales: **an enumeration
of known bad cases is defeated by a novel bad case.** The precedence — claim recency outranks a
stale transcript; an unconfirmable id means "unknown actor", never "no actor" — covers the causes
nobody has hit yet, and the mt#3958 bullet stays as a named instance of it.

**Note on cost.** `user-preferences.mdc` sat at 15,020 bytes against a 15,000-byte per-rule ceiling
when this amendment was written, so the edit had to be net-negative: the precedence was added and
the section compressed to 14,982. That constraint is why the incident narrative lives here rather
than in the rule.

### The sequence had no member that could answer the question (mt#4494)

**The originating incident recurred, three months later, in the same shape.** §Probe before
claiming a shared resource opens with mt#1965 (2026-05-20): an agent recommended
`/implement-task mt#1964` without detecting that another agent had advanced it PLANNING→READY
during the same session — _"the status change was a visible signal not interpreted as evidence."_

On 2026-08-24 an agent actioning a handoff ran the sequence against mt#4439, and concluded "no
peer" while a peer walked that task TODO → PLANNING (13:38:45) → READY (13:48:36) →
`session.started` (13:52:04). It then ran a full parallel `/plan-task` and appended two sections to
a spec the peer was mid-flight on. The `updatedAt` anomaly was noticed, written down as
"suspicious," and explained away — the same sentence the May incident earned, about the same field.

**Walking the sequence against that incident shows why discipline was not the missing variable:**

| probe              | returned                              | why it did not settle it                                                                                                                                             |
| ------------------ | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 — claims         | 2 fresh claims                        | the rule calls this "a signal, not proof" and routes to 1–4. Correct, deliberately non-decisive — and one of the two was the agent's OWN read under a stale proxy id |
| 1 — status change  | `updatedAt` moved 20s before the read | the signal was in hand; the rule said "identify them" and named no procedure                                                                                         |
| 2 — `session_list` | timed out twice (120s each)           | the only LEADING probe, unavailable                                                                                                                                  |
| 3 — PR             | clean                                 | lagging — a peer with a session and no push is invisible by construction                                                                                             |
| 4 — recent commits | clean                                 | lagging — same                                                                                                                                                       |

Probes 3 and 4 can only see a peer that has already produced output, so their clean results
corroborated nothing while reading as corroboration. Probe 2 was the sole leading member and it
failed. That leaves probe 0's signal plus an interpretation step — and an interpretation step is
where a motivated reading enters, most strongly at the moment an agent has just been handed a task
to start.

**What actually resolved it was one call that is not in the sequence:**
`events_list --relatedTaskId mt#4439` returned the status transitions and the `session.started`
row naming session `6ef3fabf-…`. No inference, no actor-identity question.

**Why that axis is clean.** Every probe in the original sequence reads an ACTOR-side artifact — a
claim's id, a conversation's transcript mtime, a session list — and therefore inherits the
attribution problem mt#3889 / mt#3900 / mt#4440 have spent three tasks on. Task events are keyed to
the TASK and written by the backend; the record exists whether or not any process can name itself
correctly. Measured the same session: a task 24 seconds old, known to no other actor, carried a
claim under a DIFFERENT conversation's id 190ms after its author's own write — re-tested under
control with the prediction registered first (`lastRefreshedAt` 14:05:12.251 → 14:07:15.248 under
the wrong id). So the claims table can invent a peer as readily as it can hide one; mem#952 had
already measured the hiding direction, and mem#1231 records the inventing one.

**Enforcement.** The `ready`-seam guard ADR-042 row (g) assigns is a **transcript join** — did the
probe calls happen — and it would have PASSED this incident, because they did. That mechanism
covers the skipped-probe failure and is structurally blind to the wrong-conclusion failure, which is
why the guard added here reads the event ledger instead. It ships ADVISORY: denying is the
_prevention_ side of the substrate RFC's Open question 4 (`367937f0`, Draft), which is queued for
principal discussion and should not be settled as a side effect of adding a probe.

## Plain-language first in chat reports (mt#2801)

**Originating incident:** 2026-07-15, mt#2777 planning. The gate output led with a four-part
premise audit and a 14-row criterion table; the principal responded "This is too much
information. Help me understand what the situation is and what should be done about this," and
approved the plain rewrite (what happened → the two underlying problems → what's wrong with the
task as written → three recommended actions) as the standard. Structural fix: the corresponding
rule bullet plus the `/plan-task` Step 4 output amendment (same task). Sibling rules:
`§Professional communication` (tone), `humility.mdc §Escalation packaging` (self-contained
decision escalations); this bullet covers report-shaped output.

## Progress heartbeats during tool-only stretches (mt#2824)

Cadence pinned at planning (2026-07-15) and grounded in two originating interrupts (conversations
a9c1a09b at 24 minutes, ac4f5675 at 28 minutes) — this cadence yields at least two heartbeats
before either historical interrupt point.

This is the discipline layer of a two-layer fix; the detection layer is
`silent-stretch-detector.ts` (`.minsky/hooks/`, ADR-028 `GUARD_REGISTRY`) — a calibration-first
(mt#2263 ladder) `UserPromptSubmit` guard that measures the just-completed turn for tool-only
silence and logs a record to `.minsky/silent-stretch-calibration.jsonl` when a stretch crossed
the threshold without a heartbeat; it does not yet inject a reminder (v1 is log-only).
Originating incident: _"I think you ran into the harness bug again. Maybe you're making
progress. I can't see it because there's been no UI updates in 24 minutes"_ — the operator
interrupted two in-flight, healthy tool calls because silence was indistinguishable from a hang.
See `docs/architecture/hooks/silent-stretch-detector.md` and `hook-observers.mdc`'s entry for
the detector's trigger/override/fail-posture summary.
