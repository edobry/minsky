# wall-of-text-detector

**Event:** `UserPromptSubmit` (guard-dispatcher, `GUARD_REGISTRY`)
**Task:** mt#2870 (communication-altitude RFC Phase 3, enforcement half — over-signaling side)
**Mode:** calibration-first (mt#2263 / ADR-024 ladder) — log-only, `INJECTION_ENABLED = false`
**Log:** `.minsky/wall-of-text-calibration.jsonl` (registered in `CALIBRATION_LOG_REGISTRY`)
**Override:** `MINSKY_SKIP_WALL_OF_TEXT=1` (plus the shared `MINSKY_HOOK_OVERRIDE` channel)
**Fail posture:** open — transcript/read/measurement errors return null (silent allow)

## What it measures

The OVER-signaling sibling of `silent-stretch-detector` (mt#2824): where that guard flags a
turn that said too little, this one flags a turn-end report that said too much, or in the
wrong shape. At each prompt boundary it takes the just-completed turn's FINAL assistant text
block — the message the principal actually reads as the turn report — and measures it against
the Tier-1 turn-report contract (`communication-contract.mdc`, mt#2713):

| Signal                            | Definition                                                                                                                                                          | Trigger                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `wordCount` / `lineCount`         | size of the final text block                                                                                                                                        | fires at >= 2x the contract's ~200-word budget (>= 400 words)                                |
| `leadLabelHits`                   | skill-internal label patterns — gate/criterion letters (`gate (l)`), parenthesized roman-numeral premise labels (`(iii)`), `SC#N` refs — inside the first 150 words | fires on any hit (the contract allows labels only in a trailing audit block, never the lead) |
| `deeplinkCount` / `namedRefCount` | `minsky://` links vs named refs (`mt#N`, `PR #N`)                                                                                                                   | logged, not a trigger — the pointer-presence signal for later calibration review             |

All signals are deterministic (regex + counting; no LLM). Thresholds are pinned to the
contract's verbatim "hard budget: readable in under 30 seconds (~200 words)"; the 2x
multiplier separates clear violations from legitimately expanded reports (severity pierces
the register by design — calibration data will show how often that happens).

## Record shape

```json
{
  "timestamp": "…",
  "session_id": "…",
  "wordCount": 912,
  "lineCount": 41,
  "trigger": "both | over-budget | lead-labels",
  "leadLabelHits": ["gate-letter"],
  "deeplinkCount": 0,
  "namedRefCount": 7,
  "textHash": "…",
  "suppressedByDepthRequest": false,
  "suppressedByQuestionAnswer": false,
  "suppressionReasons": []
}
```

`textHash` and the COMBINED suppression verdict (either gate below) are the dedupe key's two
dimensions (mt#3028 fix (2), extended by mt#3112 and mt#3718): an unchanged report is re-logged
only when its suppression state changed.

`suppressionReasons` (mt#3207) is the SHARED contract every calibration record carries —
`["depth-request-override"]` when the depth-request override withheld the reminder,
`["question-answer-override"]` when the mt#3718 question-answer override did (see below), `[]`
when the fire was injected. It duplicates `suppressedByDepthRequest` /
`suppressedByQuestionAnswer`'s verdicts on purpose: `isSuppressedRecord` in the sweep reads only
`suppressionReasons`, so the detector-specific booleans alone left the overrides' real-world fire
rates — ask#5425's stated payoff for flipping this detector live, and ask#6891's for the second
gate — invisible to the review cadence. An ABSENT field is not the same as `[]`: records written
before mt#3207 carry no field and count as injected.

**mt#3718 — question-answer override.** A SECOND, independent suppression gate alongside the
depth-request override: when the opening prompt of the measured turn itself reads as a
substantive question (`detectSubstantiveQuestion` — non-empty, contains `?`, at least
`QUESTION_MIN_WORDS` words), a report answering it is suppressed but still logged
(`suppressedByQuestionAnswer: true`, `suppressionReasons: ["question-answer-override"]`). Two
differences from the depth-request override: (1) it anchors on the single OPENING prompt only
(`resolveQuestionAnswerCheck`), not a multi-turn lookback; (2) it applies ONLY to the pure
`over-budget` trigger — a label-led report (`lead-labels` or `both`) is never excused by a
preceding question. Approved by the 2026-08-04 calibration review (ask#6891, "Approve: keep 1,
file tunes for 2 and 3").

Diversity axis for the calibration-review cadence machinery: distinct `session_id` values
(like silent-stretch — there is no matched-phrase concept).

## Graduation

Injection (the reminder text in `buildInjectionReminder`) activates only by flipping
`INJECTION_ENABLED` after a `/calibration-review` pass on the accumulated log shows an
acceptable false-positive rate — per the mt#2263 detector ladder. Until then the guard is
measurement only.

## Origin

The 2026-07-15 mt#2777 planning output led with a four-part premise audit and a 14-row
criterion table; the principal responded "This is too much information." The discipline-layer
fix is `user-preferences.mdc §Plain-language first` (mt#2801) + the Tier-1 contract (mt#2713);
this detector is the measurement layer for that discipline, exactly as
`silent-stretch-detector` is for the heartbeat rule.
