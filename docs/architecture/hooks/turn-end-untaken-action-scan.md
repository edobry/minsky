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
A set of suppression patterns ("waiting for", a delegated report) blanks the whole message: those
name a legitimate stop. Six named suppressions sit beside them — see §Corpus-mandated halts below,
which also records why `"you asked me to stop"` is no longer among the prose patterns.

## Corpus-mandated halts (mt#4116, absorbing mt#4113)

The 2026-08-13 calibration pass measured **7 false positives in 10 injected fires**, and three
classes were halts a corpus rule REQUIRES. The guard already suppressed one such class (a
principal-RESERVED category, §below); the gap was that the reserved list is not the only place the
corpus mandates stopping. `user-preferences.mdc §Probe before deferring` names the stopping point as
"an action that is **destructive**, OR that falls under a nameable category" — destructive is a PEER
of that list, not a member.

**The design constraint all of these inherit** comes from mt#4063: a suppression must key on
evidence the condition holds, not on prose claiming it does. PR #2972 R2 enforced it by RETIRING the
armed-watcher prose patterns rather than supplementing them. So the per-shape question is "what
evidence exists at Stop time?", and the answer differs — which is why one mechanism does not cover
all four.

| Shape                     | Reason                       | Evidence                                                                                                                    |
| ------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Destructive action        | `destructive-action-halt`    | the named destructive VERB (`SIGKILL`, `rm -rf`, `force-push`, …), never a claim of destructiveness                         |
| Harness command           | `harness-command-halt`       | a closed list (`/mcp`, `/clear`, `/config`) the agent cannot issue **AND** no distinct action committed behind it (mt#4139) |
| Filed for later by design | `filed-by-design-halt`       | the branch named in prose **AND** a `tasks_create` in the turn                                                              |
| Principal instruction     | `principal-instruction-halt` | the citation **AND** a scope-bounding directive in the OPENING PROMPT                                                       |

**Why the last two require a conjunction.** Each is manufacturable as prose alone. "Filed for later
by design" with nothing filed is exactly the confabulated-halt shape the sibling
`turn-end-unwalked-task` guard exists to catch, so suppressing on the words would open a way to talk
past it. And no pattern over the agent's own closing text can separate a real instruction citation
from an invented one — they are the same words — which is why mt#4113's SC3 ("a message that merely
ASSERTS an instruction still fires") can only be met by reading the prompt that opened the turn.
`extractFinalTurn` already returned that prompt; it was being discarded.

**Why the harness-command row gained a conjunction too (mt#4139).** As shipped it had none, and
that is what made it wrong. A harness-command halt rests on TWO claims: _I cannot run `/mcp`_ —
true, decidable, and the only thing the pattern checked — and _therefore I cannot do the thing I
was doing_, which is unchecked and frequently false. Suppressing on the first made the second
unfalsifiable.

The originating fixture is the whole argument: `"What's needed: run /mcp to reconnect, then I'll
merge the PR."` The goal was MERGING, and `minsky session pr merge` reaches it without MCP — so
this is `user-preferences.mdc §Probe before deferring`, an operator step named as the precondition
for something the agent could do itself, and mt#4116 pinned it as a fixture that must go quiet.
(Corroboration from the same day: a full `/calibration-review` pass ran end to end through the CLI
during a multi-hour MCP outage. The outage bounded the interface, not the work.)

The discriminator was already in the guard's own match data, so the fix stays at **ADR-024 Rung 1**
— the proposition was repairable with a literal check, not a case for climbing the ladder. Suppress
when the harness command is the TERMINAL named action (`"I can't run /clear for you — say the
word"`, where both claims collapse into one); decline when a COMMITMENT family (`ill-action`,
`going-to`, `proceed-to`, …) names a distinct action gated behind it. The offer families
(`say-the-word`, `give-go-ahead`) name no verb of the agent's own and deliberately do not count.

This also removes an inconsistency rather than adding a special case: `"I need you to reproduce the
hang, then I'll merge the fix"` was ALREADY a shipped test expecting a fire. Only the presence of a
harness token made the identical shape go quiet.

A declined suppression is recorded as `harnessCommandDeclined` on the fire's calibration record, so
the next pass can measure this decision instead of inferring it. Cost, stated plainly: a turn whose
named step genuinely required the harness command now gets an advisory it did not get before — one
line to answer, against a swallowed probe-before-deferring failure that is silent.

**What is deliberately NOT covered: the general participation-required case.** "I need you to
reproduce the hang while I sample" is a legitimate halt and was a measured false positive — but it
is not lexically separable from an excuse, and a pattern that tried would silence real deferrals.
Only the decidable subset (a harness command) ships. Recorded here rather than left as an apparent
oversight.

**One retirement, not an addition.** `/\byou\s+asked\s+me\s+(?:to\s+stop|not\s+to)\b/` left
`SUPPRESSION_PATTERNS` in the same change. It was the narrow prose-only ancestor of the
principal-instruction suppression, and leaving both would let a message earn suppression by quoting
the phrase with no instruction behind it — the add-beside-rather-than-replace error PR #2972 R2
caught.

**Reading the extractor, not its name.** The first wiring passed the opening prompt to
`extractAssistantText`, which filters to `role === "assistant"` and returns `""` for a user line —
the suppression would have typechecked, read correctly, and been permanently inert. Caught before
shipping by reading the extractor; it is the mt#1071 / mt#2416 dead-wiring shape. A local
`extractPromptText` replaces it.

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

### The branch was reachable only as far as the sibling's recall (mt#3801)

`deferralShaped` is not computed here. It is `detectDeferralPhrases(finalMessage).length > 0` —
this guard delegates the offer/commitment classification wholesale to `ask-routing-deferral`'s
corpus. So the branch above is only ever selected for shapes THAT detector recognizes, and a
sentence it misses arrives here classified as a commitment by default.

That is what happened on 2026-08-05, the same day the branch shipped. The closing sentence was:

> Next step is `/plan-task mt#3799` unless you'd rather I go straight at it.

It matched this guard's `next-up` COMMITMENT family and got "Take it now" — because neither
deferral corpus had an entry for a **negated default**, so `deferralShaped` was false. The branch
built for this sentence six days earlier was never reached.

**Nothing on this surface changed to fix it.** mt#3801 added a structural offer trigger to
`ask-routing-deferral` (a conjunction of its existing `hasMenuShape` recognizer with a first-person
agent-action clause), and the classification now reaches the branch that already existed. The
lesson worth carrying: a delegated classification inherits the delegate's blind spots silently —
the fire still happens, the directive is just wrong, so there is no missing-fire signal to notice.
The regression test for it lives beside the two branch tests in this guard's own file, asserting on
the rendered directive rather than on the flag.

Full narration of the trigger: `docs/architecture/hooks/ask-routing-deferral-detector.md §The offer
shape as a structural trigger`.

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

**The three prose patterns are RETIRED, not supplemented.** The first attempt added the
evidence check beside them, which left a message _saying_ "a retry watcher is armed" suppressed
whether or not anything was — the exact behavior mt#4063's SC2 rules out, and the opposite of
what "raises the rung RATHER THAN the pattern count" asks for. PR #2972 R2 caught it. What
removal costs, bounded and visible: a wait armed through a tool not in `ARMED_WAIT_TOOLS` used
to be covered by the prose and now fires, which shows up in the calibration log as this guard
firing on a correctly-armed turn — the same signal that produced this change.

Suppressed fires are RECORDED (`suppressionReasons: ["armed-watcher-evidence"]` plus
`armedWatcherEvidence`), per the mt#3207 contract — a suppression that returns null cannot be
measured, and the failure worth catching here is this predicate swallowing a true positive.

### What this deliberately does NOT cover — mt#4113

The 2026-08-12 window carried a fourth false positive this mechanism cannot reach:

> "Filed only, not planned — **you said file**. mt#4028 is small … say the word and I'll take
> it to READY."

The agent was told to file, and filed. Naming the un-taken planning step alongside the
instruction that bounded it is an accurate report, and the guard reads it as the defect.

It is not covered here because it is not the same kind of fact. Whether a watcher was armed is a
property of the turn's TOOL CALLS; whether a principal instruction bounded the scope is a
property of the CONVERSATION. Folding them together would put a language question back inside
the fix that exists to remove one — so it is filed as **mt#4113** with that record as its
regression fixture, carried in PR #2972 as `[sc5-deferred: mt#4113]`. Related but distinct:
mt#3768's reserved-CATEGORY suppression, which covers a standing list rather than something the
principal said in this conversation.

## Overrides

`MINSKY_ACK_UNTAKEN_ACTION` (registered in `HOOK_ONLY_ENV_VARS`).

## Cross-references

mt#3179 (the guard) · mt#3336 / mt#3620 (the dedup and its inversion) · mt#3767 (the directive
split + the ceiling fixes) · mt#3705 (`worstCaseCanary`) · mt#3479 (ceiling enforcement) ·
mt#3522 / mt#3560 (open phrase-corpus widenings) · mem#831 (handoff-toward-the-earlier-event) ·
mem#865 (trim, don't raise) · mem#719 (unmatchable output erodes trust in correct output) ·
`guard-feedback-authoring.mdc` (the authoring rules, which use this guard as their worked example)
· ADR-031 (the event axis this sits on).
