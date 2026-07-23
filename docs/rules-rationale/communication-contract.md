# Principal Communication Contract — extended rationale

> Extracted from `.minsky/rules/communication-contract.mdc` (mt#3052 corpus trim). The compiled
> rule corpus carries only the per-turn directive; this file holds the worked example, incident
> recurrence history, and full deferred-scope rationale. Nothing here changes agent behavior —
> the directive text in the rule is the complete behavioral contract.

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
