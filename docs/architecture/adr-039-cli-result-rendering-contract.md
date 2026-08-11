# ADR-039: CLI result-rendering contract

**The call: a command's result is visible at the CLI by default — the shared fallback renders a payload it has no projection for — and silencing the fallback is DECLARED by the command via `printed`, never inferred from whether output happened to appear.**

## Status

**Proposed** — 2026-08-11. Decided under mt#3870 and mt#3961, both merged and live. Awaiting
principal ratification; the contract sets the CLI rendering default for every command added from
here, which is an architectural move affecting the product surface per `principal-context.mdc
§Decisions Eugene reserves`. The BEHAVIOR shipped with the principal's go-ahead — what is
unratified is elevating it to an accepted record that binds future commands.

## Context

Minsky commands are defined once in the shared registry and adapted to CLI and MCP. On the CLI
side, a command that registers no `outputFormatter` and matches no case in `formatObjectResult`'s
switch reaches a generic fallback, `formatGenericObject`. That is not a rare path. Measured at
mt#3961's merge (`65ff7931c`, 2026-08-11): of 225 registered commands, 23 have a formatter and 13
are switch-cased, so **189 reach the fallback**.

Every count in this ADR is a snapshot at that commit. They are kept because the ORDER OF MAGNITUDE
is what the decision rests on, and they drift with every command added —
`scripts/audit-cli-output-coverage.ts` is the live enumeration and supersedes any figure here.

Until mt#3870 the fallback discarded what it could not project. Given a result carrying `success`
but neither `message` nor `output`, it printed the boolean as `✅ Success` and dropped every other
key. mt#3478 found two commands in that state — `config doctor`, whose nine diagnostics were
computed and thrown away, and `config validate` — and fixed them by registering per-command
formatters. It explicitly declined to change the shared fallback, on the reasoning that doing so
changes output for every command relying on it.

That reasoning was sound given what it could see, and it did not survive the enumeration.
mt#3870 swept the registry and found **39 commands** in the same shape, including `git status`
(which reported only `✅ Success`), `workspace info` (seven fields of workspace state discarded),
and `repo read_file` (the file contents it had just read). **35 of the 39 declare no `--json`
flag**, so for them the fallback was not one output path among several — it was the only one.

Two things follow, and this ADR records both.

**First, "changes output for every command" was true of the BRANCH, not the rendered result.** The
new rendering fires only where output was already a bare boolean; the 150 fallthrough commands
outside the class see no change. Weighed against 39 new registrations that nothing would force the
40th command to join — which is exactly how `config doctor` reached that state after the
per-command mechanism already existed — the shared fix is the one that closes the class.

**Second, and less obvious: suppression cannot be inferred.** mt#3870 also introduced a signal,
`commandEmittedOutput`, derived from a counter of visible CLI output lines read around `execute`.
It answers "did anything print?" mt#3961 set out to reuse it for a second decision — whether to
suppress the status line entirely for a command that had reported for itself — and implementing it
falsified the idea before it shipped. `refs status` prints a table and returns that same table as
its payload, so suppressing is right. `authorship recompute --dry-run` prints one incidental line
("Running in dry-run mode…") and returns a `RecomputeSummary` that is nothing like it; suppressing
would have discarded the entire finding the operator ran the command to get. Both "emitted output".
No counter separates them, because the distinction is about meaning, and only the command holds it.

## Decision

We will treat the CLI result surface as **render-by-default**: `formatGenericObject` prints the
payload keys of any result it has no `message`/`output` projection for, rather than replacing them
with a status line. A per-command `outputFormatter` remains available and is for presentation
QUALITY; it is no longer what stands between a payload and the operator.

We will keep fallback suppression **declared**. A command that has rendered its own complete report
returns `printed: true` and the fallback emits nothing. `commandEmittedOutput` stays scoped to the
one decision it is sound for — whether to re-render payload keys beneath a report the operator has
already read — and is not extended to decide whether anything renders at all.

The dividing principle, which is what a future reader should apply to a new case: **a signal may
drive a decision whose wrong answer is inert, and may not drive one whose wrong answer is silence.**
Guessing wrong about re-rendering leaves a redundant status line. Guessing wrong about rendering at
all prints nothing, which is the defect this contract exists to prevent.

## Consequences

**Easier.** A new command is legible at the CLI with no registration step — return a payload and it
appears. The failure mode that produced mt#3478 and mt#3870 is closed structurally rather than
policed per command: there is no list to join and therefore none to forget. `--json`, which 140 of
225 commands do not declare, stops being load-bearing for basic visibility.

**Harder.** Generic output is unstyled — a `key: value` list, with structured values inline when
short and an indented JSON block when long. A command wanting better must still write a formatter,
and the fallback's adequacy removes some of the pressure to. Payload shape also becomes operator-
visible by default, so a key added for internal use now shows up in the terminal; the
`NON_PAYLOAD_KEYS` set exists for the plumbing cases, and is a place future contributors must
remember to look.

**Committed.** Suppression is per-command work by construction. Each `printed` site must be gated
on the same condition that decides whether the command actually printed — mt#3961 flagged five
commands and gated every one, including `rules compile` on only one of its three returns, because
its other two print conditionally. A future contributor who flags a branch that did not print will
silence that command, and no shared mechanism can catch it for them.

**Follow-ups this implies.** `scripts/audit-cli-output-coverage.ts` is the standing enumeration of
which command takes which output path; consult it rather than any count quoted here, which drifts.
Note also that it enumerates the shared registry, a superset of the CLI surface — six commands in
its `renders-own-report` bucket are not CLI-exposed at all.

## Cross-references

- Related ADRs: ADR-004 (two-phase command execution — governs the `validate()` → `execute()`
  pipeline that produces the result this ADR renders, and says nothing about rendering)
- Related tasks: mt#3478 (the per-command decision this reverses), mt#3870 (the enumeration and the
  shared-fallback change), mt#3961 (the declared-suppression half and the falsified inference),
  mt#3980 (this ADR)
- Source: `src/adapters/shared/bridges/cli/result-formatter.ts` (`formatGenericObject`,
  `formatPayloadKeys`, `ResultRenderOptions`, `SWITCH_HANDLED_COMMAND_IDS`),
  `src/adapters/shared/bridges/cli/command-generator-core.ts` (`handleCommandOutput`, and the
  counter read around `execute`), `packages/shared/src/logger.ts` (the visible-CLI-output line
  counter)
- Enumeration: `scripts/audit-cli-output-coverage.ts`
