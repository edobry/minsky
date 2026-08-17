# Ask-Routing Deferral Detector (calibration)

> Extracted from `.minsky/rules/hook-files.mdc` (mt#2620) — full incident narration,
> cross-references, and worked examples for this hook/guard. The compiled rule corpus
> carries only a terse index entry; this file is the durable detail.

A `UserPromptSubmit` hook that scans the prior assistant turn for **decision
deferrals routed to the principal via chat prose** instead of through the Ask
substrate. In **v1 / calibration mode** it logs matches to a JSONL file and
injects **nothing** — the injection gate (`INJECTION_ENABLED`) is `false`.
After ~10 fires, review the FP rate (via the `calibration-review` skill); only
then flip the flag. Same rollout pattern as the causal-premise detector
(mt#2216) and retrospective-trigger scanner (mt#2057).

> **Correction (2026-07-15, mt#2835).** The paragraph above describes the
> original v1 calibration-only rollout and is now stale: `INJECTION_ENABLED`
> flipped to `true` in code on 2026-07-08 (mt#2694), after the calibration
> data confirmed an acceptable FP rate. That flip alone did not make the
> detector live, though — it shipped into the same ADR-028 Phase 2b migration
> whose `auto-session-title.ts` guard had an ungated module-level `main()`
> that killed the entire `dispatch-userpromptsubmit.ts` process (all 15
> UserPromptSubmit guards, this one included) before any guard's output was
> written, for the detector's whole "live" life to date. mt#2835 is the fix
> that actually makes the mt#2694 flip take effect in production — see that
> task for the root-cause writeup.

**Hook file:** `.claude/hooks/ask-routing-deferral-detector.ts`

**Two sub-classes:**

- **PRINCIPAL-RESERVED** — phrases handing a decision to the principal in prose
  ("needs your call", "that decision is his", "you decide", "reserved for
  Eugene", "waiting on your decision", "surface to you"). The fix the reminder
  names: package per `humility.mdc §Escalation packaging` and file via
  `mcp__minsky__asks_create` (kind `direction.decide`) — or cite an existing
  open ask id.
- **DEFERRAL-MENU** — option-menus / "do nothing" recommendations / hand-back
  shapes ("what's your call?", "say the word", "stop here" as a recommendation,
  "want me to X or Y?"). The fix: route through `/classify-before-deferring`
  FIRST (Class A → run the lookup now; Class B → apply the standing default;
  only Class C → asks_create). NOT unconditionally an ask.

**Suppression:** INJECTS only when the same assistant turn contains **no**
`mcp__minsky__asks_create` tool_use (the agent already routed the decision).
Quoted/code/blockquote contexts are elided before scanning (offset-preserving),
so a phrase the agent is DESCRIBING — e.g. documenting this detector — does not
fire.

Since mt#3207 the suppressed case still RECORDS. Detection runs first and the
gate is applied second; before that, the gate returned before detection ran, so
a deferral phrase in a turn that also routed an ask produced no record at all —
indistinguishable from a clean turn, and the gate looked costless to the
calibration sweep.

**Calibration JSONL:** `.minsky/ask-routing-deferral-calibration.jsonl` — each
record carries `timestamp`, `session_id`, `injection_enabled`, `matches[]`
(`{class, phrase}`), and `suppressionReasons[]` — empty when the reminder was
injected, `["asks-create-this-turn"]` when the gate withheld it.

**Originating incidents (escalation-packaging family, memory `3e3f29d8`):**
R1 2026-04-26 (mt#1316 A/B/C labels), R2 2026-06-02 (mt#2249 buried decision +
AskUserQuestion instead of asks_create), R3 2026-06-09 (mt#2374 `/plan-task`
closeout, rail-axis by pointer), R4 2026-06-12 (end-of-session summary, same
rail-axis question, no ask). Plus the post-closeout register-shift sub-class
(memory `6abe89c6`, 2026-06-11 mt#2394 closeout). 0-for-4 unprompted compliance
at the behavioral-checklist tier drove the hook-tier escalation.

**Override mechanism:** Set `MINSKY_ACK_ASK_ROUTING_DEFERRAL=1` (or `true` /
`yes`) to suppress detection and emit an audit line to stdout (non-JSON per
sibling-hook convention).

**Env-var registration:** `MINSKY_ACK_ASK_ROUTING_DEFERRAL` is registered in
`HOOK_ONLY_ENV_VARS` at
`packages/domain/src/configuration/sources/environment.ts` per the
`custom/no-unregistered-minsky-env-var` ESLint rule (mt#1788). The override
env-var name's source of truth lives in the hook file as the exported constant
`OVERRIDE_ENV_VAR`.

**Skill-step tier (paired with this hook):** `/plan-task` Step 4 closeout and
`/handoff` Step 5 both carry an "ask-or-cite-ask" requirement — a principal-gated
dependency/next-step must be filed (or an existing ask cited), not referenced by
pointer. The hook is the always-on detector; the skill-steps are the in-chain
enforcement at the two closeout surfaces where R3/R4 occurred.

**Fail-open posture:** any error reading the transcript or running detection
exits 0. The hook never blocks the user prompt.

## The offer shape as a structural trigger (mt#3801)

The `deferral-menu` sub-class above is an enumerated phrase corpus. It is
interrogative or imperative throughout — "what's your call?", "say the word",
"want me to X or Y?" — and a **negated default** matches none of it:

> Next step is `/plan-task mt#3799` unless you'd rather I go straight at it.

That sentence hands the continue/redirect decision over exactly as squarely as
asking would, and on 2026-08-05 it closed a turn with this detector silent. The
Stop sibling (`turn-end-untaken-action-scan`) did fire, but on its COMMITMENT
branch — it matched the `next-up` family and told the agent to "take it now",
because its `deferralShaped` flag is derived from `detectDeferralPhrases`, which
had nothing to say. mt#3767 had built an offer branch for precisely this
sentence six days earlier; the classification never reached it.

**The recognizer already existed.** `hasMenuShape` tests for `?`, a disjunction,
`unless`, and `if you'd rather` — offer STRUCTURE rather than an enumerated
phrase — and its own docblock named the `unless` case. It was reachable only as
a confirming GATE for the single `PAUSE_STOP_SELF_REPORT` pattern, so it could
narrow an existing match and never produce one.

### The conjunction, and why one is required

`hasMenuShape` cannot be promoted unguarded, and the reason is measurable rather
than cautious. It returns **true** for:

> The migration ran cleanly unless a row was locked, in which case it retried.

— a factual qualifier with no offer in it and no actor at all. So the trigger is
a conjunction of two constituents on the SAME line:

1. **A menu shape** — `hasMenuShape`, unchanged.
2. **An agent-action clause** — `namesAgentAction`: a first-person modal
   (`I'll`, `I can`, `I would`), a bare verb governed by a preference token
   (`you'd rather I go`), or its object form (`want me to file it`).

Every agent-action form is **non-past by construction**, which is what separates
an offer from a report: _"I fixed it unless a row was locked"_ names a
first-person action and offers nothing.

### Polarity is checked, not assumed

Tense is not the only axis on which the shape lies. A first-person action clause
reads identically whether the agent is offering to act or saying it will **not**
— _"I can take it"_ and _"I can't reproduce it"_ differ by two characters, and
`\b` sits between `can` and `'t`, so the modal leg matches both. Every such
sentence also satisfies `hasMenuShape` through a bare `unless`, so without a
polarity check the conjunction fires on all of them, into a live-injecting guard.

`namesAgentAction` therefore rejects three forms, each measured against the live
matcher:

| Form                                   | Example                                                                |
| -------------------------------------- | ---------------------------------------------------------------------- |
| A contraction directly after the match | _"I can't reproduce it unless you give me the log."_                   |
| An explicit `not` directly after it    | _"I would not rerun it unless the logs show errors."_                  |
| A governing negator just before it     | _"There is no need for me to rerun this unless the logs show errors."_ |

The lead window is bounded to a few words because the negation has to GOVERN the
clause — a `not` two sentences back does not. This mirrors
`operator-deferral-detector`'s `NEGATION_LEAD_PATTERN`; it is declared locally
rather than imported because that module imports THIS one, so sharing it would
close an import cycle.

`for` is **not** in the object-form alternation for a related reason: _"for me
to"_ is the DESCRIPTIVE form, not an offer. _"It would be unusual for me to
change that"_ proposes nothing, and _"there is no need for me to rerun this"_ is
its negation. Every other member takes `me` as a direct object of a volition
verb, which `for` does not.

Origin: PR #3088 R1, where the reviewer flagged the object-form leg. The
contraction and explicit-`not` cases came from scanning for the same class rather
than waiting to be handed each one; all six are pinned as regression cases, each
asserted alongside `hasMenuShape` so a future change cannot make them pass by
breaking the menu leg instead.

This is deliberately **not** a ninth entry in the phrase corpus. ADR-024 §Context
names serial regex-family additions as the arms race it exists to end, and five
sibling tasks against these two files were each adding or removing one phrase.
Both constituents already lived in this file; what was missing was the relation
between them, which is why the fix is a wiring change rather than a corpus
addition. The Rung-2 escalation ADR-024 would otherwise assign is unwarranted for
a match the code can already make.

### What it reports, and why not the sentence

The trigger reports a stable label — `offer-shape:unless`,
`offer-shape:if-you-rather`, `offer-shape:or`, `offer-shape:question` — never the
matched text. The sweep's diversity axis keys on `matches[].phrase`, and the
disjunction leg's own match (`"mt3799 or I"`) is near-unique per turn; reporting
it would make every record distinct and stall the count that decides when this
log gets reviewed. The sentence is still recoverable from `context`, which is
what a calibration reviewer classifies from.

### Ordering: additive by construction

The structural trigger runs only when the literal corpus produced nothing for
this class. A turn that already matches a literal pattern keeps that pattern's
phrase, so no pre-existing record changes shape — _"I'll stop here unless you
want more"_ satisfies both and still reports `I'll stop here`.

### Known miss: a comma before `or`

`hasMenuShape`'s disjunction leg needs a bare space before `or`, so
_"Next step is mt#3799, or I can go straight at it."_ is not recognized. This is
**recorded rather than closed**, and pinned by a test so it stays a decision
rather than a belief. Closing it means widening `hasMenuShape` — which is also
the pause/stop suppression gate, where a wider menu shape suppresses LESS and
fires MORE. That is the false-positive direction on a live-injecting guard, and
it needs its own evidence rather than riding along with a recall change.

### Interaction with the open tunes on this file

mt#4175 is removing a `deferral-menu` class this trigger can also produce: the
**revisability offer** ("I decided, I acted, and you can reverse it"), which can
carry the offer shape without any literal phrase — _"I went with the second one
unless you'd rather I switch."_ The sibling surface already suppresses that
sentence (`operator-deferral-detector`'s `SETTLED_DECISION_PATTERNS`); this
detector has no settled-decision suppression at all, which is mt#4175's subject.
Whatever discriminator that task lands on should apply to the family, not to the
literal patterns alone. mt#4201 and mt#3932 target the `principal-reserved`
family and do not interact.

**Cross-references:**

- mt#3801 — the offer-shape trigger (this section); R9 of the operator-deferral
  family, mem#831
- mt#2471 — this hook's tracking task
- Memory `3e3f29d8` — escalation-packaging family (R1–R4); names mt#2471 as
  the live structural target
- Memory `6abe89c6` — post-closeout register-shift sub-class (the deferral-menu
  phrase class)
- `.claude/skills/classify-before-deferring/SKILL.md` — the substrate the
  deferral-menu reminder routes through
- `.claude/hooks/causal-premise-detector.ts` / `retrospective-trigger-scanner.ts`
  — sibling calibration-first UserPromptSubmit detectors
- mt#2263 — future consolidation of the regex-scanner family into a unified
  (possibly embedding-based) matcher; adopted at the process/scaffold layer by
  mt#2652 (each detector's own regex matcher remains separate — only the
  process/override/calibration scaffolding unified)
- mt#1788 — ESLint rule + `HOOK_ONLY_ENV_VARS` (env-var registration contract)
- mt#2652 — this guard's process-dispatch mechanism migrated onto the
  ADR-028 guard dispatcher (Phase 2a); detection logic and the
  `INJECTION_ENABLED` calibration-first gate are unchanged — see
  "Guard-Dispatcher Framework (ADR-028 Phase 1–2a)" above.
