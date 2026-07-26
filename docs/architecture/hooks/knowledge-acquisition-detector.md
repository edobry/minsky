# knowledge-acquisition-detector

**Event:** `UserPromptSubmit` (guard-dispatcher, `GUARD_REGISTRY`)
**Task:** mt#2708 (mt#2707-RFC's (B) proactive-trigger half of the learn-capture primitive)
**Mode:** calibration-first (mt#2263 / ADR-024 ladder) — log-only, `INJECTION_ENABLED = false`
**Log:** `.minsky/knowledge-acquisition-calibration.jsonl` (registered in `CALIBRATION_LOG_REGISTRY`,
`reviewByDays: 14`, `liveSinceDate: 2026-07-23`)
**Override:** `MINSKY_ACK_KNOWLEDGE_ACQUISITION=1` (plus the shared `MINSKY_HOOK_OVERRIDE` channel)
**Fail posture:** open — transcript/read/detection errors return null (silent allow)

## What it detects

The (B) proactive-trigger half of the mt#2707 learn-capture primitive: in-task research
(WebSearch / WebFetch / knowledge tools) that surfaces knowledge relevant to a currently-loaded
skill, with no propagation action (`memory_create`, the `/learn` routing skill, or a filed task
targeting the artifact) in a **trailing window** of turns after the research.

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

## Propagation: a trailing window, not same-turn equality (mt#2671 pattern)

An agent that recognizes the acquisition and says "I'll capture this after finishing the current
edit," then does so a few turns later, is a TRUE NEGATIVE that a same-turn gate would flag as a
miss. Because a `UserPromptSubmit` hook only ever sees what has ALREADY happened, a candidate
research event is evaluated only once `TRAILING_WINDOW_TURNS` (5) turns have elapsed since it
occurred — the agent gets a grace period before the absence of propagation is treated as a miss.
Once due, if a propagation call (`mcp__minsky__memory_create`, `mcp__minsky__tasks_create`, or a
`Skill` invocation whose name contains "learn") appears anywhere after the research call, the
event is a true negative and nothing is logged. If not, the event fires exactly once (a stable
`${lineIdx}:${toolName}` dedupe key, checked against the calibration log's own tail, prevents a
matured-but-unresolved event from re-firing on every subsequent turn).

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
  "dedupeKey": "3:WebSearch"
}
```

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
