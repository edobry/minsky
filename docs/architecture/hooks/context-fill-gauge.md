# Context-fill gauge (mt#4291)

`UserPromptSubmit` observer. Reads the last assistant record's `usage` from the transcript,
computes the session's context fill against the model's window, records it, and — once graduated —
reports it back to the agent as one line.

## Why it exists

An LLM has no introspective access to its own token count. No API exposes one to the model, and no
harness event carries it. From the inside, turn 200 feels like turn 5 — which is why an agent runs
to the wall without noticing: it is not ignoring a gauge, it has none.

The only way to supply one is from outside the model: read the transcript the harness writes,
compute the number, and hand it back as text.

## What it does NOT claim

**Fill does not predict quality decay, and this guard does not assert that it does.** Measured over
545 local sessions (mt#2531 `## Findings`): user-correction markers sit at ~37.8% median fill while
sessions routinely pass 60% uneventfully. The literature agrees — the strongest measured
degradation driver is turn structure (Laban et al. 2025: 39% drop from splitting the same
information across turns at equal token count), not token volume, and two long-horizon agent
benchmarks find their collapse modes uncorrelated with window fill.

What fill DOES predict, by construction rather than by inference, is the harness's own
auto-compaction — that event triggers ON a token count, so predicting it is arithmetic, not
modeling. Observed 12 times in the local corpus at 99.6% median fill.

## Signal

Walk `ctx.transcriptLines` backward for the most recent assistant record carrying `usage`:

```
fill = usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens
```

`output_tokens` is excluded: it is what the call PRODUCED, not what it was given, and it reappears
inside `cache_read` on the next call. Including it would double-count one turn early.

Backward and single-record, unlike `silent-stretch-detector` / `wall-of-text-detector`, which need
a bounded turn window. Context size is a point reading — the last record wins.

**The declared type omits both fields it reads.** `TranscriptLine.message` declares only
`role`/`content`, while `parseTranscript` casts each line rather than validating it, so `usage` and
`model` survive at runtime. The guard casts locally at its read site. Widening the shared type is a
separate change, deliberately not made here (`transcript.ts` was in flight on mt#2544 / mt#3650).

## Denominator

A small hardcoded `KNOWN_MODEL_WINDOWS` keyed on `message.model` — matched on the exact id first,
then on the id with trailing numeric segments stripped — with a conservative fallback.

Deliberately NOT `packages/domain/src/ai/model-cache/model-limits-catalog.ts`: that module fetches
~1.6MB over the network with a 20s timeout. Correct for AI-completion routing, far outside the
latency budget an injection-path hook holds itself to.

The 1M figures are **empirical, not vendor-documented** — `claude-opus-5`, `claude-opus-4-8` and
`claude-fable-5` each cluster against a ~999K ceiling before a hard reset across 553 local
transcripts. `claude-sonnet-5` was never observed above 222,427 locally, too small a sample to pin,
so it is absent and takes the fallback.

**The suffix retry (mt#4968).** The table is keyed on a FAMILY id, but a shipped model id often
carries a release suffix on top of one — `claude-fable-5-1`, or a dated `claude-opus-5-20260101`.
Exact-match alone therefore missed a model whose family was already in the table, and it missed
SILENTLY: the fallback returns a number, not an error, so the reading looked ordinary. It cost
more than the "one noticeable line" the paragraph below budgets for — `claude-fable-5-1` ran a
conversation to 308,060 tokens and the gauge reported 154% of a 200K window; the agent relayed the
figure to the principal as fact and recommended a checkpoint on it, and the principal caught it
against Claude Code's own status line.

`resolveWindow` now retries after stripping trailing all-digits segments, one at a time, until the
id has none left. Every value it can return still comes from a key already in the table, so it
cannot invent a window for an unmeasured family: `claude-sonnet-5-1` strips to the deliberately
absent `claude-sonnet-5` and still takes the fallback, and `claude-zeta-9` strips to `claude-zeta`
and does the same. Only a fully numeric final segment is stripped, so a `-preview`-style variant
falls back rather than inheriting a window it may not share. A resolution reached by stripping is
reported as `known-model`, because the WINDOW is measured — `windowSource` is about the
denominator's provenance, not the id's spelling.

`claude-fable-5-1` was also added to the table outright, on the same empirical basis as the other
entries: re-measured 2026-09-04 over the transcripts then on disk, max observed fill **980,707**
across 1,284 records. That is a direct measurement of the id, not an inheritance from its family.
The same pass measured `claude-opus-4-7` at 227,887 over 169 records and `claude-sonnet-5` at
157,325 over 55; both remain absent for the sample-size reason above, and both figures come from a
smaller corpus than the 553 transcripts cited earlier (reaped conversations are gone from disk), so
they are a second reading rather than a correction of it.

**The fallback is small on purpose.** The two errors are not symmetric: under-estimating the window
over-reports fill, costing one noticeable line; over-estimating it under-reports fill, costing the
gauge its entire purpose while producing no signal that anything went wrong.

## Compaction boundary

Nothing special-cases it, and nothing should. After the harness compacts, `cache_read_input_tokens`
reflects the post-compaction state, so the sum resets on its own (observed ~996K → ~107K).

That reset is the correct reading of **headroom**. It is not a statement about session health — a
session that has already compacted has already taken the loss. The transcript file itself is
append-only; the pre-compaction records remain on disk, and a synthetic
`{"type":"user","isCompactSummary":true}` record marks the boundary (see mt#4289 for the ingest-side
consequence of that record being retained unmarked).

## Thresholds

Expressed as ratios rather than the absolute token counts they were derived from, because the
denominator varies per model and a cutoff calibrated on a 1M window is unreachable on a 200K one.

| Tier     | Default | Basis                                                                                                                                                                                                                           |
| -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WARN     | 80%     | Tail-entry inflection in the observed session-max distribution (59.6% of 545 sessions cross 50%; only 18.3% cross 80%). **Tied to no observed quality failure** — a distributional marker only.                                 |
| CRITICAL | 95%     | p10 of observed auto-compaction onsets (982,748 of 1M) minus room to act. That subtraction assumed ~15 turns at the observed 2,203 median tokens/turn, and **the 15 is ungrounded** — nobody has measured what a handoff costs. |

Both are DISPLAY cutoffs, which is what makes a wrong value cheap: a misplaced tier shows a line
slightly early rather than aborting anything.

Tunable via `MINSKY_CONTEXT_FILL_WARN_RATIO_PCT` / `MINSKY_CONTEXT_FILL_CRITICAL_RATIO_PCT`
(`readTunedThreshold`, preference class). **Outside ADR-032's tuning loop**: that ADR's loop
consumes a per-fire labeled-response signal, and no emitter exists for this guard, so these are
hand-set until one does.

## Recording

An evaluation record on **every** turn with a resolvable usage record, not only above threshold —
carrying fill, window, window source, ratio, turn count and tier. A fire-only stream can say "it
happened again" and never "it stopped happening" (mt#3583), and here the non-firing rows are the
more valuable half: they are the distribution the thresholds have to be checked against.

**Turn count is recorded and triggered on by nobody.** It is instrumentation for the question the
evidence says matters most (turn structure) and that we cannot yet answer locally — logging it now
means a future trigger can be derived rather than invented.

## Display-only

Ships `INJECTION_ENABLED = true` — **live, against the family's calibration-first default**.

That default exists to hold back an unproven PHRASE MATCHER while its false-positive rate is
unknown, and neither half of the reasoning transfers here. There is no paraphrase axis: the signal
is a sum compared against a table lookup, so a badly-placed threshold changes WHEN a true number
appears, never WHETHER a false one does. And log-only would have defeated the requirement outright —
a gauge writing to a file the agent never reads leaves it exactly as blind as before, which is the
"feature exists, tests pass, produces nothing" shape `work-completion.mdc §Invocation path` names.

Blast radius is bounded by the tiers rather than by a flag: ~18% of observed sessions ever cross
WARN, below it the guard emits nothing, and the emission is one line.

**Display-only is a DIFFERENT axis from that flag, and it still holds.** The guard reports; it acts
on nothing. The constraint is a principal decision: ask#8878 (closed 2026-08-18) took the
gauge and explicitly held the automatic-handoff half. The rendered line states a number and names
`/handoff` as available; it does not direct the agent to hand off, to stop, or to wind down. The
`work-completion.mdc` amendment that would authorize autonomous action is analysed in mt#2531
`## Authorization` and deliberately not landed.

`context-fill-gauge.test.ts` asserts the ABSENCE of an imperative, so a future edit that turns the
reading into an instruction fails a test rather than passing review.

The phrase **"context-density indicator"** in the rendered line is load-bearing, not decoration: it
is the `/handoff` skill's own auto-trigger vocabulary, so the skill needs no edit to recognize this
signal if the agent chooses to act on it.

## Placement

`contextPriority: 10` — the always-on ground-truth bucket shared with `inject-prod-state`,
`inject-current-time`, `inject-git-state`, `inject-memory-capture`.

This is the one non-obvious registration choice, and it answers a self-referential problem: the
merged context block drops its **lowest-priority** fragments when over `MERGED_CONTEXT_BUDGET_CHARS`,
so a saturation reading registered at a lower tier would be dropped exactly when it became worth
reading. Its steady-state cost is zero — below threshold it emits nothing at all.

`UserPromptSubmit` per ADR-031 ("anchor at `Stop`; detect and inject at `UserPromptSubmit`") and
`transcript.ts`'s own note that this event is where the transcript file has had the MOST time to
flush. No `Stop` anchor is needed: the guard reads one usage record, not a bounded turn window.

`PreCompact` was rejected as a source: it carries no token field in its payload, is not wired to the
dispatcher (`LifecycleEvent` has no member for it), and fires only once compaction is already
imminent — far too late to be useful for anything but a post-hoc marker.

## Tuning it

It already ships live, so there is no graduation step. What remains is threshold tuning, and the
evaluation stream is the instrument: it records EVERY turn, so the fill distribution and the
turn-count distribution are both available without waiting for fires.

The first question to ask of it is whether WARN at 80% is landing anywhere useful. It is tied to no
observed quality failure — only to a distributional inflection — so if the stream shows it firing on
sessions that were fine, lower the signal rather than defending the number.

Done at ship, recorded here so a later reader does not redo them:

- **Registered in both `guard-feedback-shape.test.ts` receipts** — the producing-guard list and the
  growth-shape map, classified `"capped"` rather than `"fixed"`. Measured 2026-08-18: 269 chars on a
  known model, 355 on the unknown-model path, which appended `assumed (model <id> not in the window
table)` and therefore grew with the MODEL ID's length. Every other interpolation is a number, so
  the declared `attentionCost: 400` was a measured ceiling against a realistic id rather than a
  proved bound, and this entry closed by naming the remedy: cap the id in the render or declare a
  `renderProbe`.

  **Both were done, by mt#4968** — the follow-up this paragraph was written to invite. The id is now
  capped at `MAX_RENDERED_MODEL_ID_CHARS` (40), which removes the only unbounded axis, and
  `renderWorstCase()` is wired as the entry's `renderProbe`. The declaration is now **450** against a
  probe-measured worst case of **422** (271 on the ordinary known-model path). The number moved for a
  second reason as well: mt#4968 lengthened the fallback branch so the ESTIMATED marker reaches the
  PERCENTAGE rather than sitting on the denominator. Raising it was checked against the shared
  per-turn budget rather than assumed safe — the guard does not enter the top-five conditional bucket
  `MERGED_CONTEXT_BUDGET_CHARS` is derived from, and the mt#3394 budget test passes at 450;

- **Canary `expects: "warn"`**, not `"calibration"`. That is the stronger assertion: `"calibration"`
  passes on both sides of the `INJECTION_ENABLED` branch, so it could not catch injection silently
  stopping — which for this guard means the agent going blind again with every test still green.
- **`MERGED_CONTEXT_BUDGET_CHARS` deliberately UNCHANGED.** It is hand-derived and does not
  auto-propagate, so this was checked rather than assumed: the bucket holds the five heaviest ACTUAL
  injectors, whose current floor is 600, and this guard's measured ceiling is 400. It does not enter
  the top five, so the constant must not move.

## Cross-references

mt#2531 (the research pass and its `## Findings`) · ask#8878 (the display-only decision) ·
mt#4289 (compact-summary records ingest unmarked) · ADR-031 (lifecycle event) · ADR-024 (this is a
Rung-1 numeric comparison with no paraphrase axis, so the ladder does not apply) · ADR-032
(threshold tuning) · mt#3383 (per-turn usage on the DB extraction path — orthogonal; that one makes
usage queryable, this one reads it live).
