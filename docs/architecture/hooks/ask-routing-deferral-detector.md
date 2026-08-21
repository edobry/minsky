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

### The conjunction was necessary and not sufficient (mt#4311)

The two constituents above are both required, and for two years that was read as
enough. Measured across three calibration windows it is not: co-locating them on
one line is satisfied constantly by ordinary prose, because BOTH halves have a
weak form.

- Two of the four menu legs supply only **grammar**. `offer-shape:or` is
  `/\b\w+\s+or\s+\w+/i` and `offer-shape:question` is `/\?/` — English uses a
  disjunction and a question mark for caveats, negations and technical
  description all the time. The other two, `unless` and `if you'd rather`, NAME
  the reader's alternative and cannot occur without offering one.
- Two of the four agent-action legs supply only a **bare first-person modal**
  (`I'll`, `I can`). That is the shape of an offer AND the shape of a capability
  or intent report, and nothing inside the clause separates them. The other two
  are governed by the reader's preference (`you'd rather I go`, `want me to file
it`) and therefore ARE offers.

So the trigger now requires the relation, not merely the co-occurrence: **a bare
clause needs an explicit-offer leg; a governed clause may use any leg.**

    Caveat I'll state plainly … I haven't read their docs or run the checks.   → silent (bare + grammatical)
    I can test the real prompt path with a stub rather than a spy.             → silent (bare + grammatical)
    I'll stop here unless you want more                                        → FIRES (bare + explicit-offer)
    Want me to file those, or a subset?                                        → FIRES (governed + any)

**Subject-auxiliary inversion upgrades a bare clause.** English inverts only to
ask, and asking about one's own action offers it — _"should I stop doing X?"_ is
a decision handed over. The upgrade runs only after a base pattern has already
matched, so it can preserve a fire but never create one.

What that leaves unchanged, stated precisely: `namesAgentAction` returns the
**same boolean on every input** as it did before mt#4311. Its body DID change —
from a direct scan to a tier computation — so "unchanged" is a claim about
behaviour, not about the source. The load-bearing invariant is that the tier
computation returns null under exactly the old condition, and the inversion
check cannot affect null-ness because it runs only once a bare matcher has
already passed. A test enforces the half that could regress.

**`hasMenuShape` itself is deliberately NOT narrowed.** It is also the
suppression gate for the pause/stop patterns, where a narrower menu shape
suppresses less and therefore fires MORE — the opposite direction of error. The
strength distinction is consumed only by `findOfferShape`.

**Measured on the live log** (`bun scripts/replay-offer-shape.ts`), over the 28
of 38 offer-shape records whose captured 240-char window reproduces a fire at
all: `offer-shape:or` 15 → 0, `offer-shape:question` 7 → 5, `unless` 2 → 2,
`if-you-rather` 4 → 4. Both silenced `question` records are the vantage-point
case that `principal-context.mdc §What Eugene can see` prescribes and mt#4311
classified false. No record classified as a true positive was silenced.

The remaining 10 records reproduce no fire under EITHER matcher because the
captured context is truncated; they are reported separately rather than credited
to the change. Reading the record's existence as its before-state is the
measurement error the replay script's own docblock records.

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

## The rendered phrase is capped, and the ceiling depends on it (mt#4234)

`buildReminder` renders one evidence line per class, interpolating
`matchedPhrase` — which is `m[0]`, the regex's **whole matched span**, not a
fixed literal. Two patterns bound their span only by the next sentence
terminator: the `want me to … or …?` menu shape and the
`before locking in … decision is yours` principal shape, both via an unbounded
`[^.?]*`. So the rendered advisory used to grow 1:1 with whatever the agent
wrote. Measured 2026-08-19 against the live matcher: a 1484-char run-on sentence
carrying both classes rendered **2350** chars against a declared ceiling of
**600**.

That made `attentionCost.denialMessageSizeChars` un-declarable in principle — an
unbounded axis has no finite worst case to pose, so no `worstCaseCanary` could
have made the number a ceiling. `MAX_RENDERED_PHRASE_CHARS` (120) is the fix;
with it the same input renders a flat 1022 at any length.

**The cap is applied at RENDER time, deliberately not in
`detectDeferralPhrases`.** The section above explains why `matches[].phrase` is
sensitive: the sweep's diversity axis keys on it, and making records more
distinct stalls the count that decides when this log gets reviewed. Truncating
at match time would do exactly that. The log keeps the full span; only the
advisory is bounded.

**Why the directive prose was not trimmed instead.**
`guard-feedback-authoring.mdc` prefers trimming to raising, and the phrase cap
IS a trim — but it cannot reach the fixed body. With both classes matching and
zero-length phrases the render is already **879** chars, so no cap brings this
guard under 600. The two directive paragraphs are its entire payload, each
naming the specific remedy to run (`asks_create` /
`/classify-before-deferring`), and three tune tasks (mt#4201, mt#3932, mt#4175)
are in flight on this same file — rewriting what the guard SAYS while they
change what makes it FIRE would collide. So the annotation was raised to the
posed worst case (**1121**) and `MERGED_CONTEXT_BUDGET_CHARS` re-derived
(6106 → 6627), with the prose trim left as the follow-up if budget pressure
justifies it.

## A sentence citing a filed ask is suppressed (mt#4201)

The guard fires on prose that defers a decision to the principal instead of routing it. Its sharpest
false positive is the inversion of that: a closing message that NAMES an ask already filed, by
`ask#N` or a `minsky://ask/<uuid>` deeplink. The decision is IN the substrate — the message is
reporting its state, which is what `communication-contract.mdc` requires at turn end — and the
remedy the guard emits ("file an ask") is already done. mem#719's cost applies at full strength: the
fire lands on the compliant behaviour, so the reader most likely to see it is the one who did the
right thing.

Measured across three independent windows: **2 of 2** `principal-reserved` matches (2026-08-10, the
window recorded on the subsumed mt#3932), **2 of 3** false (2026-08-17), **1 of 10** injected
(2026-08-20). The 2026-08-20 window is the only one that postdates mt#3801's trigger widening, so
the three are not summable into one rate.

`SUPPRESSION_CITES_FILED_ASK` drops such a match. Three properties worth knowing before changing it:

**It is per-MATCH and per-SENTENCE, not per-turn.** The filter reads the sentence containing the
matched phrase, extracted from `DeferralMatch.context`. That narrowing is load-bearing and was found
by a failing test: `extractMatchContext` runs with `leadSentences: 1` and walks backward across
`leadSentences + 1` boundaries, so the context deliberately carries the sentence BEFORE the match.
Testing the whole context suppressed a genuine deferral sitting beside a reported ask —

> Still yours: [ask#9275](…), whether the detector starts speaking. Want me to file the follow-up
> task, or should I leave it?

— where the second sentence is real. Sentence granularity fires on it; context granularity does not.

**The id is matched, never verified to exist.** Verifying would put a substrate lookup inside a
`UserPromptSubmit` hook — latency every turn, and a DB outage would silently flip the guard back to
firing on compliant behaviour, the exact inversion this suppression ends. What match-only concedes:
a fabricated `ask#9999` suppresses a real deferral, which costs the fabricator alone, since this
guard injects to the agent that wrote the sentence.

**Only an all-suppressed turn records a reason.** A reason string gates injection entirely, so
recording one on a PARTIAL suppression would silence the genuine deferrals that survived. This
matches the `deduped-by-untaken-action-stop` convention beside it. `matches` itself is never
filtered, so the calibration record still carries every detection — the mt#3207 detect-first
discipline.

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

## A revisability offer following a settled decision is suppressed (mt#4175)

The `deferral-menu` family matched "say the word" / "want me to" wherever they appeared and could
not tell a **deferral** ("I have not decided; you choose") from a **revisability offer** ("I
decided, I acted, and you can reverse it"). The second is not a deferral at all — it is the
behaviour `humility.mdc §Stakes filter` prescribes, in those words: _"if the wrong answer costs a
30-second edit, decide it, take a reasonable default, and say what you picked."_ Saying what you
picked is what produces the matched phrase.

That inversion is the same one mt#4201 closed for the `principal-reserved` class one class over,
and it is worse than ordinary noise: it pushes toward silent decisions (drop the revisability
offer) or genuine deferral (ask first), both worse than the behaviour being penalised. Per mem#719,
a detector whose correct output sits beside this kind of fire loses credibility for the fires that
are real.

**Measured across four independent windows** before the fix: 3 of 11 injected (2026-08-16), 3 of 14
(2026-08-18), 2 of 10 (2026-08-20), and the single `offer-shape` fire left standing on the sibling
`operator-deferral` surface once mt#4311 silenced the English-conjunction class (2026-08-21).

### The discriminator, and the scope it runs at

`SETTLED_DECISION_PATTERNS` matches a completed or in-progress FIRST-PERSON action of the agent's
own, tested against `DeferralMatch.context` — the matched sentence **plus one lead sentence** — and
scoped to the `deferral-menu` class at the call site.

Three choices carry their own cost, so each is stated rather than assumed:

- **Why `context`, not `sentence`.** Too narrow misses the measured shape where the decision sits in
  the preceding sentence (_"I filed mt#4243 as tracking … Say the word if you want it built now."_).
  Too wide — the whole turn — suppresses a genuine deferral that merely shares a turn with an
  unrelated decision, and a long turn almost always contains one. `context` is also the window a
  calibration reviewer classifies from, so the suppression is tested at the scope the class was
  MEASURED at rather than one chosen afterwards.
- **Why `deferral-menu` only.** A settled decision does not make _"rotating that token is your
  call"_ any less the principal's. The detector's subject is CHANNEL, not judgment, and that
  sentence is in the regression floor as a fire that must survive.
- **Why not shared with the sibling's array of the same name.** `operator-deferral-detector`'s
  `SETTLED_DECISION_PATTERNS` is tuned to a different corpus (resourcing reasons — `with fresh
context`, `this turn has run long`), so a lift would be a merge rather than a move; and mt#4175's
  scope puts other detectors explicitly out of bounds. mt#4070 is where the merge belongs, with both
  corpora in hand. The two arrays agree on the LINE, recorded in the sibling's docblock: _a
  completed or firmly-stated decision of the agent's own is not a decision being handed over; a
  proposed next step is._ mt#3801 owns the second half; this owns the first.

### The residual is measured, not implicit

The fix reaches **3 of the 6** recorded contexts. The three it does not reach carry no first-person
SUBJECT at all:

- _"…the reasoning and the alternative are both recorded in mt#3268."_ — a PASSIVE marker. A first
  cut reached this one with a subject-less `recorded in` pattern; PR #3224 R1 caught that it
  contradicts the first-person contract and named the failure it buys — a neutral status line
  (_"Meeting notes recorded in mt#3268."_) would silence a genuine deferral following it. Dropped
  rather than tightened: `I recorded` was already covered, so nothing first-person was lost.
- _"Say the word if you want a handoff doc for picking this up later."_ — an additive offer nobody
  is waiting on.
- _"…that's a different kind of work; say the word if you'd rather do that instead."_ — where the
  decision-taken marker is the ABSENCE of a change in course.

What those three share with the other three is that **nothing is blocked pending the answer**;
whether that property is mechanically detectable is open. All three are pinned by tests that assert
they STILL FIRE, so a later change that reaches them is visible rather than silent — if one starts
passing, that is a result to record, not a test to delete.

Per ADR-024 sign-off (b), the sufficiency bar is _"0 known-FP AND ≤5% new false-negative"_, so this
is a measured Rung-1 result with a named residual rather than a claim of sufficiency. Per the ladder,
that residual is the evidence gate for any later climb — and Rung-3 cost is a principal decision
gated behind measured insufficiency, which this task produces rather than spends.

`scripts/replay-settled-decision.ts` is the measurement, and it exits non-zero if the regression
floor breaks.
