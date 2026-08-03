# ADR-032: Guard-threshold tuning runs on a labeled response signal that does not yet exist

## Status

**Accepted** (2026-08-03)

Implements the mem#802 ownership principle ("customers emit signal, the system/vendor tunes") and
the beyond-Minsky RFC's 2026-08-01 amendment §3 (Notion `37a937f0-3cb4-81ed-9a08-fbdeebd8845d`).
Task mt#3577, under umbrella mt#3525. Extends ADR-028 §D2/§D4.

## Context

mt#3518 stamped every `GUARD_REGISTRY` entry with `tuningOwnership: invariant | preference |
advisory` and made three thresholds env-overridable. That shipped the labels. mem#802 describes a
loop — customer usage emits signal, the signal moves thresholds within vendor-set bounds, and
aggregated fleet signal improves shipped defaults — and nothing implements it.

Planning mt#3577 checked the loop's assumed inputs against the corpus and found two of them
misstated. Both corrections are load-bearing for this decision.

**The fire-log already has a consumer.** `src/domain/calibration/rationalization-review.ts`
(mt#2901, evaluation-loop RFC Part 3) reads it today: per-guard override rates against a 20%
budget, latency percentiles, an `auto-affirm`/`outlier` classification, and a routed ask. What is
absent is not a reader but an **actuator** — nothing writes a threshold anywhere — and **project
scoping**: one machine-local file, one operator.

**The signal the loop was to consume is three different streams, and the decisive one is empty.**

| Stream            | What it carries                                     | Where it lives                          | State              |
| ----------------- | --------------------------------------------------- | --------------------------------------- | ------------------ |
| Decision INPUTS   | the measured value a threshold was compared against | per-guard `.minsky/*-calibration.jsonl` | partial            |
| Decision OUTCOMES | `allow` / `warn` / `deny`, override consultation    | `fire-log.jsonl`                        | complete           |
| Operator RESPONSE | whether the fire changed behavior                   | —                                       | **does not exist** |

mem#802's own parenthetical is precise ("the ADR-028 fire-log already records override
consultation per fire"); mt#3577's spec read it as covering all three. Live counts over
2026-07-16 → 2026-08-03 settle it: `wall-of-text-detector` 2120 invocations / 98 `warn` / **0**
override records; `silent-stretch-detector` 2230 / 0 / **0**. Across ~4,350 invocations of the
only two `preference`-class guards with a tunable threshold, the override channel produced
nothing. A tuner keyed on override or dismissal signal has an empty input for exactly the guard
class it exists to serve.

A threshold cannot be moved from outcomes alone. "This guard fired 98 times" is compatible with
98 correct fires and with 98 the operator ignored; the two demand opposite responses.

## Decision

**Tuning consumes a per-fire LABELED RESPONSE signal. Building the emitter for that signal is the
first piece of work, not a later refinement.** Four sub-decisions follow.

### D1 — The decider is pure, bounded, and ships now; the actuator does not

`src/domain/calibration/threshold-tuning.ts` (this ADR's companion) decides whether a threshold
should move and returns a proposal or a named-reason refusal. It writes nothing, reads no clock,
and touches no fs — the same pure-module/IO-adapter split `calibration-sweep.ts` and
`rationalization-review.ts` established.

Shipping the decider before the actuator is deliberate. The decision logic is where the ownership
bounds live and where being wrong is expensive; it is testable in full isolation, and its
behavior against today's real corpus — entirely unlabeled — is `no-change` for a stated reason.
The module is correct and inert until the emitter lands, and inert is the honest state.

Bounds, each a stated constraint rather than a tuning knob:

- **`invariant` is checked first and independently of the corpus.** No observation set produces a
  proposal for an `invariant` guard. This is mem#802's "never auto-relaxed by local dismissal
  behavior" as a code path, not a convention.
- **A proposal may not exceed 10x the SHIPPED default** — the same
  `PREFERENCE_OVERRIDE_MAX_MULTIPLE` ceiling already enforced on the human-set env var
  (`.minsky/hooks/types.ts`). An automatic path must not reach past what a human may type. The
  bound is computed from the shipped default, so a previously-raised local value cannot ratchet.
- **A move may never silence a fire the operator acted on.** A heeded observation clamps the
  proposal below itself (above, for a floor guard); when that clamp leaves no room, the answer is
  `no-change`, not a smaller move.
- **The target is the 90th percentile of dismissed values, not their maximum.** One anomalous
  fire must not set the threshold for every subsequent turn, and a guard tuned into permanent
  silence is indistinguishable from a dead one — the failure class `coverage-receipt.ts` exists
  to catch.
- **Cold start is a floor of 5 labeled observations**, the evaluation-loop RFC's own Phase-1 GATE
  bar for "enough fires to say anything about a guard." A percentile over fewer is a single
  observation wearing a statistic's clothes.
- **Records written before 2026-07-29 are discarded from any tuning basis.** mt#3280 (DONE,
  commit `4b88d928c`) found `extractLastAssistantTurn` could hand a `UserPromptSubmit` detector
  the PREVIOUS turn, so a pre-fix record's measured value may belong to text the guard did not
  fire on. This is a provenance boundary, not retention: older records stay on disk and remain
  readable by the review panel, which reads counts rather than measured values.

**Read cadence: the existing calibration-review sweep, never mid-session.** The tuner reads the
corpus when the corpus is already being read — at `/calibration-review` cadence — rather than on a
timer of its own or per fire. Two reasons. A threshold that moves mid-conversation makes a guard's
behavior non-reproducible within a single session, so the same turn could be flagged and not
flagged depending on when it landed; and the sweep is where the corpus's read cost is already paid
(`decision-defaults §Thresholds` — ground a cadence in the observed one rather than inventing a
round number). A proposal therefore takes effect at the next session boundary at the earliest.

**A guard with ZERO signal behaves exactly like one with too little.** Both return `no-change` with
`insufficient-labeled-observations`, and that collapse is deliberate: "never fired" and "fired but
not enough to move on" call for the same response — leave the shipped default in force. This is the
opposite of the `coverage-receipt.ts` split, where an empty log has two causes demanding OPPOSITE
responses (`dormant` vs `no-liveness-evidence`, mt#3502) and reporting both as one made the signal
unactionable. The distinction matters there because the question is "is this guard alive?"; here the
question is "should this number move?", and the answer to both cases is no. `silent-stretch-detector`
recorded 0 `warn` decisions across 2230 invocations over 18 days — the zero case is the common one,
not the edge.

### D2 — The response signal is emitted per fire, and its absence is representable

`ObservationResponse` is `"heeded" | "dismissed" | "unknown"`, with `"unknown"` the only value any
shipped emitter produces today. Modeling absence as a value rather than a missing field is the
point: a corpus of unlabeled fires is representable, and the decider refuses it for a stated
reason instead of silently reading unlabeled as dismissed. The gap is in the type system where it
cannot be forgotten.

What counts as `dismissed` — the agent proceeded against the guidance, the operator set the
guard's ack/skip var, a denial was followed by escape-valve use — is the emitter task's design
question, deliberately not settled here.

### D3 — This extends the rationalization review; it does not replace it

The review panel keeps its job: vendor-side, judgment-free, per-guard, human-read. The tuner is a
different question on the same corpus ("should this number move?" vs "does this guard need a
look?"), so it is a sibling pure module rather than a second implementation of the panel. Both
feed the same operator surface. Introducing a second, parallel fire-log consumer with its own
aggregation would fork the corpus's interpretation, which is the outcome ADR-028 §D4 consolidated
calibration logging to avoid.

**Interaction with ADR-024 (detection-mechanism ladder).** That ADR does not govern threshold
ownership — it scopes to how a detector DECIDES a match. But its rung climbs are evidence-gated
on measured rates read from this same corpus, so a tuner that quietly widens a threshold can mask
a recall or precision problem the ladder would answer by climbing a rung. A proposal is therefore
never a substitute for a rung decision, and a guard under active ladder evaluation is out of the
tuner's scope until that evaluation concludes.

### D4 — Phase placement: the local loop is Phase 0/1; fleet aggregation is account-layer

- **Phase 0/1 (this task and its children):** the decider, the response emitter, the local
  actuator, and the customer-vocabulary preference surface. All of it is machine-local, needs no
  account, no telemetry consent, and no hosted pool — a self-hosted single-operator install gets
  the full local loop.
- **Account-layer horizon:** vendor-side aggregation of per-project signal into improved shipped
  defaults. It depends on mt#3334's ingest and on the hosted-vs-self-host fork the beyond-Minsky
  RFC parks — under a hosted pool the exhaust flows to the shared DB natively; under self-host it
  is a telemetry-consent question, which is a product decision and not a mechanism one.

The split is not a sequencing convenience. The local loop's value does not depend on the fleet
existing, and the fleet path cannot be designed before the consent question is answered.

### The customer-vocabulary preference surface

mem#802 is explicit that the customer's only owned job is preference expression _in their own
terms_. `MINSKY_WALL_OF_TEXT_WORD_BUDGET` is the opposite: it names a detector and a unit the
customer never sees. The surface this ADR specifies takes outcome-and-annoyance language and maps
it onto thresholds the customer is never shown:

| What the customer says                    | What it means                    | What moves                                     |
| ----------------------------------------- | -------------------------------- | ---------------------------------------------- |
| "stop telling me my updates are too long" | raise tolerance on report length | `wall-of-text` budget, one bounded step up     |
| "these are still too long"                | same, again                      | another bounded step, until the 10x ceiling    |
| "tell me sooner when you go quiet"        | tighten heartbeat cadence        | `silent-stretch` gap/tool-call thresholds down |
| "stop nagging me about going quiet"       | loosen it                        | same thresholds up                             |

Three properties this surface must hold, and the reason each is here:

1. **No detector names, no numbers, no rates in either direction.** The customer never types a
   threshold and is never shown one; a consent question reads "I've been flagging your updates as
   too long fairly often — want me to ease off?", never "raise `MINSKY_WALL_OF_TEXT_WORD_BUDGET`
   from 200 to 330".
2. **Expression is a nudge, not an assignment.** "Stop flagging this" moves one bounded step and
   is repeatable, rather than setting a value. A customer cannot express a number, so a customer
   cannot be blamed for one.
3. **A `preference`-class move asks; an `advisory`-class move does not.** Per mem#802's per-class
   decision surfaces. `invariant` never appears on this surface at all.

## Consequences

- The corpus gains a new emitter and one new field's worth of meaning per fire. The attention cost
  is zero (nothing is shown to anyone at emit time) and the storage cost is one enum per record.
- Every threshold move becomes explainable from data: the proposal carries its sample sizes, its
  dismissal rate, and whether the bound or a heeded observation decided the value.
- Until the emitter ships, the tuner is inert by construction. That is visible (a `no-change` with
  `insufficient-labeled-observations`), not silent — which is the failure mode this ADR's own
  planning found in the artifact it descends from.
- The customer-facing surface becomes the only place guard tuning is discussed with a customer.
  Calibration review stays vendor-side, as mem#802 requires.

### What would reopen this

- **The response signal turns out not to be labelable.** If "the agent proceeded against the
  guidance" cannot be determined from the transcript at acceptable precision, the local loop's
  input is unavailable and the decision reduces to preference expression alone — a real product,
  but a smaller one.
- **A `preference` guard is found whose threshold cannot be moved monotonically** (raising it
  makes the guard worse in some other dimension). The single-direction model here would need to
  become multi-dimensional, which the bounded-step surface does not support.
- **Fleet aggregation lands before the consent question is settled.** D4 assumes it does not.

## References

**The tasks this ADR decomposes into**, all children of mt#3525:

- **mt#3583** — emit the labeled response signal (§D2). The decisive missing input; everything
  else is inert without it.
- **mt#3581** — the local actuator plus the plain-language consent/preference surface (§D1,
  §The customer-vocabulary preference surface). Consumes mt#3583's output.
- **mt#3582** — vendor-side fleet aggregation (§D4). Account-layer horizon; blocked on mt#3334
  and on the hosted-vs-self-host fork.

- mt#3577 (this decision) · mt#3525 (umbrella) · mt#3518 (the ownership labels) · mt#3334 (ingest,
  the aggregation half's prerequisite) · mt#3576 (wall-of-text calibration records retain no
  measured length — prerequisite for that guard's half) · mt#3280 (turn attribution, the epoch
  above) · mt#2901 (the rationalization review this extends)
- mem#802 (the ownership principle) · mem#816 (the handoff that corrected the "shipped" claim)
- `docs/architecture/adr-028-guard-hook-dispatcher-consolidation.md` §D2, §D4
- `docs/architecture/adr-024-detection-mechanism-ladder-for-guidance-hooks.md` (the ladder this
  must not mask)
- `docs/architecture/evaluation-loop-fire-log.md` (the corpus, its schema, and the Phase-1 GATE
  floor this ADR's cold-start bar reuses)
- `src/domain/calibration/threshold-tuning.ts` (the decider) ·
  `src/domain/calibration/rationalization-review.ts` (the sibling panel)
