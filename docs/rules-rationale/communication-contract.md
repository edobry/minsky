# Principal Communication Contract — extended rationale

> Extracted from `.minsky/rules/communication-contract.mdc` (mt#3052 corpus trim). The compiled
> rule corpus carries only the per-turn directive; this file holds the worked example, incident
> recurrence history, and full deferred-scope rationale. Nothing here changes agent behavior —
> the directive text in the rule is the complete behavioral contract.

## Altitude register — full shape table

| Register      | Turn-report shape                                                                                                                                                                                                                                                     | Before/after acting                                                         |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **Receipts**  | Narrated checkpoints; verification evidence inline for consequential actions; intent stated before significant moves ("I intend to…"). Trivial successful steps still compress — the register sets audit depth for what matters, not a verbosity floor on everything. | Report-before-action for consequential moves.                               |
| **Standard**  | The Tier-1 BLUF contract: what happened / what you need to know / what's next, each 1–3 sentences, pointers for everything else.                                                                                                                                      | Mixed.                                                                      |
| **Executive** | Outcome + judgment calls + needed decisions only; routine success is one line; everything else by pointer.                                                                                                                                                            | Report-after-action ("I've done…"), with scheduled receipts-level sampling. |

## Default derivation — full mechanics

The harness already reports which model is running; no new infrastructure is needed. In this
repo's model vocabulary:

| Model / context                                 | Default register |
| ----------------------------------------------- | ---------------- |
| Fable/Opus-class, principal-facing conversation | **Executive**    |
| Sonnet-class working session                    | **Standard**     |
| Haiku-class or unproven context                 | **Receipts**     |

**Escalation-dispatch carve-out (dominates model tier).** An agent dispatched _because_ the
orchestrator is struggling — the escalate-to-Opus pattern, `subagent-routing.mdc §Escalation to
Opus` — reports at **receipts regardless of tier**. Escalation is a low-trust _situation_: the
stronger model was chosen because the situation demands more scrutiny, so the register must not
invert that by defaulting a struggling-context dispatch to executive merely because it happens to
run Opus. Dispatch context outranks model tier — the dispatcher sets the register explicitly in
the dispatch prompt (see `subagent-routing.mdc` for the consuming side of this contract).

**Temporary-mechanism budget.** Model tier is _asserted_ trust — fixed the moment a model is
picked — not _accrued_ trust (a track record). The accrued-trust successor is `mt#2838`.
Escalation budget: **2 wrong-register incidents within 14 days** escalates `mt#2838`'s priority (a
wrong-register incident = the principal manually re-registers a conversation because the default
hid something needed or buried the signal in noise).

## Override — full mechanics

Exactly two levels, in precedence order:

1. **Explicit principal instruction** — a one-line "walk me through everything" or "background
   this" re-registers the conversation and **persists for the rest of the conversation**. The
   per-message escape hatch ("show me the detail") always works without changing the standing
   register.
2. **Derived default** — the model-tier-plus-dispatch-context table above.

The three-level stack (instruction > persisted setting > default) is **explicitly deferred** — it
activates only once a persisted per-conversation/task register state ships, which is itself
deferred pending evidence that rule-tier alone is insufficient. Do not build that storage
speculatively.

**Task-record continuity.** Until persisted state ships, an override recorded in the task record
or a handoff note is honored by later conversations on the same task — check the task record /
handoff for a standing register override before defaulting. Skipping this check silently resets
every new conversation to the default and forces the principal to repeat the instruction.

## Executive scheduled sampling — full rationale

The executive register keeps active auditability even at maximum compression:

- **Every 5th turn-end report** renders one register lower (i.e., at standard) instead of
  executive.
- **Every task-closeout report carries the verification-evidence pointer set** (deeplinks to the
  gate report, test run, or live-verification output), regardless of sampling cadence.

This exists because agent silence is self-assessed — unlike a dark cockpit's instrument-verified
silence — so the executive register cannot rely purely on the agent's own judgment that nothing
warrants reporting.

## Worked example: the 2026-07-08 originating incident

Origin: `mt#2713` §Originating signal (the principal's multi-screen-report pushback this shape
derives from; ids below are illustrative). "**What happened:** Two PRs merged
([PR #1](minsky://changeset/1), [PR #2](minsky://changeset/2)); umbrella [mt#100](minsky://task/mt%23100) closed. **What you
need to know:** one judgment call — bypass-merged under a documented escape valve; no other
exceptions. **What's next:** nothing pending." A partial turn folds status into "what happened"
instead of a fourth heading.

## Decision artifacts lead with the decision — recurrence history

Stated surface-generally on purpose: this family recurred four times in 14 days (2026-07-08 chat
reports, 07-15 planning-gate output, 07-21 and 07-22 RFCs), each time on a surface whose own fix
did not exist yet, because the norm had only ever been written per-surface. A new surface is
covered by this clause the first time, not the second. Enforcement lives in the authoring skills
(`/draft-rfc` step 7, `/draft-adr` step 5, `engineering-writing §Decision artifacts lead with the
decision` — which otherwise silently overrides this rule, being the more specific writing advice).

## Scope — full rationale

This rule ships the Tier-1 turn-report contract, channel model, and (as of `mt#2867`, RFC Phase 2)
the altitude register's default-derivation, override, continuity, and severity mechanics. It
deliberately does **not** ship:

- **Persisted per-conversation/task register state** (a session-record field or a cockpit
  control — file only if rule-tier proves insufficient; see the rule's `§Altitude register
§Override`).
- **Trust-accrual register input** (successor to the model-tier proxy, `mt#2838`).
- **A Tier-2 digest** (RFC Phase 3, owned by `mt#2869`, depends on mt#2713, ambient-cockpit push
  discipline with a pull-only-widget fallback).
- **A calibration-first enforcement detector** (wall-of-text/shape-violation, Phase 3, owned by
  `mt#2870`, depends on mt#2713 — per the ADR-024 ladder this rule is the cheapest-sufficient
  rung; the detector graduates only on calibration evidence).

## Cross-references

`user-preferences.mdc §Plain-language first` (mt#2801) · `§Progress heartbeats` (mt#2824) ·
`cockpit-deeplinks.mdc` · `humility.mdc §Escalation packaging` · `decision-defaults.mdc` ·
`subagent-routing.mdc §Escalation to Opus` (dispatch-context register carve-out; sets the register
on the consuming side) · `mt#1034` / `docs/architecture/adr-008-attention-allocation-subsystem.md`
· `mt#2713` (Tier-1 contract, this rule's origin) · `mt#2867` (altitude register) ·
`mt#2838` (trust-accrual successor to model tier) · `mt#2869` (Tier-2 digest) · `mt#2870`
(enforcement detector) · `mt#2258` (umbrella).
