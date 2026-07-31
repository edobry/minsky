# Design Principle: Humility — extended rationale

> Extracted from `.minsky/rules/humility.mdc` (mt#3087 corpus trim, Phase 4). The compiled rule
> corpus carries the core principle statement and BOTH escalation-packaging checklists
> (Mechanical checklist + Form) verbatim — those are the reviewer-scrutinized
> verbatim-preservation constraint for this file and were not shortened. This file holds
> connecting narrative that was trimmed around them. Nothing here changes agent behavior — the
> directive text in the rule is the complete behavioral contract.

## Escalation packaging

The "Mechanical checklist" (5 items: state the question in plain language, inline full option
content, list decision drivers, make a recommendation, name what's not needed) is the
manual-discipline form of stage 4 (Packaging) in the Ask subsystem (`mt#1034`). When that
subsystem ships, the packaging discipline becomes structural; until then it is checklist-driven.
See `feedback_escalation_packaging.md` for the originating incident (mt#1316, shape A/B/C) — a
decision correctly identified as principal-level but packaged in a form (referent-only options,
no inline content) that forced the user to round-trip for context.

## Form

The "Form" checklist (6 items: lead with the action, name concrete objects, link the destination,
no agent jargon, ~120-word body budget, options-are-the-buttons) addresses a distinct failure
mode from completeness: an escalation can satisfy every Mechanical-checklist item and still be
unusable if it reads badly. Originating incident: ask `6807fb14` (2026-07-15, R5 of the
escalation-packaging family) — routed to the right decision-maker, packaged with complete content,
but written in a form (role-labeled objects, buried action, no direct link) the principal could
not act on without further digging.

## Cross-references

`mt#1034` (Ask subsystem, stage 4 Packaging) · `communication-contract.mdc §Judgment calls are
load-bearing` (the sibling discipline for reports rather than escalations) · `humility.mdc`
(the compiled rule this document extends).
