---
name: calibration-review
description: >-
  Review hook-calibration logs past their review threshold: false-positive-classify the
  matched records, file tune tasks directly, Ask only for enforcement-posture changes,
  then advance the watermark. Use for the periodic calibration sweep, or when asked to
  review the calibration data for a detector hook.
user-invocable: true
---

# Calibration Review

Closes the calibration → action loop for the detector hooks that ship in
**log-only calibration mode** (e.g. `causal-premise-detector.ts` with
`INJECTION_ENABLED=false`, mt#2216; `retrospective-trigger-scanner.ts`,
mt#2057). Those hooks write matches to `.minsky/*-calibration.jsonl` but nothing
triggers a review — this skill is the review.

The mechanical part (enumerate logs, count fires, watermark, diversity
threshold) is the `calibration.review` command. **This skill does the
judgment** the command can't: deciding which fires are real positives vs false
positives, and disposing of the verdict — filing a tune task directly, or
packaging an enforcement-posture change as an Ask (Step 4's split, mt#3769).

## Step 1 — Run the sweep (read-only)

Call the command read-only (do NOT pass `--ack` yet):

- MCP: `mcp__minsky__observability_calibration-review` with NO arguments. It
  returns JSON already; the tool declares only `ack`, `askId` and `clearAskId`,
  and undeclared params are rejected at the MCP boundary (mt#2778). Passing
  `json: true` here fails — the rejection reads `expected boolean, received
string`, which points at a type, not at the real cause, so it costs a
  round-trip to diagnose.
- CLI: `minsky observability calibration-review --json` (`--json` is a CLI flag,
  which is where the MCP form's phantom parameter came from).

It returns, per registered log: `totalFires`, `firesSinceLastReview`,
`suppressedSinceLastReview`, `injectedFiresSinceLastReview` (mt#3197 — the
count the thresholds key off; a detection that was suppressed before injection
never reached the operator and is NOT a fire for cadence purposes),
`distinctPhrases`, `lowDiversity`, `pastThreshold`, `newRecords` (the
unreviewed matches), and `openAskId` (mt#2659 — set when a prior pass filed a
disposition Ask for this log that hasn't been resolved yet).

### Step 1a — Reconcile any already-open disposition ask (mt#2659)

Before doing new FP-classification work, check any log whose `openAskId` is
set:

1. Call `mcp__minsky__asks_list` with `kind: "direction.decide"` and look for
   that id.
2. If the ask's `state` is terminal (`responded`, `closed`, `cancelled`,
   `expired`) — the operator has already decided. Clear the stale reference so
   the cadence detector resumes normal per-turn warnings for this log:
   `mcp__minsky__observability_calibration-review` with `clearAskId: "<id>"`
   (a single ask id, not an array). One pass files one ask, but that ask covers
   only the logs that pass actually REVIEWED — a mixed pass excludes whatever it
   skipped here — so several distinct open ask ids can coexist across the
   corpus, each stamped by a different pass. Clear them one call at a time,
   checking each id's state on its own. Then proceed to classify this log's NEW
   fires (if any) normally in Step 2 onward.
3. If the ask's `state` is still open (`detected`, `classified`, `routed`,
   `suspended`) — the operator hasn't responded yet. **Skip this log entirely**
   for this pass: do not classify its new fires, do not emit a second Ask for
   it, do not advance its watermark. The cadence-detector hook (mt#2659)
   already suppresses the per-turn nag for this log while `openAskId` is set —
   re-running this skill on a schedule must not re-surface the same pending
   question. Only logs WITHOUT an open ask (or whose ask was just cleared in
   step 2 above) continue to Step 2. (The command itself also refuses to
   silently `--ack` a still-open-ask log when `askId` isn't supplied — see
   Step 5 — so skipping here is belt-and-suspenders, not the only guard.)

   **If you skip anything here, remember it — it changes Step 5's arguments.**
   A pass that skips one log and reviews another is a MIXED pass, and passing
   `askId` on its ack call would advance the skipped log too, undoing this
   step. Step 5's "Which ack call to make" has the branch.

If the `reviewDue` array is EMPTY (after excluding still-open-ask logs per step
3 above), stop — nothing to review. Do not emit an Ask, do not advance
watermarks.

**Review-due is the trigger, not `pastThreshold` (mt#2878).** `reviewDue`
carries four reasons: `past-threshold` (the count+diversity bar),
`time-stale`, `never-reviewed`, and `never-fired`. A log due for one of the
three time-based reasons is genuinely due for review even though it never
reached the count bar — a low-volume detector may never reach it at all. This
step used to stop on `pastThreshold` alone, which left those logs permanently
undischargeable: reviewed by nobody, warned about every turn. `--ack` now
advances every `reviewDue` log, so a pass that stops here on the old condition
re-opens exactly the gap mt#2878 closed.

**A below-count-bar log returns `newRecords: []` BY DESIGN** — `computeLogResult`
gates that field on `atCountThreshold`, so an empty array here means "under the
bar," never "no evidence exists." Read the raw JSONL for those logs
(`jq -c '.' .minsky/<name>-calibration.jsonl | tail -n <firesSinceLastReview>`)
rather than recording "cannot classify" from the empty array — the
`classifiability` verdict is computed over the un-gated records and will still
say `classifiable`. See §"Cannot classify" is a claim about the corpus.

### Step 1b — Coverage-receipt check (mt#2554)

Independent of the past-threshold gate above (a DEAD detector fires rarely, so it
will never trip `pastThreshold` — its problem is the ABSENCE of fires, which the
sweep's fire-count thresholds cannot see). Run this every pass, even when Step 1
found nothing to classify:

- CLI: `bun scripts/check-coverage-receipts.ts`

It reports one of three states per detector and exits non-zero only on the third
(mt#3502):

- **`[OK]`** — live receipts in the window. Nothing to do.
- **`[DORMANT]`** — no records, but the fire log shows the entry point RAN in the window.
  Healthy: it had nothing exceptional to report. Note it and move on.
- **`[FLAGGED]`** — no records AND no invocations. This is the mt#2057 9-day-dead-hook
  shape. Fold it into the Ask you emit in Step 4, or file a fix task — do not silently pass
  over it.

Two lines below the per-detector report name logs that no coverage verdict applies to
(mt#3519). They are different problems and must not be conflated:

- **`Unmapped: <names>`** — no guard DECLARES these logs, so the check has no invocation
  evidence and can only ever flag them. A DEFECT: add the missing `calibrationLog`
  declaration (or the `recordFireLogEntry` wiring, if the guard records no invocations at
  all) rather than reading the eventual flag as a dead detector.
- **`[NON-GUARD] <name>: written by <producer>`** — the log has a declared producer that is
  not a guard at all (today: `ask-form-lint`, written on the `asks_create` command path).
  Not a defect and not fixable by a declaration — there is no entry point to instrument, so
  the check EXCLUDES these from `Checked:` rather than reporting a verdict about something
  that does not exist. Their records still feed the sweep in Step 1 exactly as before; only
  the liveness question is inapplicable.

The tool now makes the dormant-vs-dead call itself, from fire-log invocation evidence.
**Do not substitute the canary for that judgment.** An earlier version of this step said
"canary PASS + zero live fires → dormant"; that inference does not hold. A canary calls the
guard's exported PURE decision function, so it proves the LOGIC works while saying nothing
about whether anything still invokes it — which is precisely the dead-entry-point class
(mt#3019 / mt#3046 / mt#3308) the flag exists to catch. Run
`bun scripts/run-guard-canaries.ts` for the complementary question (**does it still decide
correctly?**), not as evidence of liveness.

Also read the `Unmapped (...)` line if present: those calibration logs have no guard
declaring them, so the check has no invocation evidence for them and can only ever flag
them. That is a wiring gap to file, not a dead detector.

This is the LIVE-input complement to the canary's synthetic-input check; see
`docs/architecture/evaluation-loop-fire-log.md` §Coverage-receipt gate.

## Step 2 — False-positive classification

For each log in `reviewDue` (any reason — see Step 1's note; for a below-count-bar
log read the raw JSONL, since `newRecords` is gated), go through its records and
classify each as **real positive** or **false positive**:

- A record is a **false positive** if the matched claim was legitimate and did
  NOT need verification — e.g. `hadSameTurnVerification` is true, the matched
  phrase is a quote / example / doc reference, or the "claim" is not actually a
  volunteered causal/mechanism assertion.
- A record is a **real positive** if it is a volunteered "X because Y" /
  "running X will do Y" mechanism claim with no same-turn falsifier.

When the record alone is ambiguous, say so and lean toward calling it
**uncertain** rather than guessing — the goal is an honest FP rate, not a
flattering one. Compute `fpRate = falsePositives / injectedFiresSinceLastReview` per
log.

### "Cannot classify" is a claim about the corpus — it needs evidence (mt#3610)

Before dispositioning any log as **cannot classify** / **HOLD — unratable**, the
disposition MUST carry both:

1. **The tool's own verdict, quoted.** Each result now reports
   `classifiability` — `classifiable` / `not-classifiable` / `no-records`, plus
   the `evidenceFields` it found. **If the verdict says `classifiable` and you
   are about to write "cannot classify", you are contradicting the tool — stop
   and re-read the records before writing anything down.**
2. **A check against the RAW JSONL, not this command's rendering.** Name the
   field you EXPECTED to find and did not — that expectation is yours to supply,
   not the tool's: `classifiability` reports the evidence it FOUND, and never
   which fields a detector ought to have written (deriving "missing" would need
   a per-detector table that could drift from the parsers). Then check your
   expectation against the log itself:
   `jq -c 'select(.<field> != null)' .minsky/<name>-calibration.jsonl | wc -l`,
   and cite the count. The log file is the record; this command's output is a
   rendering of it.

**Read the record, not one object inside it.** A parsed record has two levels:
per-detector fields at the TOP level, and a nested `detectorFields` object
carrying keys the per-kind parse did not consume. `detectorFields` is
supplementary — quoting it as though it were the whole record reports the
top-level fields as missing when they are sitting right beside it.

Originating incident (2026-08-03, mem#827): a sweep dispositioned `wall-of-text`
"HOLD — cannot classify" and filed mt#3576 asserting its records held only
`textHash` and `suppressedByDepthRequest` — that pair being exactly its
`detectorFields`. All 186 records carried `wordCount`, `lineCount`, and
`trigger` at the top level of the same output. The false premise propagated into
an Accepted ADR and two task specs before anyone checked the log.

### A record without `captureSchema` is un-auditable, not clean (mt#3607)

Records carry a `captureSchema` field once their writer started snapshotting the
input it judged. **Absence is not a neutral fact — it means the judged text is
unrecoverable, so that record can never be re-classified**, and any rate computed
over a population containing them is a rate over records you cannot check.

Split the population before computing anything:

```
jq -c 'select(.captureSchema != null)' .minsky/<name>-calibration.jsonl | wc -l   # auditable
jq -c 'select(.captureSchema == null)' .minsky/<name>-calibration.jsonl | wc -l   # not
```

Report both counts in the disposition, and bound the FP rate to the auditable
half. The pre-capture records are not evidence of correct behavior; they are
evidence of nothing, which is a different thing and must not be averaged in.

This matters most where the judged artifact is MUTABLE. For a PR-body surface,
re-fetching the body and re-running the matchers answers "what would the detector
say TODAY", never "what was it judging when it fired" — mt#3584 lost a real false
positive exactly that way, because the body had been edited in between.

## Step 3 — Recommendation

Per review-due log, pick one. Note what the log's reason tells you about the
evidence you are reasoning from (mt#2878):

- A **`past-threshold`** log cleared BOTH the fire-count and the diversity bar,
  so its sample is the strongest — this is the case the flip/tune thresholds
  below were written for.
- A **`time-stale`**, **`never-reviewed`**, or **`never-fired`** log reached
  this step on ELAPSED TIME, not volume. Its sample may be small (single
  digits) or, for `never-fired`, empty. A low-diversity log can now arrive here
  too, since the diversity bar gates only `pastThreshold`. Say the sample size
  out loud in the Ask and prefer **keep** over a flip you cannot support: an FP
  rate over 3 fires is not the same evidence as one over 30. For `never-fired`
  the question is not FP rate at all — it is whether the detector is still
  reachable (cross-reference Step 1b's verdict).

- **flip** — FP rate is low (rule of thumb: < ~20%): recommend enabling the
  hook's injection mode (e.g. flip `INJECTION_ENABLED` to `true` for the
  causal-premise hook, or stop treating retrospective-trigger as log-only).
- **tune** — FP rate is high: recommend tightening the detector's patterns
  (name the phrases driving the false positives).

## Step 4 — Dispose: file tune tasks yourself, Ask for posture changes

**First decide which half of the split each disposition falls in (mt#3769).** The
principal granted this in ask#7031 on 2026-08-05; before that, every disposition
was routed to an Ask, and five passes in two days left six suspended asks whose
routine half was approved as recommended 3 for 3.

- **File it yourself — no Ask.** A **tune**, or a **keep** that wants a
  supporting task (e.g. "keep, but capture context so the next pass can rate
  it"). Create the task with `mcp__minsky__tasks_create` and **name the task id
  in your pass output**. Creating a durable task is routine under
  `decision-defaults.mdc`; it changes no agent's behavior and is visible and
  closable if unwanted.
- **Ask — always.** Anything that changes **enforcement posture**: log-only →
  live, live → blocking, retiring a detector or one of its match categories, or
  changing a threshold. These change whether a detector interrupts agents, which
  is the thing the principal reserves.

The line is _whether a detector interrupts agents_, not _whether someone writes a
task about one_. When a pass produces only file-it-yourself dispositions, it emits
NO Ask — go straight to Step 5 and read its no-Ask case.

A disposition that is BOTH (e.g. "flip to live, and file a tune for the phrases
driving the remaining FPs") files the task AND asks about the flip; do not fold
the flip into the task to avoid the Ask.

### When an Ask IS required

Emit a single operator-routed Ask via `mcp__minsky__asks_create` with
**kind `direction.decide`** (mt#2659 — corrected from `quality.review`; see
"Why `direction.decide`, not `quality.review`" below). Do not flip anything
yourself — the Ask decides it, not you.

**Acceptance bar: the ask must pass the cold-reader test.** The bar itself is
stated once, in **`/escalation-packaging` §The cold-reader bar** — read it
there rather than from a copy here. It applies to every operator-facing ask,
not only this skill's; mt#3326 originally installed it here alone, and
ask#7591 (2026-08-10) was the recurrence that reached the principal through a
path this skill does not touch, which is why the canonical text moved
(mt#3929).

What is specific to THIS skill: a disposition ask carries detector names and
`live` vs `log-only`, which are exactly the terms a cold reader cannot
resolve — so it clears the bar's "dispatch a real cold reader" trigger nearly
every time. Assume you need the subagent pass here rather than deciding you
don't. (Originating incident: ask#6448, 2026-07-29, filed by this skill,
failed exactly this test: seven undefined detector names, "live vs log-only"
never defined, and a recommended option that bundled a flip whose
precondition — dedup — was not yet satisfied.)

### Step 4a — Plain-language lead, THEN stats

The body must LEAD with a one- or two-sentence plain-language definition of
any term the reader needs (e.g. what "live" vs "log-only" means for a
detector), then one line per review-due log in this shape:

```
N. DISPOSITION — detector-name, live|log-only ("what habit it watches, in
   plain words"): stat summary. one-line rationale.
```

Stats (`injectedFiresSinceLastReview`/`totalFires`, FP rate, representative
false positives, `suppressedSinceLastReview` when non-zero) attach AFTER the
plain-language clause on the same line — never as the line's opening word.
A line that opens with a percentage or a raw detector identifier has not
been rendered for a cold reader yet.

Reference exemplar — the corrected ask#6448 body (fetch via
`asks_get id:91b77372-6b14-4a85-b526-25b703b3c1f8` to see it verbatim):

> Your behavior detectors either log quietly (log-only) or inject a visible
> warning into the agent's next turn (live). Four have enough review data to
> act on:
>
> 1. KEEP — ask-routing-deferral, live ("defers decisions in chat instead of
>    filing an ask"): ~0-10% false positives. Accurate; not yet changing the
>    habit.
> 2. TUNE — silent-stretch, log-only ("agent went quiet"): 8 of 12 fires were
>    sub-5-minute tool bursts, not real silence. Require a longer gap.
> 3. TUNE — wall-of-text, live ("turn report over budget"): 2 of 16 fires
>    false — one 56-word one-liner, one report you explicitly asked to be
>    long. Add a word-count floor; widen depth-request suppression.
> 4. HOLD — untaken-action, log-only ("said 'I'll do X', then stopped"): low
>    FP and flip-worthy, BUT it fires on the same turns as #1 — flipping now
>    risks double-injection. Land dedup first, then flip.
>
> Recommendation: approve 1-3 now; #4 only after dedup lands.

Notice: the opening sentence defines "live"/"log-only" ONCE, in plain words,
before any detector name appears; every numbered line names the habit in
quotes before the stats; and item 4 is split out as its own disposition
rather than folded into the headline recommendation — see Step 4b.

### Step 4b — Precondition-safe recommendation rule

**Never bundle an action whose stated precondition is not yet satisfied into
the ask's recommended option.** If a log's disposition is "flip, but only
after X lands" and X has not landed, that log's disposition is **HOLD**, not
"flip" — give it its own line and, if X doesn't already have a tracking
task, name one. The recommended option must be safe to click as written: an
operator clicking "approve the recommendation" must never trigger a
consequence (like the double-injection risk in the ask#6448 origin
incident) that the ask itself warns about one paragraph later. When in
doubt, split: one option approves the precondition-clear items, a separate
option (or a plain HOLD line, not a clickable bundle) covers the blocked
one.

### Step 4c — formWarnings / hard-reject handling (mt#3326)

`asks_create` now hard-rejects a call whose body/options fail any form-lint
check (over-word-budget, internal-tool-id, portal-no-link,
long-option-label, letter-prefixed-option-label) and lists the violations
in the error — it does not silently create the ask with an ignorable
warning anymore. Treat a rejection as a signal to shorten/restructure via
Step 4a's template, not as a cue to bypass:

- **Default response:** fix the wording (usually: apply the plain-language
  compression above, and move any per-log deep-dive detail into
  `contextRefs` instead of the body) and retry `asks_create`.
- **`acknowledgeFormWarnings: true`** is available for a pass that genuinely
  covers many logs and cannot compress under the word budget even after
  Step 4a's rewrite. Use it deliberately, not reflexively — every use is
  recorded on the calibration log (`acknowledged: true`) and is itself
  reviewable in a future calibration pass. Reaching for it before trying the
  plain-language compression defeats the point of this amendment.

The Ask body must still contain, per review-due log, the full stat
detail Step 4a's template attaches after the plain-language clause:

- the log name + `injectedFiresSinceLastReview` / `totalFires` + `distinctPhrases`
  (and `suppressedSinceLastReview` when non-zero — say so explicitly, since a
  large suppressed count means the detector's tune is WORKING, not that it is noisy)
- the FP rate and a few representative false positives
- the recommendation (flip / tune / keep / **hold**, per Step 4b) with one
  line of rationale

**You MUST NOT** edit any hook file, flip `INJECTION_ENABLED`, or change any
detector pattern — not even one you filed a tune task for. The split in Step 4
moved who may FILE A TASK, not who may change a detector: the flip is still the
principal's decision and the Ask still surfaces it. The skill's job ends at the
task or the Ask, never at an edit.

**Why `direction.decide`, not `quality.review` (mt#2659 regression fix).**
Per `packages/domain/src/ask/types.ts`'s AskKind table, `direction.decide` is
"Preference-bound choice — architectural, scope-level ... Operator (rarely
automatable)" — exactly what a flip/tune/retire disposition is.
`quality.review` is "Output needs validation — tests, reviewers, taste ...
Reviewer agent → operator" — a PR/output-review concern, not a policy
decision. The prior version of this skill used `quality.review`; ask
`483dbcb0-788a-4159-9d8a-ba718ba1f2b0` was filed under it and IS discoverable
via `asks_list kind:quality.review` (verified live — the routing to the
`inbox` transport does reach the operator surface either way), but a later
retrospective searched `kind:direction.decide` (the semantically-correct
taxonomy slot) and came up empty. Filing under the correct kind going forward
avoids repeating that search-miss.

## Step 5 — Record the ask id and advance the watermark

**If** an Ask was created, capture its `id` from the `asks_create` response —
under Step 4's split a pass may legitimately create none. Either way, re-run the
command with `ack: true`; **whether you also pass `askId` depends on whether an
Ask exists at all, and on whether this pass skipped anything under Step 1a.**
Check both first — the cases take different arguments and the wrong one destroys
data.

### Which ack call to make

**First: did this pass emit an Ask at all?** Under Step 4's split a pass whose
dispositions are all file-it-yourself emits none, and then there is no id to pass.

- **No Ask emitted (mt#3769).** Pass `ack: true` and **NOT** `askId` — the same
  call shape as a mixed pass below, for a different reason: there is no ask to
  record rather than one you must not over-apply. **This does not leave the
  cadence hook nagging.** Advancing a watermark removes the log from `reviewDue`
  outright, and `openAskId` only suppresses warnings for a log that is STILL
  review-due — so a log you advanced is quiet either way. Name the filed task ids
  in your pass output; that is what replaces the ask link.

  Note this composes with the skip rule: if a review-due log was ALSO skipped
  under Step 1a, the same `ack: true` (no `askId`) call is still correct, and
  `skippedOpenAskPaths` should name it.

**If an Ask WAS emitted — was any review-due log skipped under Step 1a
(still-open `openAskId`)?**

- **No — every review-due log was reviewed this pass.** Pass BOTH `ack: true`
  and `askId`. This advances the watermarks and records `openAskId` on each, so
  the cadence hook (mt#2659) suppresses its per-turn warning until the ask
  resolves.

  - MCP: `mcp__minsky__observability_calibration-review` with `ack: true`,
    `askId: "<id from asks_create>"`
  - CLI: `minsky observability calibration-review --ack` plus the CLI's
    generated flag for `askId` — check `--help` for the exact flag spelling

- **Yes — this is a MIXED pass.** Pass `ack: true` and **NOT** `askId`.

  - MCP: `mcp__minsky__observability_calibration-review` with `ack: true`
  - CLI: `minsky observability calibration-review --ack`

  Confirm afterwards that the result's `skippedOpenAskPaths` names every log you
  skipped, and say in your pass output that you acked without `askId` and why.

**Why `askId` is unsafe on a mixed pass.** `askId` is a deliberate
REAFFIRMATION: `selectAckablePaths` skips a log only when `askId` is ABSENT
(`if (!askId && r.openAskId)` —
`src/domain/calibration/calibration-sweep.ts`). Supplying it therefore advances
EVERY review-due log, including the one Step 1a told you to leave alone —
marking its unreviewed fires as reviewed under an ask that does not cover them,
and overwriting its link to the ask that does. Live instance (2026-08-05,
mt#3707): `retrospective-trigger` was review-due with an open ask and **29**
unreviewed fires while two other logs were reviewable; acking with `askId` would
have silently erased that backlog.

**The cost of the mixed-pass form, so you don't go looking for it later.** The
logs you DO advance come out without `openAskId`. That is fine: advancing their
watermark removes them from `reviewDue` outright, so the cadence hook stops
warning about them anyway — `openAskId` only suppresses warnings for a log that
is STILL review-due. What you lose is the recorded link from those logs to the
ask deciding them; cite the ask id in the task record instead.

Mixed passes are the normal case, not an edge: four disposition asks were open
simultaneously on 2026-08-04. If you find yourself wanting an ack that both
preserves the skip AND records `openAskId`, that is a change to the command, not
a judgment call to make here — file it (mt#3727 carries the history).

Either form marks the reviewed fires, so the next sweep considers only new ones.
A watermark entry is CREATED where none existed — that is how a
`never-reviewed` log gets its first one (mt#2878). Both forms keep the loop
idempotent: a re-run with no new fires emits no Ask, and a re-run while the ask
is still open (Step 1a) skips straight past without re-asking.

`openAskId` is the part that differs, and only the no-skip form records it. See
the branch above for why that is the right trade on a mixed pass.

**What the command guarantees, in both forms.** `--ack` WITHOUT `askId` never
advances the watermark of a review-due log that already carries an `openAskId`;
that log is left untouched and named in `skippedOpenAskPaths`. This is the
MECHANISM the mixed-pass branch relies on — not merely a backstop for a missed
Step 1a skip, though it serves as that too. Passing `askId` advances every
review-due log regardless of any pre-existing `openAskId`, which is what makes
it an explicit reaffirmation and what makes it unsafe on a mixed pass. An
`--ack` call that omits `askId` never DROPS a pre-existing `openAskId` on the
logs it does advance — only `clearAskId` clears it.

### Step 5a — Read `driftedPaths`: another pass may have been running (mt#3899)

Every write this command makes — `--ack` and `clearAskId` alike — is reconciled
against the store as it stands at write time, not the snapshot the pass read
minutes earlier. A target another pass changed in between is **not** overwritten:
its edit is DROPPED and the path is named in the result's `driftedPaths` (and in
the text output's `Dropped N write(s)` line). An uncontended pass returns `[]`.

**A non-empty `driftedPaths` means your pass raced another one, and lost that
path.** Treat it as a real finding, not noise:

1. Say so in your pass output, naming the paths. A silent loss is the failure
   this reporting exists to prevent.
2. Do NOT re-run `--ack` to force it through. The other pass's watermark reflects
   a review that actually happened; overwriting it re-opens exactly the data loss
   Step 5's `askId` branch guards against.
3. Whatever classification work you did on a drifted log was duplicated — the
   other pass reviewed the same fires. Reconcile before filing: check for a task
   or ask that pass already filed on the same log, and fold your findings into it
   rather than filing a near-duplicate.

`watermarkAdvanced` and `clearedAskId` are now honest about this: each is false
when EVERY target of that operation drifted, so a pass that accomplished nothing
no longer reports success.

**Prevention is cheap and worth doing.** This is a shared resource across
concurrent sessions, so before starting a pass, run the presence probe from
`user-preferences.mdc §Probe before claiming a shared resource` over the
calibration surface — a recent task or ask filed against a log you are about to
review is the visible signature of a pass in flight. The originating incident
(2026-08-10) had two agents classify the same 42 fires on `bare-entity-ref`
inside four minutes and file overlapping findings; neither probed.

## Cross-references

- Tracking task: mt#2483. Migration target for the recurring trigger: mt#2322
  (cockpit-daemon scheduler) — until then the trigger is an interim `/schedule`
  routine.
- Hooks reviewed: mt#2216 (causal-premise), mt#2057 (retrospective-trigger),
  mt#2471 (ask-routing-deferral; registered in the sweep by mt#2498).
- Memory `3772c77d` (the causal-premise pattern this calibration data measures).
- Asks subsystem: mt#1034 / ADR-008.
- mt#2619 — the calibration-review-cadence-detector hook this skill's warning
  points at.
- mt#2659 — ask-aware suppression: `openAskId` watermark field (Step 1a),
  `direction.decide` kind fix (Step 4), `askId`/`clearAskId` wiring (Step 5).
  Fixes the 2026-07-07 incident where the policy-coverage cadence warning
  fired on nearly every turn AND kept demanding a re-review already blocked on
  an open disposition ask.
- mt#3326 — Step 4's plain-language-lead template (4a), precondition-safe
  recommendation rule (4b), `asks_create` form-lint hard-reject handling
  (4c), and the cold-reader acceptance bar. Originating incident: ask#6448
  (2026-07-29), filed by this skill, failed a cold-reader actionability
  test. Reference exemplar: the corrected ask#6448 body (`asks_get
id:91b77372-6b14-4a85-b526-25b703b3c1f8`). Companion change: `asks.create`
  itself now hard-rejects form-lint violations at the tool boundary
  (`src/adapters/shared/commands/asks.ts`'s `validateFormLintNotViolated`),
  not just for asks this skill files.
