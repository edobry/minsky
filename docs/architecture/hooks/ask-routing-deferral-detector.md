# Ask-Routing Deferral Detector (calibration)

> Extracted from `.minsky/rules/hook-files.mdc` (mt#2620) — full incident narration,
> cross-references, and worked examples for this hook/guard. The compiled rule corpus
> carries only a terse index entry; this file is the durable detail.

A `UserPromptSubmit` hook that scans the prior assistant turn for **decision
deferrals routed to the principal via chat prose** instead of through the Ask
substrate. In **v1 / calibration mode** it logs matches to a JSONL file and
injects **nothing** — the injection gate (`INJECTION_ENABLED`) is `false`.
After ~10 fires, review the FP rate (via the `calibration-review` skill); only
then flip the flag. Same rollout pattern as the causal-premise detector
(mt#2216) and retrospective-trigger scanner (mt#2057).

> **Correction (2026-07-15, mt#2835).** The paragraph above describes the
> original v1 calibration-only rollout and is now stale: `INJECTION_ENABLED`
> flipped to `true` in code on 2026-07-08 (mt#2694), after the calibration
> data confirmed an acceptable FP rate. That flip alone did not make the
> detector live, though — it shipped into the same ADR-028 Phase 2b migration
> whose `auto-session-title.ts` guard had an ungated module-level `main()`
> that killed the entire `dispatch-userpromptsubmit.ts` process (all 15
> UserPromptSubmit guards, this one included) before any guard's output was
> written, for the detector's whole "live" life to date. mt#2835 is the fix
> that actually makes the mt#2694 flip take effect in production — see that
> task for the root-cause writeup.

**Hook file:** `.claude/hooks/ask-routing-deferral-detector.ts`

**Two sub-classes:**

- **PRINCIPAL-RESERVED** — phrases handing a decision to the principal in prose
  ("needs your call", "that decision is his", "you decide", "reserved for
  Eugene", "waiting on your decision", "surface to you"). The fix the reminder
  names: package per `humility.mdc §Escalation packaging` and file via
  `mcp__minsky__asks_create` (kind `direction.decide`) — or cite an existing
  open ask id.
- **DEFERRAL-MENU** — option-menus / "do nothing" recommendations / hand-back
  shapes ("what's your call?", "say the word", "stop here" as a recommendation,
  "want me to X or Y?"). The fix: route through `/classify-before-deferring`
  FIRST (Class A → run the lookup now; Class B → apply the standing default;
  only Class C → asks_create). NOT unconditionally an ask.

**Suppression:** fires only when the same assistant turn contains **no**
`mcp__minsky__asks_create` tool_use (the agent already routed the decision).
Quoted/code/blockquote contexts are elided before scanning (offset-preserving),
so a phrase the agent is DESCRIBING — e.g. documenting this detector — does not
fire.

**Calibration JSONL:** `.minsky/ask-routing-deferral-calibration.jsonl` — each
record carries `timestamp`, `session_id`, `injection_enabled`, and `matches[]`
(`{class, phrase}`).

**Originating incidents (escalation-packaging family, memory `3e3f29d8`):**
R1 2026-04-26 (mt#1316 A/B/C labels), R2 2026-06-02 (mt#2249 buried decision +
AskUserQuestion instead of asks_create), R3 2026-06-09 (mt#2374 `/plan-task`
closeout, rail-axis by pointer), R4 2026-06-12 (end-of-session summary, same
rail-axis question, no ask). Plus the post-closeout register-shift sub-class
(memory `6abe89c6`, 2026-06-11 mt#2394 closeout). 0-for-4 unprompted compliance
at the behavioral-checklist tier drove the hook-tier escalation.

**Override mechanism:** Set `MINSKY_ACK_ASK_ROUTING_DEFERRAL=1` (or `true` /
`yes`) to suppress detection and emit an audit line to stdout (non-JSON per
sibling-hook convention).

**Env-var registration:** `MINSKY_ACK_ASK_ROUTING_DEFERRAL` is registered in
`HOOK_ONLY_ENV_VARS` at
`packages/domain/src/configuration/sources/environment.ts` per the
`custom/no-unregistered-minsky-env-var` ESLint rule (mt#1788). The override
env-var name's source of truth lives in the hook file as the exported constant
`OVERRIDE_ENV_VAR`.

**Skill-step tier (paired with this hook):** `/plan-task` Step 4 closeout and
`/handoff` Step 5 both carry an "ask-or-cite-ask" requirement — a principal-gated
dependency/next-step must be filed (or an existing ask cited), not referenced by
pointer. The hook is the always-on detector; the skill-steps are the in-chain
enforcement at the two closeout surfaces where R3/R4 occurred.

**Fail-open posture:** any error reading the transcript or running detection
exits 0. The hook never blocks the user prompt.

**Cross-references:**

- mt#2471 — this hook's tracking task
- Memory `3e3f29d8` — escalation-packaging family (R1–R4); names mt#2471 as
  the live structural target
- Memory `6abe89c6` — post-closeout register-shift sub-class (the deferral-menu
  phrase class)
- `.claude/skills/classify-before-deferring/SKILL.md` — the substrate the
  deferral-menu reminder routes through
- `.claude/hooks/causal-premise-detector.ts` / `retrospective-trigger-scanner.ts`
  — sibling calibration-first UserPromptSubmit detectors
- mt#2263 — future consolidation of the regex-scanner family into a unified
  (possibly embedding-based) matcher; adopted at the process/scaffold layer by
  mt#2652 (each detector's own regex matcher remains separate — only the
  process/override/calibration scaffolding unified)
- mt#1788 — ESLint rule + `HOOK_ONLY_ENV_VARS` (env-var registration contract)
- mt#2652 — this guard's process-dispatch mechanism migrated onto the
  ADR-028 guard dispatcher (Phase 2a); detection logic and the
  `INJECTION_ENABLED` calibration-first gate are unchanged — see
  "Guard-Dispatcher Framework (ADR-028 Phase 1–2a)" above.
