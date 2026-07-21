# Retrospective-Trigger Scanner

> Extracted from `.minsky/rules/hook-files.mdc` (mt#2620) — full incident narration,
> cross-references, and worked examples for this hook/guard. The compiled rule corpus
> carries only a terse index entry; this file is the durable detail.

A `UserPromptSubmit` hook that scans the prior assistant turn for
retrospective-trigger phrases (R1–R4 families) and the current user prompt
for user-correction signals, injecting `additionalContext` reminding the
agent to invoke `/retrospective`. This is the structural escalation
(mt#2057) of the retrospective skill's trigger-phrase family after four
recurrences (R1–R4) proved memory-tier and corpus-tier enforcement
insufficient.

**Hook file:** `.claude/hooks/retrospective-trigger-scanner.ts`

**Four trigger families (hardcoded as exported regex constants):**

- **R1 (apology/contrition):** "I owe you an apology", "I should have
  caught", "I was wrong about", "I made a mistake", "I conflated", etc.
- **R2 (operational/explanatory prose):** "I didn't think it through",
  "I went straight to X without checking", etc.
- **R3 (future-behavior commitments):** "going forward I will", "from
  now on I'll", "next time I'll", "I'll be more careful about", etc.
- **R4 (decline-to-retrospective):** "fixing the symptom rather than
  running a retrospective", "one-off issue", "no need for a full
  retrospective", "skip the retrospective", etc.

**Plus user-correction signals** in the current user prompt: "why did
you do that?", "you keep doing this", "that's wrong", "how many times",
etc.

**Plus the method-redirect family (mt#2446):** the user redirecting HOW
the agent should have arrived at an answer — "you should do some
research on the appropriate way to handle this", "did you check how
<tool> does this?", "is there a standard way to do this?", "what's the
canonical way to X" — detected in the CURRENT user prompt, gated on
design/recommendation markers ("Option A", "recommendation", "Plan
decision", "I recommend", "approach:") in the PRIOR assistant turn.
A politely-phrased method redirect after a produced design is a
correction of the agent's _method_ (design-first instead of
research-first), not a neutral new instruction; the negative-valence
user-correction patterns structurally missed it. Without the
design-context condition, an open research question ("should we
research X?") would false-positive. Per ADR-024 this family is a
Rung-1 input: plain regex matched on the elided residual, same
prefilter path as every other family.

**False-positive suppression (mt#3036):** when ANY of the **last 5
completed assistant turns** contains a `Skill` tool call with `skill:
"retrospective"`, the **assistant-side R-family scan is suppressed** —
the agent is already inside a retrospective and the phrases are
legitimate output. The 5-turn window covers multi-turn advisor-based
retrospectives, where the Skill invocation lives in turn N and the
advisor's structured output — required by the skill to carry the
R-family taxonomy vocabulary ("I conflated", "I should have caught",
"Assumption Error") — lands 1-3 turns later. A same-turn-only
suppression missed the invocation and let the output turn's own
taxonomy vocabulary fire the scanner (the tautology mt#3036 fixed).
**User-side scans (user-correction, method-redirect) remain LIVE**
across the whole 5-turn window (PR #2169 R1) — an operator complaint
or method redirect arriving mid- or post-retrospective is not the same
event as the retrospective and must fire, mirroring the mt#2672 policy
that user-correction is never meta-suppressed.

**Defense-in-depth — retro output shape META markers:** structural
headings distinctive to `/retrospective`'s Step 2a output —
`## Retrospective:`, `### Agent error (cognitive)`, `### Recurrence
check`, `### Recurrence-after-DONE`, `**Correction noted**:` — are
treated as detector-meta context and suppress R-family matching
whole-turn (mt#3036, extending mt#2672). This catches the same
tautology when the invocation itself isn't in the visible transcript
window (e.g., a retrospective's structured output cited or re-surfaced
in a new conversation). Generic RCA / design-doc headings like
`### Root cause` and `### Failure mode:` are deliberately NOT in the
META set (PR #2169 R1) — they appear in ordinary specs, ADRs, and
incident memos, and suppressing R-family scanning on that content
would silence real admissions. User-correction and method-redirect
families are not meta-suppressed here either — a user correction
inside a retro-output-shaped turn still fires.

**On match:** the hook emits a `HookOutput` with `additionalContext`
naming each matched phrase, its R-family, and the required action: invoke
`/retrospective` before any other action. The retrospective skill's
Step 0.5 triage determines whether a full retrospective is warranted —
the hook only ensures the agent enters the triage, not that it runs a
full retrospective.

**Calibration logging:** every fire logs a JSONL record to
`.minsky/retrospective-trigger-calibration.jsonl` with timestamp,
session ID, and matched phrases. Review after 10 fires — if >2 are
false positives, tune the patterns.

**Override mechanism:** Set `MINSKY_ACK_RETROSPECTIVE_TRIGGER=1` (or
`true` / `yes`) in your environment to suppress the warning:

```bash
MINSKY_ACK_RETROSPECTIVE_TRIGGER=1 claude
```

The override emits an audit line to stdout naming the env-var value,
session ID, and ISO timestamp. Use only when a trigger phrase is
genuinely not a retrospective case (e.g., documenting trigger phrases
in a rule file, discussing the hook's own patterns).

**Env-var registration:** `MINSKY_ACK_RETROSPECTIVE_TRIGGER` is
registered in `HOOK_ONLY_ENV_VARS` at
`packages/domain/src/configuration/sources/environment.ts` per the
`custom/no-unregistered-minsky-env-var` ESLint rule from mt#1788.

**Originating incidents:**

- **R1 (2026-05-18):** shell-completions library survey — agent wrote
  "I owe you the apology" without invoking `/retrospective`.
- **R2 (2026-05-18):** same session — agent wrote "I didn't think it
  through" without invoking `/retrospective`.
- **R3 (2026-05-21):** cockpit-context-inspector session — agent wrote
  "going forward I will" without encoding the commitment durably.
- **R4 (2026-05-23, PR #1234 / mt#2053):** agent wrote "fixing the
  symptom rather than running another retrospective" — explicitly
  declining the retrospective trigger.
- **Method-redirect (2026-06-11, mt#2439):** agent gate-passed a
  first-principles migration-baseline design to READY; the user said
  "I think you should do some research on the appropriate way to
  handle this using drizzle"; research surfaced the vendor-canonical
  `drizzle-kit pull --init` pattern the design had reinvented by luck.
  The redirect matched no negative-valence pattern, no retrospective
  triage fired, and the user had to request the retro explicitly —
  a two-level miss (mt#2446 closes the detection gap).
- **Multi-turn tautology (2026-07-21, mt#3036):** a full
  `/retrospective` was invoked and dispatched an advisor subagent; the
  advisor's structured output — containing the required Step 2a
  taxonomy vocabulary ("I conflated", "Assumption Error") — landed
  1-2 turns AFTER the Skill invocation. The same-turn-only suppression
  saw only the output turn (no `Skill` call in it) and fired the
  scanner on the retrospective's OWN required output vocabulary,
  demanding another retrospective for the one just completed. Fix:
  widen the invocation check to the last 5 completed turns + add
  retro-output-shape META markers as defense-in-depth.

**Cross-references:**

- `feedback_self_recognized_failure_is_retrospective_trigger` (id
  `1b36a19e`) — R1 family root memory (bridge; retires when this
  hook ships).
- `feedback_decline_to_retrospective_is_itself_a_trigger` (id
  `13ccf86e`) — R4 memory (bridge; retires when this hook ships).
- `.claude/skills/retrospective/SKILL.md` §When to invoke — the
  canonical trigger list this hook mechanizes.
- `.claude/hooks/substrate-bypass-detector.ts` — sibling
  UserPromptSubmit hook (mt#2020) with the same architecture.
- mt#1788 — ESLint rule + `HOOK_ONLY_ENV_VARS` (env-var registration).
- mt#2652 — this guard's process-dispatch mechanism migrated onto the
  ADR-028 guard dispatcher (Phase 2a); detection logic unchanged — see
  `docs/architecture/hooks/guard-dispatcher-framework.md` and
  `docs/architecture/adr-028-guard-hook-dispatcher-consolidation.md`.
- mt#2446 — method-redirect user-correction family (design-context-gated
  user-prompt patterns); ADR-024 Rung-1 input, coverage-receipt gate
  (mt#2554) applies to its live fires.
