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
