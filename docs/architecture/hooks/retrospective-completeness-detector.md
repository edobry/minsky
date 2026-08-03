# retrospective-completeness-detector

**Event:** `UserPromptSubmit` · **Mode:** log-only (never injects, never blocks) ·
**Calibration log:** `.minsky/retrospective-completeness-calibration.jsonl` ·
**Override:** `MINSKY_SKIP_RETRO_COMPLETENESS` · **Task:** mt#3601

## What it does

When the just-completed turn produced retrospective-shaped work, it checks two things the
`/retrospective` skill requires and nothing previously verified:

1. **Section completeness against the DECLARED triage level.**
   - Every level: `### Triage`.
   - `Process failure` / `Repeated failure`: the full set — `Incident`, `Agent error`,
     `Failure mode`, `Root cause`, `Recurrence check`, `Fixes`, `Verification`.
   - `Repeated failure`, **or** any stated family recurrence count ≥ 3: `Escalation`.
2. **The Step 5 liveness check actually ran.** Every `mt#` id the output cites must have had its
   status read in-turn by a `tasks_status_get` / `tasks_get` call. This is keyed on tool-call
   STATE, not on prose claiming the check was performed.

## Why it exists

The skill's output format is prose the agent is trusted to produce. A retrospective missing
`### Verification`, the family `### Escalation`, and every liveness check is indistinguishable —
to every mechanism in this repo — from a complete one. The only detector has been a careful human
reader, which is why both known recurrences were caught by the principal:

| R   | Date                 | Pressure                                      | What was omitted                                                                                                                            |
| --- | -------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | 2026-06-28 (mem#598) | batch volume — 7 incidents at once            | every Step 6 Verification, the family Escalation, all Step 5 liveness checks                                                                |
| R2  | 2026-08-03 (mem#826) | correction pressure — a single incident chain | Triage, agent-error taxonomy, structural-gap category, Recurrence check, Verification; family membership ASSERTED without running the count |

R1's fix shipped at **memory tier** and did not contain R2 — which is the argument for a detector
rather than another prose reminder. R1's framing ("batch volume is not a license to compress") was
also too narrow: R2 had no batch at all. The generalized root is that **completeness degrades under
any pressure gradient, and omission carries no signal.**

Family: `retrospective-under-run` (mem#598 is the root). Sibling task mt#3602 covers the tooling
half — `memory_update` being wholesale-replace-only is why the R5 family-root append was deferred.

## Design decisions

**Why `UserPromptSubmit` and not `Stop` — ADR-031.** This detector is _tool-inspecting_: it reads
the turn's `tool_use` blocks for the `Skill{skill:"retrospective"}` invocation and for
`tasks_status_get` calls. Per ADR-031's sub-operation table, tool calls are read at
`UserPromptSubmit`, where the transcript has had the **most** flush time — not at `Stop`, where it
has had the least. It slices against the `Stop`-recorded anchor when one exists and degrades to
`resolveCompletedTurn` when it does not. It deliberately inherits ADR-031's known gap: the final
turn of a conversation is not scanned by any prompt-time detector.

**Why ADR-024's ladder does not govern the matching.** That ADR scopes itself to detectors matching
paraphrasable **trigger phrases**, where recall misses drive the rung choice. This detector matches
**section headings whose exact text the skill mandates** — a heading is present or it is not, so
there is no recall axis to widen and Rung 2 (embedding) does not apply. Choosing deterministic
matching here is therefore not the regex-arms-race anti-pattern ADR-024 exists to end. Two of its
cross-cutting invariants **do** apply and are honored: a scan that throws records a `degraded`
marker rather than silently passing, and records carry `source: "live"` for the coverage-receipt
done-gate.

**Why `unknown` triage is treated as the full set.** An output with retrospective-shaped headings
that never declares a triage level has skipped Step 0.5. The compressed format is legitimate only
as an explicit call, so an undeclared level cannot claim it.

**Primary false-positive risk.** A correctly-compressed `Minor correction` retrospective. It is
covered by an explicit test and requires only `### Triage`.

## Calibration record shape

```jsonc
{
  "source": "live",
  "timestamp": "2026-08-03T20:00:00.000Z",
  "session_id": "…",
  "triggered_by": "skill-invocation" | "output-shape",
  "triage": "minor" | "process" | "repeated" | "unknown",
  "family_count": 5,
  "missing_sections": ["Verification", "Escalation"],
  "unverified_task_ids": ["mt#2052"]
}
```

A `degraded` record carries `{ "degraded": "<error message>" }` in place of the finding fields.

## Graduation

Log-only per the mt#2263 calibration ladder. Graduating to injection is a separate decision, taken
against the measured FP rate via the `/calibration-review` sweep — not on a schedule.

## Cross-references

`.claude/skills/retrospective/SKILL.md` (the required-section contract) ·
`.minsky/hooks/retrospective-trigger-scanner.ts` (sibling: whether a retro FIRES; also the source
of the reused `hasRetrospectiveSkillInvocation` helper) ·
`docs/architecture/adr-031-guidance-detector-lifecycle-event.md` ·
`docs/architecture/adr-024-detection-mechanism-ladder-for-guidance-hooks.md` ·
mem#598 (family root) · mem#826 (R2 handoff) · mt#3602 (tooling sibling) ·
mt#3597 (trigger-corpus gap — whether a retro fires on a confabulation admission).
