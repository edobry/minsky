# Causal-Premise Detector (calibration)

> Extracted from `.minsky/rules/hook-files.mdc` (mt#2620) — full incident narration,
> cross-references, and worked examples for this hook/guard. The compiled rule corpus
> carries only a terse index entry; this file is the durable detail.

A `UserPromptSubmit` hook that scans the prior assistant turn for volunteered
causal/mechanism claims about tool or system behavior that lack same-turn
verification. In **v1 / calibration mode** it logs matches to a JSONL file
and injects **nothing** — the injection gate (`INJECTION_ENABLED`) is `false`.
After ~10 fires, review the FP rate; only then flip the flag to enable
`additionalContext` injection. This is the same rollout pattern as
`mt#2057` (retrospective-trigger-scanner).

**Hook file:** `.claude/hooks/causal-premise-detector.ts`

**Detector contract:**

- **Fires on** a volunteered causal/mechanism claim about TOOL/SYSTEM behavior:
  - Retrodictive: "X behaved this way **because** Y", "the reason is Y",
    "X blocks/causes Y" — where Y invokes a structural mechanism (identity /
    permission / config / algorithm / data-shape).
  - Forward: "running X will do Y", "X is unsafe because Z".
  - AND the same turn contains **no** backing tool call AND **no** `file:line`
    or `node_modules/…` citation.
- **Does NOT fire** when the claim is immediately backed by a same-turn tool
  result or a cited source.

**Calibration JSONL:** `.minsky/causal-premise-calibration.jsonl` — each
match record contains: `timestamp`, `session_id`, `matchedPhrases[]`, and
`hadSameTurnVerification` (boolean). Review after ~10 fires to determine the
FP rate before enabling injection.

**Originating incidents:** R1–R5 documented in memory `3772c77d`:

- R1 (2026-04-24, mt#994): git error misattributed to missing `-u` flag; real cause was detached HEAD.
- R2 (2026-05-31, mt#2045): `#`-in-branch-got-mangled story; real cause was unprefixed filter + hyphens.
- R3 (2026-05-31): "reviewer shares author identity so APPROVE blocked" — false; distinct bot ids.
- R4 (2026-06-02, mt#2250): fabricated out-of-band migration event; real cause was edited-after-apply migrations.
- R5 (2026-06-03, mt#2250): forward predictive claim — `migrate --execute` "unsafe" based on unread drizzle mechanism.

**Companion skill:** `.claude/skills/check-premise/SKILL.md` — agent-invoked
step: "list the premises this claim rests on; check the cheapest falsifier
first."

**Override mechanism:** Set `MINSKY_ACK_CAUSAL_PREMISE=1` (or `true` / `yes`)
to suppress detection and emit an audit line to stdout (non-JSON per sibling
hook convention).

**Env-var registration:** `MINSKY_ACK_CAUSAL_PREMISE` is registered in
`HOOK_ONLY_ENV_VARS` at
`packages/domain/src/configuration/sources/environment.ts` per the
`custom/no-unregistered-minsky-env-var` ESLint rule (mt#1788). The override
env-var name's source of truth lives in the hook file as the exported constant
`OVERRIDE_ENV_VAR`.

**Fail-open posture:** any error reading the transcript or running detection
exits 0 with a `console.error` warning. The hook never blocks the user prompt.

**Cross-references:**

- mt#2216 — this hook's tracking task
- Memory `3772c77d` — "Verify the premises of a causal explanation before
  asserting it" — R1–R5 incident log + escalation trigger
- `.claude/hooks/substrate-bypass-detector.ts` — sibling UserPromptSubmit
  hook (mt#2020) with the same architecture
- `.claude/hooks/retrospective-trigger-scanner.ts` — sibling hook (mt#2057);
  calibration-first rollout pattern this hook mirrors
- mt#1788 — ESLint rule + `HOOK_ONLY_ENV_VARS` (env-var registration contract)
- mt#2652 — this guard's process-dispatch mechanism migrated onto the
  ADR-028 guard dispatcher (Phase 2a); detection logic and the
  `INJECTION_ENABLED` calibration-first gate are unchanged — see
  "Guard-Dispatcher Framework (ADR-028 Phase 1–2a)" above.
