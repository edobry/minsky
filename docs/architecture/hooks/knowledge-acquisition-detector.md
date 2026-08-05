# knowledge-acquisition-detector

**Event:** `Stop` (guard-dispatcher, `GUARD_REGISTRY`) — was `UserPromptSubmit` until mt#3720
**Task:** mt#2708 (mt#2707-RFC's (B) proactive-trigger half of the learn-capture primitive);
re-grained to one verdict per session by mt#3720
**Mode:** calibration-first (mt#2263 / ADR-024 ladder) — log-only, `INJECTION_ENABLED = false`
**Log:** `.minsky/knowledge-acquisition-calibration.jsonl` (registered in `CALIBRATION_LOG_REGISTRY`,
`reviewByDays: 14`, `liveSinceDate: 2026-07-23`)
**Override:** `MINSKY_ACK_KNOWLEDGE_ACQUISITION=1` (plus the shared `MINSKY_HOOK_OVERRIDE` channel)
**Fail posture:** open — transcript/read/detection errors return null (silent allow)

## What it detects

The (B) proactive-trigger half of the mt#2707 learn-capture primitive: in-task research
(WebSearch / WebFetch / knowledge tools) that surfaces knowledge relevant to a currently-loaded
skill, with no propagation action (`memory_create`, the `/learn` routing skill, or a filed task
targeting the artifact) **anywhere in the session**.

Since mt#3720 the unit of judgment is the SESSION, not the individual research call. A session
produces at most one calibration record, ever.

## Detection mechanism constraint (mt#2263 ladder)

Bare rung 1 ("a research tool ran, filtered to sessions where a skill was loaded") is close to a
no-op: skill bodies load into session context on first invocation and stay cached for the WHOLE
session (`skill-staleness-detector.ts`), and nearly every non-trivial session invokes at least one
management skill. Rung 1 alone cannot discriminate "this research is relevant to the loaded
skill's domain" from "this research is about anything at all."

v1 ships **rung 1 fused with a rung-2-lite skill-keyword-overlap gate** — not rung 1 alone:

| Condition                        | Signal                                                                                                                                                                                                                      |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (1) research tool ran            | a `WebSearch` / `WebFetch` / `mcp__minsky__knowledge_fetch` / `mcp__minsky__knowledge_search` / `mcp__minsky__knowledge_sync` tool_use call anywhere in the session                                                         |
| (1b) a skill was loaded          | a `Skill` tool_use call anywhere in the session (session-wide scan, not turn-scoped — mirrors `build-claim-injection-detector.ts`'s widening of `substrate-bypass-detector.ts`'s turn-scoped `extractSkillToolInvocations`) |
| (2, rung-2-lite) keyword overlap | the research tool's own input strings, plus the enclosing turn's assistant text, contain a word (≥ 5 chars) from the SPECIFIC loaded skill's own name or its compiled `SKILL.md` frontmatter `description:` field           |

This stays rung-1-cheap — no LLM call.

## The session verdict (mt#3720, extending the mt#2671 grace-period pattern)

An agent that recognizes the acquisition and says "I'll capture this after finishing the current
edit," then does so later, is a TRUE NEGATIVE that a same-turn gate would flag as a miss. The
detector therefore collects every research occurrence that clears the rung-1+2-lite gate and
judges them together:

1. **Eligibility.** The session is not judged until `TRAILING_WINDOW_TURNS` (5) turns have
   elapsed since the MOST RECENT matched occurrence. A session with continuing matched research
   keeps re-extending its own clock. Not-yet-eligible is a deferral, not a suppression: nothing
   is recorded, and it is re-evaluated on the next `Stop`.
2. **Verdict.** Once eligible, `hadPropagation` is true iff EVERY matched occurrence has a
   propagation call (`mcp__minsky__memory_create`, `mcp__minsky__tasks_create`, the spec-writing
   tools, `mcp__minsky__memory_update`, or a `Skill` invocation whose name contains "learn")
   somewhere after it. One uncaptured occurrence makes the whole session a miss — the detector
   is looking for knowledge that was never captured anywhere, not merely the first thing
   researched.
3. **Bound.** The record carries the fixed `SESSION_VERDICT_DEDUPE_KEY` (`"session-verdict"`),
   checked against the calibration log's own tail. `loadAlreadyLoggedDedupeKeys` filters that
   tail by `session_id`, which is what makes a shared constant safe across sessions.

**Why v1 was wrong, precisely.** The propagation SCAN was never the problem —
`hasPropagationAfter` was already unbounded, scanning to the end of whatever transcript is
visible. The problem was WHEN evaluation happened. v1 judged each research call the moment its
own grace elapsed, using only the transcript visible at that moment, and its per-occurrence
dedupe key made that verdict permanent. For the `aecd65f4` session (research early, durable
write ~17 turns later) grace elapsed around turn 8 — long before the save existed — and each of
the session's research calls repeated the mistake independently, producing 13 of the 17 fires
reviewed at ask#6891.

**What this does NOT fix (mt#3740).** `Stop` fires once per TURN, so the detector still sees a
growing transcript rather than a finished one. A session that goes quiet past the grace period
and only then propagates can have a miss recorded first, and the one dedupe key makes that
verdict permanent. mt#3740 owns the residual; a test in
`knowledge-acquisition-detector.test.ts` asserts the current wrong behavior deliberately so the
fix must invert it rather than delete it. What holds unconditionally is the BOUND: one record
per session, which is what retires the 13-from-one-session shape.

Recording the true negative is what makes the propagation gate's own fire rate measurable; the
sweep excludes suppressed records from the injected count (mt#3197), so it does not distort FP
math. It is safe to burn the dedupe key on a propagated verdict because it is TERMINAL —
propagation is in the past and cannot un-happen. The other skip legs are deliberately NOT
recorded for the opposite reason: the grace period is a deferral (a record would fire every turn
and consume the key the eventual real fire needs), and the missing loaded-skill keyword overlap
is part of the rung-2-lite detection criterion rather than a gate over a completed detection.

## Why `Stop`, not `SessionEnd`

Session grain invites a session-end seam, and `SessionEnd` was evaluated and rejected at mt#3720:

- `SessionEnd` has **zero** guards wired through `GUARD_REGISTRY`. The repo's one `SessionEnd`
  hook (`transcript-ingest-on-session-end.ts`) is wired directly in `.claude/settings.json`,
  bypassing the calibration-log, canary, and override plumbing this detector depends on. Building
  a `SessionEnd` dispatcher entrypoint is a larger change than a detector re-grain.
- Per ADR-017, `/exit` and `/clear` do not fire `SessionEnd` at all, so its absence proves
  nothing — it is not a reliable end-of-session signal in this harness either way.
- `Stop` already hosts five other guards on the same dispatcher, including a directly-analogous
  calibration-first, log-only sibling (`stop-at-decision-scan`, mt#3653), and firing once per
  turn means at least one invocation sees a killed session where `SessionEnd` would see none.

The cost is that per-session dedupe becomes load-bearing, since `Stop` — unlike `SessionEnd` —
fires repeatedly across one session. That is the mt#3740 residual above.

## Whole-session scan

Both the loaded-skill list and the research-tool occurrences are scanned across the WHOLE
session transcript (`ctx.transcriptLines`), not just the last turn — the research call and its
matching skill-load, and the propagation window, routinely span many turns. This mirrors
`build-claim-injection-detector.ts`'s widening precedent.

## Tool-interleaved transcript hazard (memory a3e60471)

Claude Code records `tool_result` blocks as USER-ROLE transcript lines. This detector's entire
signal is tool calls interleaved with text, so it is maximally exposed to the trap that silently
killed three sibling hooks for weeks. It uses ONLY the shared `.minsky/hooks/transcript.ts`
helpers (`findRealPromptIndices`, `isRealUserPrompt`, `extractAssistantText`,
`extractToolUseNames`, `readLogTailText`) — never a local copy of the turn-boundary logic.

## Record shape

```json
{
  "timestamp": "…",
  "session_id": "…",
  "detectionRung": "1+2-lite",
  "researchTools": ["WebSearch"],
  "loadedSkills": ["engineering-writing"],
  "hadPropagation": false,
  "matchedSkill": "engineering-writing",
  "matchedKeyword": "argumentative",
  "dedupeKey": "session-verdict",
  "suppressionReasons": []
}
```

`suppressionReasons` (mt#3207) is the shared contract the sweep's `isSuppressedRecord` reads:
`["propagation-in-window"]` on a record the propagation gate suppressed (paired with
`hadPropagation: true`), `[]` on a fire that injected. An ABSENT field is not the same as `[]` —
records written before mt#3207 carry no field and count as injected.

Diversity axis for the calibration-review cadence machinery: distinct `loadedSkills` values, NOT
matched phrases — declared per the mt#2708 spec's Graduation contract (a tool-use-pattern detector
has no natural "phrase," and distinct loaded-skill names are more semantically meaningful than
tool names for this detector). Without this axis the log could sit `lowDiversity` forever — the
mt#2896 under-threshold-forever trap, reopened here on the diversity axis rather than the count
axis mt#2896 originally closed.

## Graduation

Injection (a future `buildInjectionReminder` reminder) activates only after a
`/calibration-review` pass on the accumulated log shows an acceptable false-positive rate — per
the mt#2263 detector ladder. The registry entry declares `reviewByDays: 14` — deliberately
tighter than mt#2923's 30, since research-tool calls are routine (unlike mt#2923's rare compound
merge+claim trigger), so the count/diversity leg should bind first; the time leg here is a
backstop.

## Liveness proof (mt#3078 precedent)

`liveSinceDate: 2026-07-23` anchors the `reviewByDays` clock to the date the detector's full
invocation path — dispatcher → registry → `run()` → transcript parse → detection → calibration
write — was proven alive via a live synthetic positive/negative-control run (this task's PR body
"Testing" section carries the transcript), plus the registered `canary` in `GUARD_REGISTRY` (which
`bun scripts/run-guard-canaries.ts` exercises against the REAL `engineering-writing` skill file on
every run, not a synthetic stand-in).

## Origin

mt#2707 RFC (Notion `3a0937f0-3cb4-81a6-8699-e419a5ce4da0`) — the design record naming the (A)
`/learn` routing skill (mt#2709, DONE) and (B) this proactive-trigger detector as the two halves
of the learn-capture primitive. Family: substrate-bypass (mt#2020) is the architectural template;
mt#2216 / mt#2471 are the calibration-first precedents; mt#2263 governs mechanism choice; mt#2671
is the trailing-window suppression precedent (pre-narration-detector.ts); mt#2896 is the
never-reviewed-aging cadence leg; mt#3078 is the proven-alive `liveSinceDate` re-anchoring
precedent.
