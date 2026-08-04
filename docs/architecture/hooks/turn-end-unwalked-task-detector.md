# Turn-End Unwalked-Task Detector

> Extracted from `.minsky/rules/hook-observers.mdc` (mt#3667) — full narration,
> cross-references, and design rationale for this observer. The compiled rule corpus
> carries only a terse index entry; this file is the durable detail.

**Hook file:** `.minsky/hooks/turn-end-unwalked-task-detector.ts`
**Event:** `Stop`
**Override:** `MINSKY_ACK_UNWALKED_TASK`

## What it detects

A `Stop`-event scan (mt#3536): the turn **minted a task id** — a `tasks_create` whose result
confirms both `success` and a `taskId` — and then ended with **no** `tasks_status_set` /
`session_start` / `tasks_dispatch` / `asks_create` naming it.

Filing a task is not the deliverable. This catches the turn that files one and walks away.

## It keys on tool-call state, not on wording

That is the design decision worth preserving. The R4 stop that motivated it named **no next
action at all**, so the phrase-keyed sibling (`turn-end-untaken-action`, mt#3179) correctly
stayed silent — there was no phrase to match. The SILENT stop is precisely the gap this closes,
and only a state-keyed predicate can see it.

Dedups per task id.

## Family history: two prose fixes that both failed

R4 of `family:stop-at-handoff`. Two earlier fixes for the same family were shipped as prose, both
went DONE, and neither contained it:

- **mt#1478** — the auto-mode skill-chaining rule text.
- **mt#2689** — a fix that lived in `/create-task`'s exit step, and was bypassed simply by
  calling `tasks_create` directly rather than going through the skill.

mt#2689's failure mode is the instructive one: a guard placed inside one invocation path only
covers that path. Moving enforcement to the `Stop` event made it path-independent.

## Cross-references

- mt#3536 — this detector.
- mt#3179 / `turn-end-untaken-action` — phrase-keyed sibling.
- mt#3653 / `stop-at-decision-detector.md` — R4's successor signature, covering the turn that
  mints nothing AND says nothing.
- mt#1478, mt#2689 — the two prose fixes that preceded it.
