# Decision Defaults — extended rationale

> Extracted from `.minsky/rules/decision-defaults.mdc` (mt#3052 corpus trim; extended mt#3068 —
> full index-compression per the 2026-07-22 context-injection audit, mem#682). The compiled rule
> now carries, per policy, only the trigger + Minsky-answer one-liner + generic-SE-override
> phrase + a pointer here; this file holds the fuller self-check detail, worked checklists,
> multi-step protocol mechanics, and the consolidated cross-reference index. Nothing here changes
> agent behavior — the directive text in the compiled rule is the complete behavioral contract.

## Build vs buy — anti-pattern checklist (full detail)

Before recommending OR executing build for a non-core capability:

- [ ] Did I elicit user priorities (cost tolerance, time horizon, lock-in tolerance,
      core-vs-auxiliary stance)?
- [ ] Did I evaluate ≥3 mature options with concrete comparison, not just name them?
- [ ] Did I anchor on the first option named in my prior turn? If yes, force a fresh evaluation.
- [ ] Is my "principled" framing preference-laundering? (Principled story arriving AFTER the
      build preference = laundering.)
- [ ] **At action time:** is my first action "extract from existing in-house data"? That IS the
      build path — stop, restate the plan, name the skipped step.
- [ ] **At action time:** multi-step direction + "do it now" → restate steps first (see
      `§Multi-step direction execution — full mechanics` below).

Origins: R1 + R2 (2026-05-12) — `feedback_build_vs_buy_default_for_non_core`,
`feedback_build_path_as_research_at_action_time`.

## Build vs buy — biases to watch for in self (full detail)

(1) **Policy-laundering** — citing `§Datastores` to justify building auxiliary analytics on
Postgres; that policy covers source-of-truth state only. The tell: recommending the cheaper
option AND describing it as "principled." Any "per `§X`"-style claim that a rule section covers
the current case is a trigger to re-verify that section's actual scope first — full trigger
enumeration in memory `88d92439`.

(2) **Build-path-as-research at action time** — "use existing signals" / "grep what's already
there" reads as research but is functionally the build path, skipping the user-sequenced
evaluation step; see `feedback_build_path_as_research_at_action_time`.

## Missing MCP tool — full incident list

Origins: mt#1983, shipped via mt#1988; memories `3408717a` (bridge), `b30bfabe`, `39701a9a`,
`7f67af43`; siblings mt#1196/mt#1197/mt#1989. **On recurrence, escalate to hook-tier** (the
policy-coverage detector mt#2755 is the eventual structural home).

## Agent todos vs. Minsky tasks — worked examples

The position paper [_Agent todos vs. Minsky tasks_](https://www.notion.so/35e937f03cb4812e9734f0c0f9a8b26c)
carries worked examples plus the Shape A/B/C frame (first instance mt#1316; Shape-C follow-up
mt#1797).

## Premise verification — full protocol (subsystem moves & spec amendments)

The compiled rule's `§Premise verification` entry merges two originally separate policies that
share the same four-step cite/quote/map/verdict protocol and the same bridge memory:

### Subsystem-assignment verification (R5, 2026-05-17)

When recommending content move FROM one subsystem TO another — rules ↔ memory, memory ↔ skill,
skill ↔ rule, doc-type → doc-type, code-module ↔ code-module — run the same four-step protocol
at recommendation-time: **cite** the destination subsystem's defining rule; **quote** its
inclusion/exclusion criteria verbatim; **map** the source content's properties to the criteria;
**state the verdict** (met / not met / ambiguous). If NOT MET, the migration is wrong —
subsystems are defined by their criteria, not their names.

Generic-SE override: "X is for durable knowledge → durable Y belongs in X."

Origins: R5 (2026-05-17). Phase 1 shipped via mt#1868; Phase 2 is mt#1873. Bridge:
`feedback_premise_label_verification_required`.

### Spec-amendment-time premise check (R4, 2026-05-13)

Third confabulation surface: **spec amendment** — applying a categorization label that
determines an artifact's substrate/policy treatment. Before writing such a label: (1) cite the
rule that defines the label; (2) quote the definition verbatim; (3) map the artifact's
properties to the criteria; (4) state the verdict (met / not met / ambiguous). If the mapping
fails, don't apply the label — surface the gap. Enforcement: `/plan-task` gate (j) (mt#1820).
Origin: mt#1306 — `feedback_premise_label_verification_required`; family root `88d92439`.

## Multi-step direction execution — full mechanics

When the user gives multi-step direction ("X first, then Y, then Z") AND a later prompt contains
action-now language ("do it now," "proceed," "go"): before any tool call advancing the plan —
(1) **restate the plan**, one line per step; (2) **identify the next step explicitly**; (3)
**name any skipped step** — if the cheapest immediate action skips a more expensive user-named
prerequisite, stop and confirm. Action-now language is permission to act, NOT permission to
compress steps.

Generic-SE override: "act on the most recent direction; treat earlier direction as context."

Origins: 2026-05-12 R2 — `feedback_multi_step_direction_compression`. Enforcement:
`/restate-plan` skill (mt#1784).

## Turnkey, not portal — origin detail

mt#1507 (original); mt#2150 → mt#2294 (Cockpit widget-ID hand-edits, retired by
registry-gating).

## Security-surface changes — origin detail

mt#1477 — memory `22a55d66`. Enforcement: `/plan-task` gate (l), restored + generalized via
mt#2445 (original: mt#2090).

## Cross-references (full index)

`humility.mdc` (the design principle this corpus operationalizes); `operational-safety-dry-run-first.mdc`;
`work-completion.mdc §Temporary mechanism budget`; mt#1034 / mt#1035; mt#2755; mt#1508
(originating audit); `/declare-framework` (mt#1789); `/restate-plan` (mt#1784). Per-section
origins are cited inline in the rule.
