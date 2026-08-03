# turn-end-unwalked-task-scan

Non-blocking `Stop` observer. Fires when a turn mints a task id and ends without making any
call that moves that task forward.

**Override:** `MINSKY_ACK_UNWALKED_TASK=1`

## What it detects

Within the just-completed turn:

1. A `mcp__minsky__tasks_create` call whose correlated `tool_result` reports `success: true` and
   carries a `taskId`.
2. No `tasks_status_set` / `session_start` / `tasks_dispatch` / `asks_create` in the same turn
   naming that id.

Both halves come from tool-call state read out of the transcript. Nothing about the message text
is consulted.

## Why it is not the untaken-action guard

`turn-end-untaken-action-scan` (mt#3179) keys on the **surface phrase** in
`last_assistant_message` — a turn that _names_ a next action and doesn't take it. That is the
loud shape, and its position argument is sound: at `Stop` time anything in the final message had
no tool call after it by construction.

The originating incident here was the quiet shape. The agent diagnosed a live operator-reported
problem, filed mt#3534 with a full spec, and ended the turn **naming no next action at all**.
There was no phrase, so the phrase-keyed guard had nothing to match and correctly stayed silent.

The two are siblings, not duplicates, and they should not be merged: one keys on message text,
one on tool-call state. Folding them together would reintroduce exactly the phrase-dependence
this guard exists to escape. `mem#799` records the announced-but-untaken shape; this is its
unspoken twin.

## Why a hook, and not more prose

Fourth recurrence of the `stop-at-handoff` family:

| R     | Date       | Surface                    | Fix                                         | Held? |
| ----- | ---------- | -------------------------- | ------------------------------------------- | ----- |
| R1    | 2026-05-11 | `/plan-task` hand-offs     | mt#1478 — CLAUDE.md rule + Step 4 amendment | no    |
| R2/R3 | 2026-07-08 | `/create-task` exit        | mt#2689 — SKILL.md §5 amendment             | no    |
| R4    | 2026-08-01 | direct `tasks_create` call | this guard                                  | —     |

mt#2689 went DONE the same day it was filed and the pattern recurred 24 days later. Its
enforcement lives inside `/create-task`'s exit step, so it only fires when the agent routes
_through the skill_; R4 called `mcp__minsky__tasks_create` directly and routed around it.

The generalizable lesson, and the reason this is hook-tier: **a fix scoped to a skill's exit step
is only as strong as that skill's invocation rate.** When the wrapped tool is directly callable,
the enforcement belongs on the tool boundary, not in the wrapper's prose.

`mem#610`'s own escalation budget named this mechanism on 2026-07-08 — "PostToolUse detector on
tasks_create followed by turn-end without session_start". It was never built, because the budget's
clock was keyed on mt#2689 being TODO and mt#2689 went DONE immediately. A budget keyed on task
STATUS silently retires when the weaker fix ships.

## Legitimate non-fires

- The `tasks_create` errored — nothing was minted, so there is nothing to walk.
- The turn walked the task via any of the four tools.
- The turn filed an ask against the task: routing a principal-owned decision through the Ask
  substrate _is_ the legitimate halt (`/plan-task` Step 4's ask-or-cite-ask closeout).

## Legitimate fires the agent should answer in one line

A background or tracking task filed for later by design is a real case, and the guard cannot tell
it apart from an incident-response task — intent is not in the tool call. The advisory therefore
makes that a one-line answer rather than a fight. Same for: the principal deferred it, it needs
decomposition, or a parallel-work probe shows another actor holds it.

## Known limits

**Transcript lag.** Claude Code's hooks reference states that `transcript_path` "is written
asynchronously and may lag the in-memory conversation." If the minting call has not been flushed
when `Stop` fires, this guard sees nothing and stays silent — a false negative, and the same
silently-dead class as mt#3019 / mt#3046. It is not masked: the guard writes a `live` calibration
record on every fire, so a guard that stops firing is visible to the coverage-receipt check
(`scripts/check-coverage-receipts.ts`) rather than quietly dead. Conversely, a walk call sitting
only in an unflushed tail produces one redundant reminder, bounded by the per-task dedup.

**Cross-turn walks.** A turn that files a task and walks it in the _next_ turn fires once here.
That is intended — the chain-walk default is same-turn — but it means a deliberate two-turn split
costs one advisory beat.

## Cross-references

- `.minsky/hooks/turn-end-untaken-action-scan.ts` — phrase-keyed sibling (mt#3179)
- `.minsky/hooks/turn-end-retro-scan.ts` — the other `Stop` guard, same shape
- `mem#610` — the family record (R1–R4); `mem#799` — the announced-but-untaken sibling
- mt#3536 — this guard; mt#1478 / mt#2689 — the two prose fixes that did not hold
