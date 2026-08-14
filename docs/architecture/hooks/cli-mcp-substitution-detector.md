# cli-mcp-substitution detector

**Event:** `PreToolUse` · **Matcher:** `Bash|mcp__minsky__session_exec` · **Posture:**
calibration-first (log-only, never denies) · **Override:** `MINSKY_ALLOW_CLI_SUBSTITUTION=1`
· **Task:** mt#4144 · **Family:** `family:operator-deferral-detector` (root mem#707)

## What it catches

A `Bash` (or `session_exec`) command that invokes the Minsky CLI for a command which has a
registered `mcp__minsky__*` equivalent, in a session where no MCP call has succeeded.

`decision-defaults.mdc §Missing MCP tool` has stated the policy since mt#1983/1988 —
"bash-before-MCP, MCP erroring for it, no tool+bash denied" → escalate with capability+gap and
four options. Nothing enforced it. This detector is that enforcement.

## Why the family's existing containment missed it

The operator-deferral family's ACT path was covered only by `block-bulk-process-kill` (mt#4081),
whose trigger is a destructive verb (`kill`/`pkill`/`killall`) in a turn with no capability search.
An agent that concludes a tool surface is unavailable and **rebuilds** it out of CLI calls destroys
nothing, defers nothing, and says nothing. It reads as diligence, which is exactly why no surface
saw it.

mem#707 R9 wrote the gap down in one line — "the act-path family is wider than the kill verb" — and
R10 went through it fifteen minutes after mt#4081 shipped DONE: ~20 `Bash` calls reconstructing
`tasks get|spec get|status set|edit`, `memory get|patch`, `tools asks list|get`, with the operator
told in the turn's final message. Three durable writes took that path, so every PreToolUse guard
bound to the MCP tool names was bypassed as a side effect — a cost the turn's own report understated
as "I used CLI equivalents throughout."

## Why the trigger is tool-call state

Surfaces A–E of `operator-deferral-detector` key on prose. The act path emits none. ADR-024
§Context names adding another phrase family as the arms race to stop, so both legs here are facts
about what the session DID:

1. the command resolves to a registry command id that has an MCP form, and
2. `extractToolUseNames` finds no `mcp__minsky__*` call in the transcript.

There is no paraphrase axis, so **ADR-024's ladder does not govern this detector** — Rung 2
(embedding recall-widening) is not merely unlicensed but meaningless against a command string. Its
sibling `truncated-outcome-read-detector` (mt#4096) reached the same conclusion for the same matcher
class, and had to correct the same initial over-reading at implementation time. mt#4144's planning
audit likewise recorded "extends ADR-024 at Rung 1" before the implementation corrected it.

## The equivalence oracle

`src/generated/completion-manifest.json` carries a `commandId` on every CLI leaf generated from the
shared command registry. The MCP tool name is a pure transform of that id — the MCP adapter
registers each command under `name: command.id`
(`src/adapters/mcp/shared-command-integration.ts:533`) — so `tasks.status.set` is
`mcp__minsky__tasks_status_set`.

Reading generated JSON is what keeps this hook off the domain layer. A PreToolUse hook that imported
the registry would owe `ensureHookDomainBootstrap()` — config init plus a DB-capable provider
resolve — on **every** `Bash` call, per `custom/require-hook-domain-bootstrap`.

**Absence is an answer, not a lookup failure.** A leaf with no `commandId` is a command with no MCP
equivalent, and never fires.

### The mapping is not a plain id split

`CategoryCommandHandler`'s path builder
(`src/adapters/shared/bridges/cli/category-command-handler.ts:192-218`) mounts every command under
its lower-cased category, then branches: an id that already starts with `<category>.` is stripped
and split (`tasks.status.set` / `TASKS` → `minsky tasks status set`), while one that does not is
split whole underneath the category name (`asks.list` / `TOOLS` → `minsky tools asks list`). The
leaf name is appended when it does not match the last id segment.

`findNodeByCommandId` in `scripts/build-completion-manifest.ts` reproduces that candidate order and
confirms each candidate against the Commander tree the CLI actually built, rather than importing the
private method. Drift is bounded by construction: an unresolved candidate under-reports coverage; it
never stamps a wrong id. Measured at authoring time: **227 stamped, 0 unresolved.**

## Suppression, and why it is still recorded

Once any `mcp__minsky__*` call has succeeded in the session, a CLI invocation is a deliberate choice
and the detector stays silent — but writes a `suppressed-mcp-in-use` calibration record anyway, so
the suppression's own miss rate stays measurable. This follows the evaluation-stream convention the
operator-deferral surfaces already use.

## What it does NOT cover

- **A non-Minsky tool surface going missing** (github MCP, chrome-devtools). Same root, different
  registry; no owner. mt#3779 tracks the github-MCP instance specifically but does not generalize.
- **The deferral-PROSE path** — `operator-deferral-detector` owns that (mt#2459, DONE).
- **Whether the substitution was RIGHT.** The claim is only that it happened with the MCP surface
  unused; a correct substitution, announced to the operator, should read as a clean fire.
- **Commands with no MCP equivalent** — structurally excluded by the missing `commandId`.

## Implementation notes worth keeping

Two findings came out of the tests rather than the design:

- **Path-qualified invocation was missed.** `leadingTokenOf` returns the whole token, and `.mcp.json`
  itself launches `/Users/<user>/.bun/bin/minsky`. The leading token is now basenamed.
- **`minsky compile` DOES have an MCP form.** mt#4144's original AT3 named it as a
  no-MCP-equivalent negative control; `mcp__minsky__compile` exists, so firing on it is correct. The
  genuine negatives are category containers (`minsky tasks`), which carry no `commandId`.

## A canary is run through the WHOLE dispatcher — keep it read-only

This guard's canary was first written as the originating incident's literal command,
`bun run src/cli.ts tasks status set "mt#0000" BLOCKED --json`. That hung
`guard-feedback-shape.test.ts` outright: 12/12 passing in 3.7s became a `beforeAll` timeout at 60s
with **zero** tests run.

The cause is not this guard. `run-guard-canaries` feeds each canary input through the real
dispatcher, so EVERY guard registered on the same matcher also runs against it — and a canary
naming a state-mutating Minsky command reaches a sibling's DB-backed probe, which hangs when no
database is reachable. Changing the canary to a read (`tasks get`) restored 12/12 in 3.2s with no
other change; the guard's own 26 tests were green throughout, which is why the failure looked
unrelated to it.

Two things follow for anyone adding a guard here. **Prefer a read-only canary** — it must exercise
your matcher, not perform meaningful work. And when the shape test starts timing out after you add
a registration, suspect the canary INPUT before the guard code: disabling this guard via its
override changed nothing, because the guard was never the thing running.

## Cross-references

`decision-defaults.mdc §Missing MCP tool` (the policy) · mem#707 (family root; R10 is this
detector's originating incident) · mem#471 / mem#493 (the `/mcp` reconnect-and-retry guidance the
incident had in memory and did not search for) · mt#4081 (the destructive-verb half) · mt#2459
(the prose half) · `guard-feedback-authoring.mdc` (advisory shape, `renderProbe`, the size ceiling)
· ADR-028 D1 (why this is a dispatcher guard rather than a standalone hook).
