# Turn-End Retrospective Scan (`turn-end-retro-scan.ts`)

**Event:** `Stop` (the ADR-028 dispatcher's first Stop-event guard, via `dispatch-stop.ts`)
**Tier:** advisory — never `decision: "block"`; never denies anything
**Override:** `MINSKY_ACK_RETROSPECTIVE_TRIGGER=1` (shared with the prompt-time scanner)
**Fail posture:** open — store/read errors degrade to "nothing flagged"; matcher errors are the shared matcher's (elision-guarded regex)
**Calibration log:** `.minsky/retrospective-trigger-calibration.jsonl`, discriminated by `channel: "stop"`
**Origin:** mt#2357 (scope decided via ask#9 option B); subsumed mt#2467

## What it does

At every turn end (Stop event), scans the just-completed turn for the R1–R5
retrospective-trigger families using the SAME Rung-1 matcher as the
prompt-time `retrospective-trigger-scanner.ts` (quotation/code elision +
meta-discussion suppression — `detectTriggerPhrases` is imported, not
copied). On an unaddressed match it emits advisory Stop-hook feedback
(`hookSpecificOutput.additionalContext`), which per hooks.md continues the
conversation one beat — so the AGENT addresses the admission (invokes
`/retrospective`, files the task) before the turn actually ends, with no
operator attention required.

## Why turn-end exists (and why it is narrow)

The prompt-time scanner covers a completed turn at the NEXT user prompt —
including queued mid-work messages, which DO fire UserPromptSubmit on the
current harness (verified 2026-07-21 during mt#2357 planning; the June-2026
queued-message-blind-spot premise was falsified). The one case the
prompt-time architecture cannot reach: a trigger phrase in a conversation's
FINAL turn, where no subsequent prompt ever arrives and an actionable
admission would die silently when the operator closes the session. That is
this guard's coverage target.

### Covers

- A trigger phrase in ANY completed turn, including a conversation's final turn.
- Mid-turn admissions: earlier-in-turn transcript content is present at
  Stop time; the final message arrives directly via the Stop payload's
  `last_assistant_message` (hooks.md documents the transcript file may lag
  at Stop time — the guard scans the union).

### Does NOT cover

- Sessions terminated without a Stop event (crash, kill, user interrupt —
  Stop does not fire on interrupt). No owner: the SessionEnd/attention
  backstop (ask#9 option B+) was explicitly declined; file on evidence.
- The operator closing the session during the advisory continuation beat.
- Paraphrases outside the Rung-1 regex families — Rung-2 embedding upgrade
  is owned by mt#2366 under the mt#2263 detection ladder; this guard
  inherits it automatically because the matcher is shared.

## Dedup — one advisory beat per phrase

Every Stop-hook output continues the conversation and counts toward the
harness's cap of 8 consecutive continuations. The per-session store
(`turn-end-scan-store.ts`, `~/.local/state/minsky/turn-end-scan/<session>.json`)
keys each flag by (opening-prompt uuid/timestamp, family, phrase):

- A re-fire of Stop for the same turn (the continuation) is silent unless a
  NEW (family-distinct) phrase appeared — so a false positive costs exactly
  one visible beat.
- The prompt-time scanner reads the same store (`filterStopFlagged`) and
  skips assistant-side phrases already flagged at turn end, so the same
  admission is never reminded twice. User-correction / method-redirect
  families are prompt-side only and never filtered.

Note `detectTriggerPhrases` yields at most one match per family (first
pattern wins), so a second same-family phrase in the same turn is implicitly
masked — accepted: the agent already received that family's reminder for
this turn.

## Suppression

A `Skill(retrospective)` invocation anywhere in the completed turn silences
the guard — the admission was already acted on.

## Turn boundary correctness (the mt#2357 primary fix)

This guard depends on `transcript.ts`'s `extractFinalTurn` and the
`isRealUserPrompt` skill-body exclusion shipped in the same task: Skill-tool
invocation bodies (user-role text lines opening "Base directory for this
skill:", stamped `isMeta: true`) previously registered as real prompt
boundaries, splitting every skill-spanning turn. That bug corrupted all
eight turn-boundary consumers (it reset the silent-stretch silence clock
mid-turn and caused mt#2467's substrate-bypass suppression false positive —
both now regression-tested). The exclusion checks the `isMeta` flag first
and falls back to the text prefix for harness versions that don't stamp it.

## Verification

- Unit: `turn-end-retro-scan.test.ts` (fire/suppress/dedup/lag-union/elision/override),
  `transcript.test.ts` (boundary + `extractFinalTurn`), `retrospective-trigger-scanner.test.ts`
  (`filterStopFlagged`), `substrate-bypass-detector.test.ts` (mt#2467 replay),
  `silent-stretch-detector.test.ts` (no silence-clock reset).
- Canary: registry declaration (`expects: "warn"`, store-clearing `setup`) — passes via
  `bun scripts/run-guard-canaries.ts`.
- Live smoke (2026-07-21): synthetic Stop payload piped into the compiled
  `dispatch-stop.ts` produced the advisory with `hookEventName: "Stop"`; an identical second
  invocation was silent (dedup); the synthetic calibration record was removed from the live log.
