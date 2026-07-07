# Substrate-Bypass Detector

> Extracted from `.minsky/rules/hook-files.mdc` (mt#2620) — full incident narration,
> cross-references, and worked examples for this hook/guard. The compiled rule corpus
> carries only a terse index entry; this file is the durable detail.

A `UserPromptSubmit` hook that inspects the most-recent assistant turn in
the session transcript and detects when the agent bypassed a canonical
Minsky substrate (DB tables, skills, MCP tools, file-edit tools) in favor
of an ad-hoc inline path. On match, the hook injects an `additionalContext`
reminder naming each matched surface, the matched phrase, and the
canonical substrate the agent should have used. This is the structural
escalation (mt#2020) of the substrate-bypass pattern documented in
memory `f6607043-be47-43e6-baec-47dbe40221c4` after five recurrences
(R1-R5) across recommendation-time and action-execution-time surfaces
confirmed memory-tier + corpus-rule-tier enforcement was insufficient.

**Hook file:** `.claude/hooks/substrate-bypass-detector.ts`

**Three trigger surfaces** (each exported as a separate pure detector
function for testability):

1. **Verbal-commitment detection.** Regex-matches first-person
   future-action phrases (`I'd update X`, `I'll save Y`, `going forward
I'll Z`, `next session I'll W`, `I should file X`, etc.) in the
   assistant text. Match fires ONLY when no corresponding tool_use line
   in the same turn invokes one of the execution tools:
   `mcp__minsky__memory_create`, `mcp__minsky__memory_update`,
   `mcp__minsky__tasks_create`, `Edit`, `Write`,
   `mcp__minsky__session_edit_file`, `mcp__minsky__session_write_file`,
   `mcp__minsky__session_search_replace`. The verbal commitment
   evaporates at end-of-turn unless the encoding tool is called same-turn.

2. **Skill-bypass detection.** Heuristic match on inline retrospective
   shape: assistant text contains 2+ section-heading markers
   (`Acknowledgment`, `Categorization`, `Root cause` / `Root Cause`,
   `Fixes`, `Retrospective:`) in the same turn. Match fires ONLY when no
   tool_use line in the same turn invokes the `Skill` tool with
   `skill: "retrospective"`. The inline retrospective shape bypasses
   the canonical `/retrospective` skill which enforces Step 0 (premise
   validation), Step 0.5 (triage), and Step 3 (recurrence check).

3. **DB-substrate bypass detection.** Substring match on phrases
   (`v1 reads JSONL`, `read JSONL directly`, `extend the DB later`,
   `DB doesn't have`, `DB is incompatible`) combined with proximity-match
   (same paragraph, ≤300 chars) to the word `transcript`. Targets the
   specific bypass pattern from R3 (cockpit-context-inspector spec
   session, 2026-05-21) where the agent framed an incomplete DB substrate
   as "incompatible" and routed around it by reading on-disk JSONL
   directly instead of extending `agent_transcripts` /
   `agent_transcript_turns`.

**Detection scope.** The hook inspects the just-completed logical turn —
the span between the last two REAL user prompts, via the shared
`.claude/hooks/transcript.ts` helper (mt#2255). Because Claude Code records
`tool_result` blocks as user-role lines, the helper bounds the turn on real
prompts (text content) rather than every user-role line, so a turn spanning
several tool round-trips is NOT split at each `tool_result`. First-turn-of-session
(no prior real prompt) is silent. This shared helper is the single definition
of the turn-boundary logic for all three UserPromptSubmit detector hooks
(substrate-bypass, retrospective-trigger, pre-narration).

**On match:** the hook emits a `HookOutput` with
`hookSpecificOutput.hookEventName: "UserPromptSubmit"` and
`additionalContext` containing the matched surfaces (truncated phrases +
canonical substrate), the required next action (call the bypassed
canonical substrate NOW — not describe it, not defer it), and the
override mechanism.

**Override mechanism:** Set `MINSKY_ACK_SUBSTRATE_BYPASS=1` (or
`true`/`yes`) in your environment before the user prompt to suppress the
warning. The override emits an audit line to stdout naming the env-var
value, session ID, and ISO timestamp:

```bash
MINSKY_ACK_SUBSTRATE_BYPASS=1 claude
```

The audit line is not valid JSON, so Claude Code's hook-output parser
won't interpret it as a HookOutput envelope. This matches the
sibling-hook audit convention in `parallel-work-guard.ts` and
`check-branch-fresh.ts`. Use only when the bypass is intentional and
acknowledged.

**Env-var registration:** `MINSKY_ACK_SUBSTRATE_BYPASS` is registered in
`HOOK_ONLY_ENV_VARS` at `packages/domain/src/configuration/sources/environment.ts`
so the env-var-to-config dot-path parser skips it at boot (per the
`custom/no-unregistered-minsky-env-var` ESLint rule from mt#1788). The
override env-var name's source of truth lives in
`.claude/hooks/substrate-bypass-detector.ts` as the exported constant
`OVERRIDE_ENV_VAR` so the hook, tests, and rule documentation cannot
drift.

**Fail-open posture:** any error reading the transcript, parsing JSONL
lines, or running detection exits 0 with a `console.error` warning.
The hook never blocks the user prompt — it is informational only.
Empty or missing `transcript_path` (typical of the first turn of a
session) also exits silently.

**Originating incidents (R1-R5):**

- **R1-R2 (2026-05-12, PR #1073 / mt#1783):** memory-search hook tune
  session. User had explicitly sequenced "implement observability tool
  FIRST, use hook tuning as its first test case" then said "do it now."
  Agent compressed to in-house data extraction (grep + jq over
  `/tmp/<hook>.log`) and skipped the SaaS evaluation step entirely —
  build-path-as-research at action-execution time.
- **R3 (2026-05-21, cockpit-context-inspector spec session):**
  canonical-substrate bypass at v1/scope-defining time. Drafting the
  cockpit-context-inspector spec, the existing transcripts-DB substrate
  (mt#1313/mt#1324: `agent_transcripts`, `agent_transcript_turns`) was
  missing attachment-line retention. Agent framed this as "DB
  incompatible with v1 use case → route around by reading JSONL
  directly." Accurate framing: "DB incomplete for v1 use case → extend
  the canonical substrate."
- **R4 (same session):** canonical-skill bypass at process-failure time.
  User explicitly asked for a retrospective; agent wrote one inline using
  the structural shape from the `/retrospective` skill rather than
  invoking the skill — bypassing Step 0 premise validation, Step 0.5
  triage, and Step 3 recurrence check.
- **R5 (same session):** canonical-tool bypass at durable-artifact time.
  In the inline retrospective, agent wrote "I'd update memory X" and
  asked the user "Want me to add that update?" — both deferrals; no
  `memory_update` call was made. Verbal commitment evaporated at
  end-of-turn.

**Tracking task:** mt#2020. **Originating memory:**
`f6607043-be47-43e6-baec-47dbe40221c4`
(`feedback_build_path_as_research_at_action_time` — R3-R5 extension).

**Cross-references:**

- `decision-defaults.mdc §Build vs buy` — corpus rule the hook escalates
  from (R2 corpus extension landed 2026-05-12; this hook is the
  hook-tier escalation per the `/retrospective` skill's repeated-failure
  rule after R3-R5 confirmed the corpus tier was insufficient).
- `feedback_build_path_as_research_at_action_time` (id `f6607043`) —
  originating memory documenting R1-R5; updated to cite mt#2020 as the
  structural escalation target.
- `feedback_build_vs_buy_default_for_non_core` — R1 recommendation-time
  slice of the same pattern family.
- `/declare-framework` (mt#1789) — sibling skill enforcing framework
  selection at recommendation time (this hook is the action-time
  complement).
- mt#1788 — ESLint rule + `HOOK_ONLY_ENV_VARS` (env-var registration
  contract this hook's override env-var conforms to).
- mt#1622 — `skill-staleness-detector.ts` (sibling UserPromptSubmit
  hook with the same context-injection shape).
- mt#2652 — this guard's process-dispatch mechanism migrated onto the
  ADR-028 guard dispatcher (Phase 2a); its own detection logic (the four
  detector functions above) is unchanged — see "Guard-Dispatcher Framework
  (ADR-028 Phase 1–2a)" above.
