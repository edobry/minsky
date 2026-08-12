# warn-bare-prohibition-dispatch

> Extracted from `.minsky/rules/hook-observers.mdc` (mt#4032) — full narration, the mt#3167
> narrowing and its measurement, and design rationale. The compiled rule corpus carries only a
> terse index entry; this file is the durable detail.

Flags a dispatch prompt that tells a subagent NOT to do something **without stating its basis**.

- **Event:** `PreToolUse` on `Agent` / dispatch-prompt-bearing calls
- **Enforcement:** calibration-first — records, never denies.
- **Override:** `MINSKY_ACK_BARE_PROHIBITION=1`
- **Source:** `.minsky/hooks/warn-bare-prohibition-dispatch.ts`
- **Task:** mt#3162 (build) · mt#3167 (the narrowing)

## Why it exists

A prohibition that crosses a dispatch boundary strips the recipient of standing to correct you.
The dispatched agent cannot tell a policy from a mistaken premise: both arrive as "do not do X."
If the basis was wrong — and `claim-confidence.mdc §Bound a negative claim to the channel you
checked` exists because it often is — the one actor positioned to notice has been told not to
look. mem#702 is the originating incident.

So a prohibition crossing that boundary must carry its basis, plus an explicit licence to falsify
it: _"…if that basis doesn't hold, say so and proceed."_

## The mt#3167 narrowing — a missing licence no longer fires on its own

As shipped, a missing licence-to-falsify was independently sufficient to fire. Measured: **8/8
false positives.** It was catching scope decisions ("don't touch the cockpit in this pass"), role
constraints ("read-only — do not commit"), and guard-backed policy ("do not bypass-merge") — none
of which is a premise the recipient could falsify, so none of which needs a licence.

Since mt#3167, only a bare prohibition with **no stated basis** fires. A missing licence is still
RECORDED, so the class stays measurable, and **the policy to grant one still stands** — the
narrowing changed what the detector says, not what the rule asks for.

## Covers / Does NOT cover

**Covers:** a dispatch prompt whose prohibition states no basis at all.

**Does NOT cover:** a prohibition with a stated but WRONG basis — the detector reads for presence,
not truth. Nor a prohibition delivered mid-flight by `SendMessage` rather than in the initial
dispatch prompt.

## Cross-references

`.minsky/rules/claim-confidence.mdc §Bound a negative claim to the channel you checked` (the rule
this enforces) · `.minsky/rules/subagent-routing.mdc` · mem#702 (originating incident) ·
mt#3162 / mt#3167 · `docs/rules-rationale/claim-confidence.md`.
