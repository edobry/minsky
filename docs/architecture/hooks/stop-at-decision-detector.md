# Stop-At-Decision Detector (log-only)

> Extracted from `.minsky/rules/hook-observers.mdc` (mt#3667) — full narration,
> cross-references, and design rationale for this observer. The compiled rule corpus
> carries only a terse index entry; this file is the durable detail.

**Hook file:** `.minsky/hooks/stop-at-decision-detector.ts`
**Event:** `Stop`
**Status:** LOG-ONLY — never injects
**Override:** `MINSKY_SKIP_STOP_AT_DECISION`

## What it detects

The fourth signature in `family:stop-at-handoff` (mt#3653). It fires when:

- the turn's substantive mutations are **evidence-writes** — `tasks_spec_patch` into a task that
  is not the bound task and is in TODO or PLANNING; AND
- the turn ends with **no** `asks_create` / `tasks_status_set` / `tasks_dispatch` /
  `tasks_create` / `Skill` call; AND
- there is no recommendation marker in the final message.

That is the **silent stop at a ripe decision**: the agent did the investigation, wrote the
evidence down, and then neither minted anything nor said anything.

## Why the existing siblings were blind to it

- `turn-end-unwalked-task` (mt#3536) keys on a task id having been MINTED. This turn mints
  nothing — it patches an existing spec — so that detector correctly stays silent.
- `turn-end-untaken-action` (mt#3179) keys on a PHRASE naming a next action. This turn names no
  next action at all, so that detector correctly stays silent too.

Each sibling is right on its own terms; the turn falls through the gap between them. That gap is
this detector's entire subject.

## Mechanics

Never injects. Writes `stop-at-decision` calibration records plus an evaluation stream (the
mt#3583 pattern — every evaluated turn, fired or not, so the corpus can answer "did it stop
happening?" and not only "did it happen again?"). Dedups per `(turn, target-task)`. Status reads
fail open, so an unavailable task backend cannot suppress detection silently.

## A recorded ADR-031 deviation

ADR-031 routes tool-inspecting detectors to `UserPromptSubmit`, where the transcript is maximally
flushed. This one registers at `Stop` instead, deliberately: the core case is the **walked-away
final turn**, which by definition has no subsequent `UserPromptSubmit` to run on. Registering it
per the ADR would make it blind to exactly the case it exists for.

Full rationale: the guard header and mt#3653's Planning Audit.

## Cross-references

- mt#3653 — this detector.
- mt#3536 / `turn-end-unwalked-task-detector.md` — sibling, mint-keyed.
- mt#3179 — sibling, phrase-keyed.
- mt#3583 — the evaluation-stream pattern.
- ADR-031 — the registration policy this deviates from, with the deviation recorded.
