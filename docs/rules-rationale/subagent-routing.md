# Subagent Routing — extended rationale

> Extracted from `.minsky/rules/subagent-routing.mdc` (mt#3087 corpus trim, Phase 4). The
> compiled rule corpus carries only the per-dispatch directive; this file holds the mechanics
> detail that motivated each compressed section. Nothing here changes agent behavior — the
> directive text in the rule is the complete behavioral contract.

## Continuation

`SendMessage` IS invocable (deferred-tool list, loadable via `ToolSearch`) and reliably resumes
a **COMPLETED** subagent from its transcript with full context intact — validated `mt#2578`
(PR #1776) and repeatedly since (memory `6038c0a1`). For review-fix rounds and follow-up
iterations on a subagent's own work, prefer `SendMessage`-resume of the same agent over a fresh
dispatch: no context rebuild, no prompt regeneration — bake the findings plus an explicit stop
condition into the message. Messaging a still-RUNNING subagent mid-flight remains untested —
treat "cannot be messaged, kill + re-dispatch" as scoped to that untested case only, not to
resume-after-completion; prefer kill + re-dispatch there until it's validated. (mt#2512; whether
to adopt Agent Teams or build a Minsky-native equivalent for genuine mid-flight steering is
tracked in mt#2521.)

**The mt#2865 stale-pending-note correction.** Memory `6038c0a1`'s own description still calls
this rule-text correction "pending" — it isn't; the rule's Continuation paragraph already
carries it, so treat that memory's pending note as stale. (This is the correction mt#3087's spec
asked to apply while trimming this rule — it turned out to have already landed during mt#2865's
own work; this entry is the citation trail confirming that.)

## Never fork (mt#2865 incident narrative)

The rule's compiled form states the norm (never fork for a bounded lookup from an active
implementation context); this is the incident that grounds it. Confirmed at the transcript level
(2026-07-16): a fork dispatched with a narrow, bounded, read-only instruction ("search memory...
report back under 300 words") instead ran ~70 minutes and ~197 tool calls, independently
implementing overlapping code, committing to the shared session workspace, and editing the shared
PR's title/body/author after the primary implementer had already finalized it — including writing
a false test-count claim into the PR body. The harness's OWN fork-boilerplate prompt already said
"you are NOT a continuation of that agent... execute ONE directive, then stop... do NOT spawn
subagents"; it did not hold. Prompt-level containment is not sufficient once a fork carries a full
implementation context — which is why the compiled rule directs a bounded read-only lookup to a
fresh minimal-context agent (`Explore` / `general-purpose`) instead.

## Undeclared nested fork dispatch is itself blocked (mt#3045)

The dispatch-intent write-gate (`dispatch-intent-write-gate.ts`, cited under Never-fork in the
compiled rule) is opt-in — it only fires once a declaration exists. On 2026-07-21 the pattern
recurred (memory `bed551ef` / mem#665, R2): a nested fork was dispatched via the raw Agent tool
with NO declaration, so the gate never applied. `block-nested-fork-dispatch.ts` closes that gap
one layer earlier: a PreToolUse guard on the Agent tool denies a NESTED `fork` dispatch (the
calling agent's `agent_id` is itself set — i.e. a subagent, not the main thread, is doing the
dispatching) unless a live dispatch-intent declaration (read-only OR implementation) already
covers the calling subagent's session, or the launch-time `MINSKY_ALLOW_NESTED_FORK=1` override
is set. A top-level fork dispatch from the main agent is unaffected.

**Implementation reference (verified):** the guard is `.claude/hooks/block-nested-fork-dispatch.ts`.
The override env var is registered — not a free-text claim — in
`packages/domain/src/configuration/sources/environment.ts`'s `HOOK_ONLY_ENV_VARS` list, with the
comment `"MINSKY_ALLOW_NESTED_FORK", // .claude/hooks/block-nested-fork-dispatch.ts (mt#3045) —
launch-time-only override for an undeclared nested fork dispatch"`, confirming both the hook file
and the override are real, wired code — not an unverified assertion.

## Choosing the model (mt#3043)

`tasks_dispatch` accepts an optional `model`: a dispatch-model registry id (`sonnet` | `opus` |
`haiku` | `fable` — `packages/domain/src/ai/dispatch-models.ts`, the SAME registry the cockpit
launch picker reads, so the two surfaces cannot drift). Omit it to take the registry default; set
it when the task's difficulty warrants a specific tier. Before mt#3043 `suggestedModel` was a
hardcoded `"sonnet"` literal on every dispatch — it carried no caller intent, so passing it
through was a no-op. It now reflects the dispatcher's choice, and is the value to pass as the
harness Agent-spawn `model` arg. An unrecognized id is REJECTED at the tool boundary rather than
silently defaulted, so a typo cannot quietly downgrade a dispatch.

## Reporting register (mt#2867)

Dispatch prompts set the subagent's reporting register explicitly — see
`communication-contract.mdc §Altitude register` for the full mechanics (receipts / standard /
executive, default-derivation table, override, severity triggers). The carve-out that matters
here: an escalation-to-Opus dispatch reports at **receipts regardless of model tier** —
escalation is a low-trust situation, and the stronger model must not invert the register just
because it happens to run Opus. `mcp__minsky__session_generate_prompt`'s Operating-Envelope
template does not yet emit register text into generated dispatch prompts (the `PromptType` enum
has no escalation-context field to key it on — a nontrivial addition, tracked as a follow-up
candidate rather than done here); until it does, name the register explicitly in the
`instructions` param whenever dispatching a struggling-context escalation.

## Cross-references

`communication-contract.mdc §Altitude register` · mt#2512 / mt#2521 (Agent Teams adoption
question) · mt#2865 (never-fork incident + nested-fork write-gate origin) · mt#3045
(undeclared-nested-fork guard) · mt#3043 (dispatch-model registry) · mt#2867 (reporting
register).
