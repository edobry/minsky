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

## Overrides

`MINSKY_ACK_UNTAKEN_ACTION` (registered in `HOOK_ONLY_ENV_VARS`).

## Cross-references

mt#3179 (the guard) · mt#3336 / mt#3620 (the dedup and its inversion) · mt#3767 (the directive
split + the ceiling fixes) · mt#3705 (`worstCaseCanary`) · mt#3479 (ceiling enforcement) ·
mt#3522 / mt#3560 (open phrase-corpus widenings) · mem#831 (handoff-toward-the-earlier-event) ·
mem#865 (trim, don't raise) · mem#719 (unmatchable output erodes trust in correct output) ·
`guard-feedback-authoring.mdc` (the authoring rules, which use this guard as their worked example)
· ADR-031 (the event axis this sits on).
