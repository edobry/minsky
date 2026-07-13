---
name: calibration-review
description: >-
  Review hook-calibration JSONL logs and, for any log past its review threshold,
  false-positive-classify the matched records and emit ONE operator-routed Ask
  with the FP rate plus a flip/tune/keep recommendation — then advance the
  watermark. Use when running the periodic calibration sweep (scheduled or
  manual), or when asked to "review the calibration data" for the
  causal-premise / retrospective-trigger detector hooks.
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
positives, and packaging the decision as an Ask.

## Step 1 — Run the sweep (read-only)

Call the command in JSON mode, read-only (do NOT pass `--ack` yet):

- MCP: `mcp__minsky__observability_calibration-review` with `json: true`
- CLI: `minsky observability calibration-review --json`

It returns, per registered log: `totalFires`, `firesSinceLastReview`,
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
   (a single ask id, not an array — one review pass always files exactly one
   ask covering every past-threshold log in that pass, so there is only ever
   one id to clear at a time). Then proceed to classify this log's NEW fires
   (if any) normally in Step 2 onward.
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

If **no** log has `pastThreshold: true` (after excluding still-open-ask logs
per step 3 above), stop — nothing to review. Do not emit an Ask, do not
advance watermarks.

## Step 2 — False-positive classification

For each log with `pastThreshold: true`, go through its `newRecords` and
classify each as **real positive** or **false positive**:

- A record is a **false positive** if the matched claim was legitimate and did
  NOT need verification — e.g. `hadSameTurnVerification` is true, the matched
  phrase is a quote / example / doc reference, or the "claim" is not actually a
  volunteered causal/mechanism assertion.
- A record is a **real positive** if it is a volunteered "X because Y" /
  "running X will do Y" mechanism claim with no same-turn falsifier.

When the record alone is ambiguous, say so and lean toward calling it
**uncertain** rather than guessing — the goal is an honest FP rate, not a
flattering one. Compute `fpRate = falsePositives / firesSinceLastReview` per
log.

## Step 3 — Recommendation

Per log (a `pastThreshold` log already cleared BOTH the fire-count and the
diversity bar — the command gates `pastThreshold` on both, so low-diversity logs
never reach this step; they stay in the "keep collecting" state with
`atCountThreshold: true, pastThreshold: false` and produce no Ask), pick one:

- **flip** — FP rate is low (rule of thumb: < ~20%): recommend enabling the
  hook's injection mode (e.g. flip `INJECTION_ENABLED` to `true` for the
  causal-premise hook, or stop treating retrospective-trigger as log-only).
- **tune** — FP rate is high: recommend tightening the detector's patterns
  (name the phrases driving the false positives).

## Step 4 — Emit ONE Ask (do not flip anything yourself)

Emit a single operator-routed Ask via `mcp__minsky__asks_create` with
**kind `direction.decide`** (mt#2659 — corrected from `quality.review`; see
"Why `direction.decide`, not `quality.review`" below). The Ask body must
contain, per past-threshold log:

- the log name + `firesSinceLastReview` / `totalFires` + `distinctPhrases`
- the FP rate and a few representative false positives
- the recommendation (flip / tune / keep) with one line of rationale

**You MUST NOT** edit any hook file, flip `INJECTION_ENABLED`, or change any
detector pattern. The flip is the principal's decision; the Ask surfaces it.
The skill's job ends at the Ask.

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

After the Ask is created, capture its `id` from the `asks_create` response.
Re-run the command WITH `ack: true` AND the new id in `askId`, so the
cadence-detector hook (mt#2659) knows to suppress its per-turn warning for
these logs until the ask resolves:

- MCP: `mcp__minsky__observability_calibration-review` with `ack: true`,
  `askId: "<id from asks_create>"`
- CLI: `minsky observability calibration-review --ack` plus the CLI's
  generated flag for `askId` — check `--help` for the exact flag spelling

This marks the reviewed fires so the next sweep only considers new ones AND
records `openAskId` on every past-threshold log's watermark. This makes the
loop idempotent: a re-run with no new fires emits no Ask, and a re-run while
the ask is still open (Step 1a) skips straight past without re-asking.

**Command-level guard (belt-and-suspenders).** If Step 1a's skip is ever
missed, the command itself refuses to help: `--ack` WITHOUT `askId` never
silently advances the watermark of a past-threshold log whose watermark
already carries an `openAskId` — that log is left untouched (surfaced in the
result as `skippedOpenAskPaths`) instead of being marked reviewed. Passing
`askId` on the ack call always advances every past-threshold log regardless
of any pre-existing `openAskId` (an explicit reaffirmation), and an `--ack`
call that omits `askId` entirely never drops a pre-existing `openAskId` on
the logs it DOES advance — only `clearAskId` clears it.

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
