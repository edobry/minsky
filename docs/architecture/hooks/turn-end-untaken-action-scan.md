# turn-end-untaken-action-scan

A `Stop` observer (mt#3179). It reads the turn's final assistant message and warns when that
message NAMES a next action the turn did not take. Non-blocking: it emits `additionalContext`
only, never a deny.

Index entry: `hook-observers.mdc`. Registration: `.minsky/hooks/registry.ts`. Source:
`.minsky/hooks/turn-end-untaken-action-scan.ts` — until mt#3767 the module header was this
guard's only writeup, which is why the reasoning below had nowhere to live.

## What it keys on

**Position, not stated reason.** The text is `last_assistant_message`, so by construction nothing
followed it. The guard does not try to judge whether the agent had a good reason to stop; it
observes that an action was named and the turn ended.

Matching runs over the TAIL of the message, against quoted-context-elided text (mt#3336) so a
phrase the agent is QUOTING — a rule excerpt, detector data in a handoff blockquote — cannot fire.
A set of suppression patterns (an armed watcher, "waiting for", "you asked me to stop") blanks the
whole message: those name a legitimate stop.

## Two directive branches (mt#3767)

The guard matches two different SHAPES of closing sentence, and they need opposite remedies.

| Shape                                  | Example                                  | Directive                                                                                       |
| -------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **Commitment** — said it would, didn't | "I'm taking it forward"                  | Take it now; if genuinely blocked, name which of principal-decision / red-check / armed-watcher |
| **Offer** — handed the choice back     | "Say the word if you'd rather I file it" | You OFFERED rather than did; if you already decided, drop the offer and state the decision      |

The offer branch exists because of a handoff. "Say the word" sits in BOTH this guard's corpus and
`ask-routing-deferral`'s. mt#3336 made this guard yield to that sibling; mt#3620 **inverted** it,
because the sibling runs on `UserPromptSubmit` — an event that by construction occurs only after
the principal has read the closing sentence and typed a reply. A dedup between guards on different
events is a handoff, and it has to hand toward the EARLIER event (mem#831).

What mt#3620 moved was the speaking slot. What it did not move was the TEXT: this guard kept
emitting its commitment-shaped "take it now" for offer-shaped fires, so an agent was told to
perform an action whose correct disposition was usually to retract the sentence that named it.

**Why that is worse than a vague directive.** In the originating occurrence (2026-08-05) the agent
read "take it now" against the engineering object, found there was genuinely nothing to do, and
concluded the fire was a false positive. It was a paradigm true positive — the phrase is in the
corpus because of an earlier incident of exactly this shape. A directive that does not fit teaches
the reader to discount the detector, which is the mem#719 dynamic reached from the other side.

## The ceiling, and why it binds here

`attentionCost.denialMessageSizeChars` is **450**, enforced against a real render by
`guard-feedback-shape.test.ts`. `dispatcher.ts` derives the whole turn's merged-injection budget
from the sum of these annotations across the registry, so raising one taxes every turn in the
repo. **Amend this guard's text by trimming, not by raising the annotation** (mem#865, learned on
the mt#3699 sibling).

The guard is growth-shaped on two independent axes, and the worst case needs BOTH at once:

1. the evidence list, capped at 3 lines plus an "…and N more" line, and
2. the directive branch, of which the offer branch is the longer.

Measured at mt#3767 (all four from `run()`, not estimated):

| Input                 | Before  | After |
| --------------------- | ------- | ----- |
| Commitment, 2 matches | 412     | 395   |
| Offer, 1 match        | 383     | 339   |
| Commitment, saturated | **454** | 437   |
| Offer, saturated      | **474** | 430   |

Two things that table records. The offer branch's real worst case was 474 against a 450 ceiling —
posing a canary at the single-match sentence measured 383 and bounded nothing. And the
**commitment** branch was already over at 454 before mt#3767 touched anything: the guard had been
classified `capped` in `guard-feedback-shape.test.ts`, meaning "its canary IS its worst case," so
nothing ever rendered the case where the ceiling binds. Reclassifying it to `worst-case-canary`
is what surfaced it. Headroom was bought by trimming the shared header
("…ended the turn without taking it" → "…did not take it"), which pays on both branches.

## Reserved-category suppression (mt#3768)

A turn that stops because the next step belongs to the principal is doing what
`principal-context.mdc §Decisions Eugene reserves` requires. Firing on it tells the agent to
override a halt the corpus mandates — training against the corpus instead of with it. So a message
that NAMES a reserved category suppresses the injection.

**The discriminator is a named category, not an offered choice.** `/plan-task` Step 4 makes the
halt test positive: a legitimate halt can say WHICH category applies, and a rationale naming none
is low confidence, missing information, or a decision that is simply the agent's. The patterns
therefore match category vocabulary — "naming is yours", "user-facing name", "your product
surface", "vendor commitment", "framework choice" — and deliberately do NOT match a bare "your
call", "up to you", or the presence of an option set.

That exclusion carries weight in both directions:

- **A bare "your call" is the confabulated halt's signature** (mem#823; mem#367 R5). It is exactly
  what this guard should keep catching, so it must never suppress.
- **An option set is not evidence of a legitimate halt.** mt#3801 recorded a true positive —
  _"Next step is `/plan-task mt#3799` unless you'd rather I go straight at it"_ — that an
  option-set discriminator would have silenced. mt#3768's SC1 originally proposed exactly that
  discriminator and was amended before implementation.

**Tuned against real fires, not invented examples.** All 130 records of
`.minsky/untaken-action-calibration.jsonl` were read; exactly three name a reserved category, and
all three are false positives now suppressed — two naming calls (2026-07-30 "Naming is yours, not
mine"; 2026-07-31 "blocked on you picking the user-facing name") and one product-surface call
(2026-08-04 "it's your product surface"). All three are the test fixtures.

**Three in 130 is rare, and frequency is not the argument.** The suppression covers none of the 12
fires from 2026-08-06 → 08-08. Its justification is the COST of the false positive — the agent is
instructed to override a correct halt — not its rate. Do not later re-read a 0-of-12 suppression
as noise reduction that failed.

**A suppressed fire is still RECORDED — once per distinct turn**, with
`suppressionReasons: ["reserved-category-halt"]` and the matched phrases, per the mt#3207 contract.
A suppression that returned `null` would be invisible, and the failure worth catching is this
predicate swallowing a true positive. Empty `suppressionReasons` still means "recorded an outcome,
did not suppress".

The "once per distinct turn" qualifier is load-bearing and was added after PR #2731 R1 read the
unqualified claim and checked it. The suppression is evaluated AFTER the dedup filter, so a
re-entered turn — byte-identical text, same verdict — is suppressed with no second record, exactly
as an INJECTING fire is not re-injected on re-entry. That ordering is deliberate: the dedup key is
the final message's own hash, and N records for one repeated message would inflate the suppression
rate and misstate the very measurement the record exists to support. Review's reading of the
behavior was correct; what was wrong was the unqualified promise, not the ordering.

The scan reads the WHOLE message rather than the tail the commitment scan uses — the halt basis is
routinely stated where the reasoning is, paragraphs above the closing sentence. It runs over the
same elided text, so a category named inside a quotation or code fence cannot suppress: a turn
discussing this guard must not silence it.

Because a suppression emits no text, the guard's 450-char ceiling is untouched — the offer branch
remains the worst case.

## Armed-watcher suppression, and why it stopped being a phrase (mt#4063)

`work-completion.mdc §External self-resolving waits` tells an agent blocked on an external,
self-resolving condition to **arm a watcher and keep going**, and its canonical correct shape is a
closing sentence naming what happens when the watcher fires. That sentence names a next action and
does not take it, so this guard fires on the behavior the corpus prescribes.

The first two answers were phrase patterns. mt#3917 added an armed-watcher pattern; mt#3948 unbound
it from one word order after two attested messages escaped it. Both are still in the file, and both
were widenings along the same axis.

The 2026-08-12 calibration window produced **three more** phrasings that escape both:

| Phrasing                                | Why it escapes                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| `That watch is armed in the background` | `watch` is not in the noun set (`watcher`/`wait`/`poll`/`retry`/`wakeup`)             |
| `the watcher for it is armed`           | `for it` sits between the noun and its copula; the pattern allows whitespace only     |
| `A background watcher is polling`       | carries no `armed` token at all — unreachable by any widening of the `armed` patterns |

The third one is the important one: it is not a gap in the pattern, it is evidence the pattern is
matching the wrong thing.

**What the patterns' own ADR-024 note had already committed to.** The comment above them reads: _"If
a THIRD distinct armed-watcher phrasing is filed against this set, that is the measured
insufficiency of Rung 1 for this family and the next pass raises the rung rather than the pattern
count."_ Three arrived at once, so the clause fired.

**The rung it raised to is not Rung 2.** Whether a watcher was armed is not a language question —
it is a fact about the turn's tool calls. `detectArmedWatcherEvidence` reads them directly, which
**removes** the paraphrase axis instead of buying better recall along it; climbing to embeddings
would have spent more to answer a question that never needed paraphrase matching. Ranking a cheaper
deterministic signal above a costlier probabilistic one is what ADR-024's ladder exists to produce,
so this is a deviation toward its intent rather than away from it.

**What counts as evidence** — `ScheduleWakeup`, `Monitor`, a `Bash` call with
`run_in_background: true`, the blocking MCP waits (`session_pr_wait-for-review`,
`deployment_wait-for-latest`, `asks_wait-for-response`, `pr_watch_run`, `reviewer_watch_run`), and
`session_pr_checks` **only when `wait: true`** — without it the call is a one-shot snapshot and
nothing survives it.

**What it deliberately does not buy.** Naming a blocker is still not evidence: "I'll merge when the
review lands" with no wait armed still fires, the same line PR #2784 R1 drew when it rejected a
broader `blocked only on ci` pattern. Because the signal is a tool call, prose cannot manufacture
it — which is what the paired tests assert, running each window phrasing twice against identical
text and opposite tool state.

**The accepted cost.** A turn that arms a watcher AND names an unrelated untaken action is
suppressed. That is a real true-positive loss, pinned by its own test rather than left to be
discovered: the suppression is per-TURN, not per-match, because the evidence is a property of the
turn. If the calibration record shows this firing on unrelated actions, the next pass should scope
the suppression to matches whose phrasing references the wait.

Suppressed fires are RECORDED (`suppressionReasons: ["armed-watcher-evidence"]` plus
`armedWatcherEvidence`), per the mt#3207 contract — a suppression that returns null cannot be
measured, and the failure worth catching here is this predicate swallowing a true positive.

## Overrides

`MINSKY_ACK_UNTAKEN_ACTION` (registered in `HOOK_ONLY_ENV_VARS`).

## Cross-references

mt#3179 (the guard) · mt#3336 / mt#3620 (the dedup and its inversion) · mt#3767 (the directive
split + the ceiling fixes) · mt#3705 (`worstCaseCanary`) · mt#3479 (ceiling enforcement) ·
mt#3522 / mt#3560 (open phrase-corpus widenings) · mem#831 (handoff-toward-the-earlier-event) ·
mem#865 (trim, don't raise) · mem#719 (unmatchable output erodes trust in correct output) ·
`guard-feedback-authoring.mdc` (the authoring rules, which use this guard as their worked example)
· ADR-031 (the event axis this sits on).
