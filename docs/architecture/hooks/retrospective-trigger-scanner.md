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

**False-positive suppression:** when the prior assistant turn contains a
`Skill` tool call with `skill: "retrospective"`, ALL trigger-phrase
detections are suppressed — the agent is already inside a retrospective
and the phrases are legitimate output.

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
  "Guard-Dispatcher Framework (ADR-028 Phase 1–2a)" above.
