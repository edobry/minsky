# Terminology: Workspace vs. Conversation vs. Transport Session — extended rationale

> Extracted from `.minsky/rules/terminology-workspace-conversation.mdc` (mt#3087 corpus trim,
> Phase 4). The compiled rule corpus carries the three-sense table and both normative rules
> (what does NOT change, URI types are NOT renamed) in full; this file holds the fuller
> enumeration and cross-reference detail. Nothing here changes agent behavior — the directive
> text in the rule is the complete behavioral contract.

## What this rule does NOT change — full enumeration

- No `session_*` MCP/CLI tool name, parameter name, or DB column is renamed.
- No `~/.local/state/minsky/sessions/` path changes.
- Back-compat aliases from mt#2526 (`transcripts_*` param renames) are untouched.
- Existing docs/prose keep their current vocabulary until stage 2 or an opportunistic edit —
  this rule does not require a docs back-fill pass.

## `minsky://` URI types are NOT renamed — full rationale

The entity-codec's type→route mapping already absorbs one such divergence today — the `session`
URI type resolves to the `/agents/:id` cockpit route, not a literal `/session/:id` path — and
continues to absorb the stage-1 cockpit rename the same way: the URI **type name** is a stable
public identifier; the cockpit **route/component name** is free to carry the new vocabulary.

## Cross-references

- `docs/architecture/adr-022-session-vs-conversation-terminology.md` — the ADR this rule
  operationalizes (Accepted 2026-07-06).
- `cockpit-deeplinks.mdc` — the `minsky://` URI format; its `session` row notes the
  URI-type/route divergence this rule generalizes.
- mt#2522 — epic; mt#2524 (branded ids), mt#2525 (id-space hardening), mt#2526 (conversation
  labeling) — DONE prerequisite tiers; mt#2686 — this rule's originating task (stage 1);
  mt#2527 — stage 2 (the deferred mechanical tool-surface rename).
- Funding decision: 2026-07-06, ask f0782a96; living record memory 805ef48f.
