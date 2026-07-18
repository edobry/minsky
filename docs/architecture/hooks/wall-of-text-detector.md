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
  "namedRefCount": 7
}
```

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
