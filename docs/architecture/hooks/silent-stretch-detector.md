# Silent-Stretch Detector (calibration)

> Extracted from `.minsky/rules/hook-files.mdc` (mt#2620) — full incident narration,
> cross-references, and worked examples for this hook/guard. The compiled rule corpus
> carries only a terse index entry; this file is the durable detail.

A `UserPromptSubmit` hook that measures the just-completed conversation turn
for a **silent tool-only stretch** — a run of tool calls with no
user-visible assistant TEXT in between — and flags it when the stretch
crossed a cadence threshold without a heartbeat ever firing. In **v1 /
calibration mode** it logs matches to a JSONL file and injects **nothing** —
the injection gate (`INJECTION_ENABLED`) is `false`. This is the same
rollout pattern as `causal-premise-detector.ts` and
`retrospective-trigger-scanner.ts` (mt#2263 detector ladder / ADR-024:
calibrate before injecting).

**Hook file:** `.minsky/hooks/silent-stretch-detector.ts` — this is the AUTHORITATIVE source;
compiled to `.claude/hooks/silent-stretch-detector.ts` per the mt#2304 hooks-compile pipeline
(see `hook-files.mdc`'s Recompile rule — `.claude/hooks/*` is generated, never hand-edited).

## Why this exists

Long tool-only stretches emit zero user-visible text, and the operator
cannot distinguish "working" from "hung." Two separate conversations ended
with the operator interrupting healthy, in-flight tool calls because there
had been no visible progress for too long:

- Conversation `a9c1a09b` (24 minutes of silence): _"I think you ran into
  the harness bug again. Maybe you're making progress. I can't see it
  because there's been no UI updates in 24 minutes."_ The operator then
  interrupted two in-flight tool calls on healthy work.
- Conversation `ac4f5675` (28 minutes of silence): the same complaint,
  recurring.

Each false interrupt costs operator attention and breaks agent flow. The fix
is two-layered:

1. **Discipline layer** (`user-preferences.mdc §Progress heartbeats during
tool-only stretches`) — a rule requiring the agent to narrate progress at
   least every 10 minutes or 15 tool calls, whichever comes first.
2. **Detection layer** (this hook) — calibration-first measurement of how
   often the discipline layer is actually followed, to eventually enable an
   automated reminder.

## Cadence (pinned at planning, 2026-07-15)

A silent stretch is flagged when EITHER threshold is crossed, whichever
comes first:

- **10 minutes** of wall-clock silence since the last assistant TEXT output, OR
- **15 consecutive tool calls** with no assistant TEXT output in between.

Grounding: the two originating interrupts landed at 24 and 28 minutes of
silence, so this cadence yields at least two heartbeats before either
historical interrupt point. [`RFC: Communication
altitude`](https://www.notion.so/39e937f03cb481febdeae249014e356f) (Draft)
independently targets a ~10-minute heartbeat floor, which this cadence
matches.

## Measurement

The detector walks the just-completed turn (`extractLastAssistantTurn` from
`.minsky/hooks/transcript.ts`) line by line, tracking:

- The timestamp of the most recent assistant **TEXT** line (a line resets
  the tool-call counter to 0 when it carries non-empty text — mirroring the
  discipline-layer rule that narrating resets the silent-stretch clock).
- The count of `tool_use` blocks emitted **since** that line (or since the
  start of the turn, if the turn contains no text at all).

`gapMinutes` is the wall-clock distance between the last TEXT line's
timestamp (or the turn's start, i.e. the previous real prompt, if no TEXT
occurred) and the CURRENT real prompt's timestamp — i.e. the prompt that
just fired this hook. In the originating-incident shape, that current
prompt IS the operator's interrupt, so `gapMinutes` directly measures how
long the operator stared at nothing before giving up and typing.

**Why not a naive `role === "user"` scan.** Claude Code records
`tool_result` blocks as USER-ROLE transcript lines. A naive scan keyed on
role would misclassify tool-result rows as human silence-breakers and
undercount the stretch — this is the same hazard `extractLastAssistantTurn`
was built to avoid (mt#2255), and the reason this detector reuses that
shared helper (plus `extractAssistantText`/`extractToolUseNames`,
per-line) rather than re-implementing transcript parsing. Skill-invocation
bodies also register as user-role text in the transcript, which the shared
real-prompt discriminator (`isRealUserPrompt`) already accounts for.

## Calibration JSONL

`.minsky/silent-stretch-calibration.jsonl` — each match record contains:
`timestamp`, `session_id`, `gapMinutes` (rounded to 2 decimals),
`toolCallCount`, and `hadTextInTurn` (boolean — whether the turn had ANY
assistant text at all, even if not enough to avoid the threshold).

## Override mechanism

Set `MINSKY_SKIP_SILENT_STRETCH=1` (or `true` / `yes`) to suppress detection
and emit an audit line to stdout (non-JSON, per sibling hook convention).
The shared ADR-028 `MINSKY_HOOK_OVERRIDE=silent-stretch-detector` channel
also works, since this guard is `GUARD_REGISTRY`-registered.

**Env-var registration:** `MINSKY_SKIP_SILENT_STRETCH` is registered in
`HOOK_ONLY_ENV_VARS` at
`packages/domain/src/configuration/sources/environment.ts` per the
`eslint-rules/no-unregistered-minsky-env-var.js` lint rule (mt#1788) — the
name the code comment above `HOOK_ONLY_ENV_VARS` itself uses ("Exported so
the lint rule `eslint-rules/no-unregistered-minsky-env-var.js` (mt#1788)
can grep this file for the canonical allowlist"). The override env-var
name's source of truth lives in the hook file as the exported constant
`OVERRIDE_ENV_VAR`.

## Fail-open posture

Any error reading the transcript or running measurement exits/returns `null`
(silent allow) with a `console.error`/`process.stderr.write` warning. The
hook never blocks the user prompt — this is a calibration-only guard,
`denyCapable: false`.

## Cross-references

- mt#2824 — this hook's tracking task
- `.minsky/rules/user-preferences.mdc §Progress heartbeats during tool-only
stretches` — the discipline-layer sibling this hook calibrates
- `.claude/hooks/inject-dispatch-watchdog.ts` — sibling silence detector on
  the SUBAGENT side (covers a dispatched subagent's silence from the
  dispatching agent's perspective); this hook covers the MAIN agent's own
  silence
- `.claude/hooks/causal-premise-detector.ts` /
  `.claude/hooks/retrospective-trigger-scanner.ts` — sibling calibration-first
  detectors this hook's rollout pattern mirrors
- mt#2263 — detector ladder (calibrate before injecting)
- mt#2637 — `ctx.transcriptLines` / `needsTranscript` wiring this hook
  consumes
- mt#1788 — ESLint rule + `HOOK_ONLY_ENV_VARS` (env-var registration contract)
- [`RFC: Communication altitude`](https://www.notion.so/39e937f03cb481febdeae249014e356f)
  (Notion, Draft) — the strategic frame this hook's detector half implements
  (heartbeat floor, Phase 1; silent-stretch detection, Phase 3)
- ADR-028 — guard-dispatcher framework this hook is registered onto directly
  (authored on the framework, not migrated from a prior standalone hook)
