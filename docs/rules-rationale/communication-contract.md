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

## Register of delivery (mt#3287)

The Tier-1 contract specifies what a report contains and where detail lives; this section
specifies how it reads. Origin: 2026-07-28 incident (conversation `415e072e`) — turn-end reports
rendered routine task-tracker edits as drama; the principal's read: "a weird, Claude-specific
stylistic AI voice … conspiratorial, almost … This isn't engineering writing." Third recurrence
of the AI-voice family: 2026-06-24 (session `aa262f89`: cadence uniformity, reveal-signposting,
faux-profound closers) and 2026-07-17 (session `fd888bf7`: contrastive reframes,
metronome/aphorism cadence — "mimics insight without providing any") both diagnosed the same
disease, but every fix landed on the ARTIFACT surface (`engineering-writing`'s AI-voice-tells
checklist; mt#2899's structural-tier upgrade to it), which chat never loads. This section is the
chat-surface register spec; mt#2899 remains the artifact-surface sibling.

### The structural-tier tells

- **Setup→turn→reveal arc** — the report is plotted as a story ("It's systemic, and already
  tracked." … "I did it anyway.").
- **Beat lead-ins** — paragraphs uniformly opening on a bolded label ("**The fix:**",
  "**Where it stands:**"), giving every paragraph the same dramatic shape.
- **Punch-fragment drum-hits** — short fragments deployed to close a beat rather than state a fact.
- **Significance bids** — flagging one's own work as noteworthy ("one judgment call worth your
  attention"), a claim the content must earn on its own.
- **Bow-tie closers** — "Nothing left on your plate for closeout."
- **Conspiratorial frame** — prose presupposing a shared unfolding operation, casting the reader
  as co-protagonist. This is why the register reads FAKE: the form asserts stakes the content
  does not have, and the reader feels the mismatch before naming it.

### Why the contract itself feeds the register

The contract's imperatives ("lead with what matters," "surface contestable judgment calls")
specify placement, not sound; the model fills the unspecified "how" with its trained theatrical
default, so "surface the judgment call" executes as "dramatize the judgment call." The in-rule
fix decouples them: surfacing a call is one flat declarative sentence carrying its basis.

### Worked pair (from the originating incident)

Flagged: "**One judgment call worth your attention:** mt#3138 states that re-kinding to
`umbrella` is _not_ a safe workaround … I did it anyway. It was safe here for a specific
checkable reason …" — a reveal arc plus an attention bid wrapped around a rule-compliant edit.

Accepted rewrite (same content, flat): "mt#3138 warns re-kinding can strand a task (mt#3137).
That risk didn't apply here: PLANNING is legal in both state machines, and the successful
transition afterward confirmed it."

### Escalation budget

Per `work-completion §Temporary mechanism budget`: 2+ principal flags of dramatic register
within 14 days of this amendment landing means rule-tier is insufficient — escalate to a
log-only detector in the wall-of-text calibration-first pattern (mt#3112 is the structural
template; candidate heuristics: bolded lead-in density per report, punch-fragment count,
known closer-phrase list). Do not build the detector before that threshold trips.

### Growth accounting (mt#3287, 2026-07-28)

This section exists in docs (not the rule) precisely to keep the always-loaded rule small.
Measured at amendment time: source rule `communication-contract.mdc` 7,927 → 9,203 bytes
(+1,276); compiled `CLAUDE.md` 80,832 → 82,294 bytes (+1,462) — under the 2,000-byte
growth-justification gate threshold (`hook-files.mdc`), and far under the compile budget the
mt#3052/mt#3087 trims restored (CLAUDE.md had previously run ~137-141KB). Tier justification:
the amendment revises an existing `alwaysApply` rule in place, and turn-report composition is
per-turn discipline (mt#2874/mt#1876 admission criterion).

## Cross-references

`user-preferences.mdc §Plain-language first` (mt#2801) · `§Progress heartbeats` (mt#2824) ·
`cockpit-deeplinks.mdc` · `humility.mdc §Escalation packaging` · `decision-defaults.mdc` ·
`subagent-routing.mdc §Escalation to Opus` (dispatch-context register carve-out; sets the register
on the consuming side) · `mt#1034` / `docs/architecture/adr-008-attention-allocation-subsystem.md`
· `mt#2713` (Tier-1 contract, this rule's origin) · `mt#2867` (altitude register) ·
`mt#2838` (trust-accrual successor to model tier) · `mt#2869` (Tier-2 digest) · `mt#2870`
(enforcement detector) · `mt#2258` (umbrella) · `mt#3287` (register of delivery) · `mt#2899`
(artifact-surface sibling, `engineering-writing` skill).
