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

## Severity transport binding (mt#3436)

### The incident

2026-07-31, roughly 02:30–06:28Z: the reviewer bot's OpenAI credits were exhausted, so every
review 429'd on "no credits remaining" — a remediation only the operator could perform (an
OpenAI-billing top-up). The agent diagnosed the failure from logs, filed the incident record
(mt#3433), created an ask (`cb89ecf1` / ask#6575) with the billing link and clear options, and
reported the incident at full severity in chat per `§Severity pierces the register` above. Then
it stopped. The ask ran on DEFAULT routing — `serviceStrategy: deadline-bound`,
`transport: inbox`, suspended into the ask-hours window — and no page went out. The operator
found it roughly four hours later in chat scroll and said: "you should have messaged me on
Telegram and really tried to get my attention." `mcp__minsky__principal_notify` — described in
its own tool text as "send the principal a message on their configured channel (Telegram)" — sat
unused in the tool list the entire time. Full incident writeup: mem#779.

### Three root causes (mem#779)

1. **The escalation-capability probe never ran.** The agent probed whether IT could fix the
   billing problem (correctly: no) but never probed whether it HAD an attention channel to the
   principal — the same "checked one channel, concluded the capability itself is missing" shape
   `user-preferences.mdc §Probe before deferring` names for tooling generally.
2. **Severity informed the REPORT, not the ROUTING.** `§Severity pierces the register` correctly
   pierced the altitude register — the chat report was full-detail — but altitude and transport
   are different axes, and `forceImmediate` was never set on the ask.
3. **No structural binding existed.** Nothing in the rule corpus, the ask router, or form-lint
   connected "production incident / operator-only remediation" to a transport requirement; the
   severity-trigger list governed reporting depth only.

### The ask-carries-decision / notify-carries-attention split

Two Minsky primitives serve genuinely different jobs, and the incident happened because they were
treated as substitutes for each other:

- **The ask (`asks_create`) carries the DECISION.** It is durable, structured, and queryable —
  the options, the context refs, and the eventual response all live in the task record regardless
  of how (or whether) the principal was alerted to its existence.
- **`principal_notify` carries the ATTENTION.** It is a one-line page to the principal's
  configured channel (Telegram) — no decision payload, just "something needs you, here is where."

A correctly-formed ask, routed on the DEFAULT service-window strategy, satisfies the first job and
fails the second silently: the principal only discovers it by independently checking the
inbox/scroll. For a severity-triggered, operator-only blocker, both are required —
`forceImmediate: true` on the ask (skips the service-window suspension) PLUS a
`principal_notify` page pointing at it (closes the discovery gap for a principal who has stepped
away).

### Dedupe carve-out

The page is redundant, and should be skipped, when the principal is ALREADY actively responding
in the same conversation. The page exists for the walked-away case — exactly the shape of the
originating incident, a multi-hour overnight gap — not for a principal who is already present and
engaged; paging them mid-exchange adds noise without adding attention.

### Mechanical backstop (mt#3436)

A rule amendment alone is advisory — nothing stops a future turn from repeating the incident. The
`asks.create` form-lint (`packages/domain/src/ask/form-lint.ts`, the mt#3326 seam) adds a sixth,
calibration-first check: `missing-force-immediate` fires when `kind` is `authorization.approve` or
`stuck.unblock`, the question matches incident vocabulary
(`outage|down|credits|failing|production|incident|429`, case-insensitive), and `forceImmediate` is
not set. Unlike the five mt#3326 checks, this one is deliberately **advisory-only** — it is
excluded from `validateFormLintNotViolated`'s hard-reject boundary and only warns (recorded to
`.minsky/ask-form-lint-calibration.jsonl`) — because it has no calibration evidence yet that
authors ignore it. It graduates to blocking only if that evidence accumulates, per the same
calibration-first ladder the five mt#3326 checks themselves went through before they escalated.

That ladder is the default, not a requirement. mt#3477 later added a SEVENTH check
(`missing-decision-options` — a `direction.decide` created with an absent or empty `options`
array) directly to the blocking set, without a calibration term: unlike the vocabulary-matching
check above, it has no false-positive class to measure, because an optionless `direction.decide`
renders zero response buttons by construction. The ladder exists to accumulate evidence about a
HEURISTIC's precision; a check whose precision is structural has nothing to accumulate.

### Cross-references

mt#3433 (originating incident) · mem#779 (incident memory + interim discipline) · mt#3436 (this
structural fix: rule + form-lint backstop) · mt#1596 / mt#2719 (service-side alert-sink — the
sibling mechanism for SERVICE-detected incidents; this section covers the AGENT-detected path) ·
`humility.mdc §Escalation packaging` (the ask's FORM discipline; this section adds the TRANSPORT
half) · `packages/domain/src/ask/form-lint.ts` (the mechanical backstop's
`missing-force-immediate` check) · mt#3326 (the form-lint hard-reject precedent this check
deliberately does NOT join).

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

## Generation-time enforcement for scope-boundary answers (mt#3985)

### The decision: prose, not a detector

R6 of `family:principal-altitude` (mem#664) landed on ordinary conversational answering — the
agent re-argued a dependency's substance instead of stating what the thread needed and stopping.
The family's only enforcement-tier fix is the wall-of-text detector (mt#2870/mt#3112), and it is
Stop-time: it measures the PRIOR turn from the NEXT turn's context. It fired accurately elsewhere
in the R6 session and was irrelevant to the violation itself — a Stop-time signal cannot prevent
a generation-time failure by construction, not by gap.

No generation-time mechanism fits. The violation has no checkable surface property: not length
(the reply that re-argued hook latency was not egregiously long), not a keyword list (there is no
fixed vocabulary for "substance owned elsewhere" — it differs every time), not a template
mismatch (this was a plain answer, not a mis-filled report). Distinguishing "context this thread
actually needs" from "a dependency's substance that belongs to another owner" requires knowing
the current thread's scope and who owns the adjacent concern — a judgment call about
conversational boundaries, not a property of the text. This is a deliberate prose-tier choice per
`/retrospective` step 4's requirement that prose be chosen on purpose: the norm is stated in
`communication-contract.mdc §Scope: every turn, not only report boundaries`, and no cheaper or
more mechanical tier was found to fall back to.

### What would change the decision

A third recurrence inside `mt#2838`'s wrong-register budget (2 incidents / 14 days) is evidence
the rule text alone is insufficient — not evidence a detector is now findable, since the reason
none fits (a judgment call, not a surface property) does not change with recurrence count. The
next escalation, if warranted, is generation-time steering (e.g. a mid-turn nudge), not another
post-hoc scan — untried, not recommended here, and out of this task's scope to build
speculatively.

## A message about how you are communicating (mt#4531)

Rule: `communication-contract.mdc §A message about how you are communicating authorizes nothing`.

**The incident (R7, mem#664, 2026-08-24).** After the principal wrote _"you need to be way more
concise. This is way too much information. I cannot process all of this. We already have
communication style guidelines don't we? Why are you talking this way?"_, the agent acknowledged in
two sentences, invoked a skill and resumed tool work. The principal's next message: _"Okay, no, I
wanted you to summarize all this concisely, not just keep going. Come on."_ The transcript
corroborates it exactly — that turn carried 38 + 5 words of prose and 10 tool calls.

**Why the pull is strong here specifically.** The complaint interrupts work that feels urgent, and
it arrives with no explicit stop instruction, so "acknowledge and continue" reads as efficient.
Aggravating in R7: the `ask-routing-deferral` detector had fired on the agent's prior question, so
at the exact moment the principal wanted fewer words and no action, a live advisory was pushing
toward action. Two advisories pulled opposite ways and the wrong one won. That is what the
precedence half of the rule settles.

**Why the deferral detector's payload does not restate the precedence rule.** It would be the
obvious place — the conflicting pull originates there — and it is the wrong place. That guard's
`attentionCost.denialMessageSizeChars` is 1121, and its declaration in
`registry-prompt-scan-guards.ts` records that number as an exact measurement of the saturated
render, states that raising it again is not the fix (trimming the prose is), and notes that raising
it cascades into `MERGED_CONTEXT_BUDGET_CHARS`. The same comment warns off redesigning that payload
while mt#4201 / mt#3932 / mt#4175 are in flight on what makes the detector FIRE. And the rule is
always-loaded, so it is already in context whenever the detector fires — a second copy would cost
~142 chars per fire plus a budget cascade to say something the reader already has. The pointer
lives in `hook-observers.mdc`'s entry for the detector and at its `buildReminder` call site.

### Revisited after R7 (mt#4531, 2026-08-25): the prose choice stands, and one premise above is now wrong

R7 arrived thirteen days after this decision shipped, and the task that filed it claimed the
recurrence falsified "deliberately prose, not a default." **It does not.** R7 is a different
surface — a turn-end report that ran long, not a scope-boundary answer — so it is not a test of the
decision recorded here, which is scoped to "substance owned elsewhere." Read the paragraphs above
as still current on their own subject.

**What R7 does correct is a factual premise stated above**: _"The family's only enforcement-tier
fix is the wall-of-text detector … and it fired accurately elsewhere in the R6 session."_ The
accuracy claim was inherited rather than checked. Replaying the R7 session showed the detector
measuring only the FINAL assistant block of a turn, so a 597-word wall sitting in the FIRST block
of an 854-word turn measured as 110 words and produced no fire at all. It was not a Stop-time
signal arriving too late; on that turn it was a signal that could not see the thing it was built to
see. mt#4531 fixed the measured unit (largest block, chosen by replaying 2574 turns).

**Two consequences for this section's reasoning, in opposite directions.** The Stop-time limit it
names is real and unchanged — a post-hoc scan still cannot prevent a generation-time failure. But
"no cheaper or more mechanical tier was found" was reached partly on the belief that the existing
detector was working correctly and was simply mistimed. One of the two was false, and a
measurement defect is exactly the kind of thing a "no mechanism fits" conclusion should be checked
against before it is recorded. The prose tier stands here; the lesson is that the SURVEY behind a
tier decision deserves the same verification as the decision.

**Also corrected: R7 is not evidence that an advisory carries no weight at generation time.** The
original filing said the detector fired and three more over-budget turns followed. The transcript
shows one fire, and the three turns after it measured 110, 5 and 152 words at the final block — the
reminder was COMPLIED WITH, narrowly, while total turn prose rose. mem#664's R7 entry carries the
correction.

### Cross-references

mem#664 (family root, R1–R7) · mt#2870/mt#3112 (the one enforcement-tier fix that exists, and its
Stop-time limit) · mt#4531 (the R7 measurement fix; ADR-031 amendment) · mt#4540 (the
depth-request override R7 also implicates) · mt#2838 (wrong-register escalation budget) ·
`/retrospective` step 4 (tier selection discipline).

## The terminal actionables block (mt#4443)

### The reconciliation with §Anti-patterns

"Burying the needed-decision below the fold" was written as a placement complaint, but its own
parenthetical already names the actual violation: **"a Tier-0 decision routed through prose
instead of Asks."** The failure is ROUTING (prose in place of an Ask), not position. A Tier-0
decision that never reaches `asks_create` is buried wherever it sits in a report — first sentence
or last — because nothing marks it as decision-grade and nothing routes it to where a
decision-grade item is supposed to land. Conversely, a non-blocking item set off by a rule and a
heading at the very end is findable without reading the body, which is the opposite of buried. The
terminal block and the anti-pattern bind on different axes (routing vs. marking) and do not
contradict once that is made explicit — which is why the rule text ties the anti-pattern's
parenthetical directly to §The terminal actionables block rather than leaving two clauses a single
report could be judged against in opposite directions.

### Engaging mem#664 — the six failed prose fixes

mem#664 records `family:principal-altitude`'s R1 through R6, all DONE, all of which failed to
contain principal-facing information landing at the wrong altitude. Its own diagnosis for WHY
prose fixes kept failing is explicit: _"the family kept spawning new surfaces because the norm was
never stated surface-generally"_ — recurrences moved to gate output, RFC bodies, closeout reports,
and ordinary conversational answering, surfaces none of the six fixes named.

The mt#4443 spec's defense for shipping a seventh prose change is a granularity claim: the six
failed fixes required running discipline across an entire report (plain-language-first
throughout, avoid narrative tells throughout, stay under a word budget throughout) — many small
decisions, each cheap to skip under pressure — while the terminal block is one compositional
decision, made once, at the natural pause of turn-end.

**Checking the claim against the record rather than accepting it:** the family's very first fix,
mt#2713 (R1), was ALSO a compositional, turn-end structural change — the three-part BLUF ordering
— and the family still produced five further recurrences afterward, including one (R4,
2026-07-22) on the SAME surface (a chat turn-end report) about one week later. On inspection,
though, R4(a)'s specific defect was a word-budget overrun and label-led framing — axes that
mt#2801 and mt#3287 fixed LATER, not the three-part ordering mt#2713 shipped — so R4 is not
literally "the same fix decaying on its own terms." mem#664's own causal account (surface
enumeration, not utterance granularity) is the stronger explanation for why the family recurred,
and it does not obviously predict that a compositional fix is safer than a running one.

**Conclusion: the granularity distinction is real in kind, and it is not established as
sufficient by this record.** It is plausible — a single decision at a natural pause is a smaller
ask than continuous vigilance — but the corpus has not yet tested that specific shape and failed,
so absence-of-failure is not evidence of success either. This is why the rule text does not claim
the argument settles anything: the escalation threshold (2 reports of buried actionables in 14
days → record it on mt#4439 as evidence) is the actual check, not the granularity argument. Ship
this as what it is — a cheap, falsifiable, interim measure — not as a fix the corpus has reason to
expect will hold.

### Why this is defensible to ship anyway

Despite the above, shipping is still the right call, for reasons independent of the granularity
argument:

1. **The cost of being wrong is low and bounded.** If the block decays like its predecessors, the
   escalation threshold catches it within two incidents and routes the finding to mt#4439 — the
   design already in flight — rather than spawning an eighth ad hoc prose patch.
2. **It costs two rule edits and is trivially reversible.** Unlike the six prior fixes, this one is
   explicitly labelled interim in its own text, so a future editor is not misled into treating it
   as settled.
3. **It is field-tested at n=1** (roughly eight turns in the conversation that produced it) — weak,
   stated as weak, not cited as validation.

### Cross-references

mem#664 (`family:principal-altitude`, R1–R6, all fixes DONE) · mt#4439 (the composition-layer RFC
this is the interim of) · mt#4442 (the umbrella workstream) · `work-completion.mdc §Temporary
mechanism budget` (the escalation-threshold discipline this follows).

## The composition layer — register/volume vs channel/sort (mt#4439)

The altitude register above is a **volume** dial: receipts / standard / executive control HOW MUCH
gets said on one channel. A separate axis was never addressed — **which channel a given utterance
belongs to at all.** This section records the distinction, and the principal's brief that produced
it, so that a later reader cannot collapse the two and "fix" a sorting complaint by turning the
register down.

Full design: **RFC: The composition layer — a delivery boundary for the agent↔principal channel**
(Notion `3c6937f0-3cb4-81dc-95d0-d6cdf59dfaee`), Draft 2026-08-24. Task record: mt#4439.

### The two axes, stated so they cannot be conflated

- **Register / volume (SHIPPED, mt#2867).** How much is said. A verbose report and a terse report
  differ on this axis.
- **Channel / sort (THIS, open).** Whether an utterance is working-noise or composed delivery. A
  verbose composed report and a terse composed report are BOTH composed; a wall of
  thinking-while-working is composed at NEITHER volume.

**The one-sentence test** (an acceptance criterion of mt#4439): turning the register down makes the
stream shorter without making it sorted — which is why the register shipping in July did not
prevent the complaint that arrived on 2026-08-22.

### The principal's brief, verbatim — including the correction

The task was first filed on the diagnosis _"he reads to the end, so put actionables at the end."_
**He corrected that himself, the same day**, and the correction is preserved here because inheriting
the original framing would re-derive the wrong fix:

> _"The fact that I read to the end is a consequence. It's a contingent consequence of the way that
> I've been trained to interact with AI ... There's a big wall of text and my eyes kind of glaze
> over it because a lot of it is thinking done while working versus a direct response to me."_

**End-reading is an ADAPTATION to the defect, not a property of the reader.** A placement rule
optimizing for it would cement the symptom and leave the cause.

What he asked for instead is attunement:

> _"Really on a higher level what I'm asking for here is more about attunement ... for the agent to
> attune to what I, or honestly any supervisor or entities interacting with a counterparty
> interlocutor, would want to know."_

The managerial coaching he offered as the model — note that it is neither "say less" nor "reorder,"
but _build a model of the counterparty and sort your material against it_:

> _"Hey don't just dump all the technical context and all that stuff on to everybody there. Keep
> that aside and then figure out what information is actually relevant to communicate."_

And the structural diagnosis, which is a claim about the substrate rather than about discipline:

> _"When the agent speaks, the agent does tool calls and then the agent sometimes does thinking.
> All those are basically the same ... To me it feels like there's a sort of missing layer. There
> isn't room for the agent to carve out some space explicitly to structure the communication with
> the outside world within."_

**Personal-register note.** The principal introduced the meetings analogy through his own
description of his own history. Reuse it as HIS analogy if it is quoted; do not restate it as a
characterization of anyone else, and do not treat it as a description of the agent's defect. The
transferable content is the coaching, not the label.

### Why two adjacent mechanisms do not cover it

- **The heartbeat rule MANDATES the noise.** `user-preferences.mdc §Progress heartbeats` requires a
  status line every 10 minutes or 15 tool calls, at _every_ register, explicitly as scroll lines.
  That rule is correct — silent stretches left the principal blind — and it has nowhere to put its
  output but chat. Part of the wall is a rule working as designed.
- **The cockpit's fold cannot absorb it.** `turnIsFoldable`
  (`src/cockpit/web/lib/conversation-action-bursts.ts:154`) folds only turns that are pure
  machinery; its docblock states the rule outright — _"A turn holding BOTH prose and a tool call is
  not foldable — it has speech in it, so it stays."_ Process narration IS prose, so it is exactly
  the class that escapes the fold.

### The three categories, and the one with no home

|                       | what it is                                    | audience                              | home today                       |
| --------------------- | --------------------------------------------- | ------------------------------------- | -------------------------------- |
| Reasoning / CoT       | cognition that happens to be legible          | none — the model to itself            | yes; harnesses collapse it       |
| **Process narration** | _"Let me check X." "Now wiring the handler."_ | the principal, live, for supervision  | **NO**                           |
| Composed delivery     | the answer, the report, the packaged result   | the principal, at the decision moment | yes — chat, PR body, task record |

The middle row is speech-shaped and addressed (so not CoT) and unsorted and uncomposed (so not
delivery). **It enters the delivery channel because that is the only channel it can reach.**

mt#4441's survey recut this by **value half-life** rather than audience, which exposes a fourth
class the audience cut leaves homeless: **durable content emitted mid-work** ("the prod config was
already broken") — not narration, because it does not expire; not composed delivery, because nobody
packaged it. Under half-life it defines composition's job: **composition is the act of sweeping the
durables out of the ephemeral stream into the package.**

### The honest limit

**Structure creates the room, not the attunement.** A boundary and a fold neither build nor apply a
model of the counterparty. The mechanism guarantees the MOMENT of composition, not its QUALITY —
and the RFC says so plainly rather than letting a reader infer that shipping the primitive
discharges the brief.

### Cross-references

mt#4439 (the design) · mt#4441 (the CSCW / agent-framework survey that corrected it) · mt#4443
(§The terminal actionables block — the interim this retires) · mt#4026 (surface declaration, a
prerequisite for the two-renderer split) · mt#2531 (fatigued compressor) · mt#4444 (Suchman's
double-edge, principal-reserved) · mem#903 (the 2026-08-08 narration-theatre correction).

## Cross-references

`user-preferences.mdc §Plain-language first` (mt#2801) · `§Progress heartbeats` (mt#2824) ·
`cockpit-deeplinks.mdc` · `humility.mdc §Escalation packaging` · `decision-defaults.mdc` ·
`subagent-routing.mdc §Escalation to Opus` (dispatch-context register carve-out; sets the register
on the consuming side) · `mt#1034` / `docs/architecture/adr-008-attention-allocation-subsystem.md`
· `mt#2713` (Tier-1 contract, this rule's origin) · `mt#2867` (altitude register) ·
`mt#2838` (trust-accrual successor to model tier) · `mt#2869` (Tier-2 digest) · `mt#2870`
(enforcement detector) · `mt#2258` (umbrella) · `mt#3287` (register of delivery) · `mt#2899`
(artifact-surface sibling, `engineering-writing` skill) · `mt#3436` (severity transport binding) ·
`mt#3433` (originating incident) · `mem#779` (incident memory).
