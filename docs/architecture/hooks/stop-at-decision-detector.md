# Stop-At-Decision Detector (log-only)

> Extracted from `.minsky/rules/hook-observers.mdc` (mt#3667) — full narration,
> cross-references, and design rationale for this observer. The compiled rule corpus
> carries only a terse index entry; this file is the durable detail.

**Hook file:** `.minsky/hooks/stop-at-decision-scan.ts`
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
- mt#4085 — the 2026-08-13 marker tune (below).
- mt#3536 / `turn-end-unwalked-task-detector.md` — sibling, mint-keyed.
- mt#3179 — sibling, phrase-keyed.
- mt#3583 — the evaluation-stream pattern.
- ADR-031 — the registration policy this deviates from, with the deviation recorded.
- ADR-024 — the detection-mechanism ladder. The mt#4085 tune below is Rung-1 work; see its rung
  reasoning.

## mt#4085 (2026-08-16) — the natural-prose decision handoff

The 2026-08-13 calibration pass classified 11 injected fires: **9 false, 2 uncertain**. Every one of
the nine reached the log the same way — `RECOMMENDATION_MARKERS` is a **suppressor**, and it missed
the way a decision is actually handed over in this corpus.

### What was added, and what was not

Three shapes, each the minimal generalization of a phrase appearing verbatim in a classified record:
possessive-inversion (`yours to set` / `yours to call` — the baseline carried only `your call` and
`decision … is yours`), nominalized framing (`the decision reduces to`, `the choice it has to make`),
and position-stating (`my three positions`).

**Four of the nine were deliberately left firing.** They carry no decision-handoff phrase of any
shape; they narrate the evidence-write itself ("Two corrections recorded", "I've recorded that and
withdrawn the gap"). A marker for that shape would match nearly every turn the detector evaluates,
because an evidence-write IS its trigger condition — the nullification that got two regex candidates
rejected on mt#3861. They are a separate class, recorded rather than silenced, and a test pins the
exclusion so a later widening breaks a test rather than drifting.

### Measured effect

`scripts/replay-stop-at-decision-markers.ts`, over 533 evaluated turns and the 25-record calibration
log:

|                     | before | after |
| ------------------- | ------ | ----- |
| corpus marked       | 44.1%  | 46.5% |
| fire rate           | 4.3%   | 3.4%  |
| window FPs firing   | 9      | 4     |
| uncertain (control) | 2      | 2     |

13 turns newly marked (2.4%). For scale, the widenings mt#3861 rejected marked 96.3% of their corpus.

### The corpus is recovered, and the recovery is validated

The evaluation stream records suppression reasons but **no message text**, so it cannot be re-matched
against a candidate pattern. It does carry `session_id` + `turnKey`, so the judged message is
recovered from the local transcript store — and the recovery is checked against ground truth rather
than trusted: for every fired turn the calibration log stored the last 600 chars of the exact message
the detector judged, and the harness reproduces the detector's recorded verdict on **533/533**
records (`--validate`).

That check earned its place. The first recovery walked forward from `turnKey` and stopped at the
first `user` entry carrying no `tool_result` — but hook injections and system-reminder attachments
arrive as user-typed entries mid-turn, closing the window early and returning an EARLIER assistant
message. It agreed with the detector on only **68.8%** of records while producing a
perfectly plausible-looking percentage. Bounding the window by the record's own fire timestamp fixed
it. A corpus that cannot disagree with the tool measuring it is not evidence.

### Note on the calibration log as a corpus

Records store `final_message_tail` — the last **600 chars** — while the matcher runs on the full
message. Marker matching is existential, so a candidate matching the tail necessarily matches the
full message: sound for confirming a suppression, unsound for confirming a NON-suppression. The two
negative-control records are 232 and 213 chars, i.e. complete, which is what makes them usable as
controls at all.
