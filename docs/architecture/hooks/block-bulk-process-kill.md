# block-bulk-process-kill

**Event:** PreToolUse (`Bash`, `mcp__minsky__session_exec`) · **Posture:** denies from day one ·
**Override:** `MINSKY_ALLOW_BULK_PROCESS_KILL=1` · **Task:** mt#4081

## What it denies

- `kill` naming **three or more** PIDs (`BULK_PID_THRESHOLD`).
- `pkill` / `killall` naming a process in `INTERACTIVE_PROCESS_CLASSES` — `claude`, `node`,
  `bun`, the shells, the terminals, `ssh`, `tmux`, the editors.

It does **not** fire on a one- or two-PID kill, on `kill -0` / `kill -s 0` (liveness probes), or
on `pkill`/`killall` against an ordinary process (a stuck test runner, a dev server).

## Why it exists

The operator-deferral family's shipped detector covers the **defer path**: prose in which the
agent hands a fixable thing to the operator. The **act path** emits no prose. The agent decides a
capability is unavailable and quietly builds around it, and the only trace is the workaround.

Originating incident, 2026-08-13 (mem#707 R8). Recovering ~28 Claude Code sessions after an iTerm
force-kill, the agent was asked to **move** the sessions into separate windows. It probed one
channel — AppleScript's `move`, which returned OK and silently did nothing — read that as "the
capability does not exist", and proposed `kill` on 26 live sessions to destroy and recreate them.
The operator denied the tool call by hand. A `WebSearch` run afterwards returned the iTerm2 Python
API's `Window.async_set_tabs()`, a live non-destructive move, which is what actually shipped the
request in about twenty seconds.

Two rules already covered this and fired on nobody:

- `claim-confidence.mdc` — a negative bounded to one channel is a finding about THAT CHANNEL.
  "Run one search for the CAPABILITY itself, not the mechanism you already ruled out."
- `user-preferences.mdc §Probe before SELF-IMPROVISING` — the act-path variant of
  probe-before-deferring.

Both are prose. This guard is the deterministic layer under them, at the moment the destruction
would happen.

## Why it denies rather than shipping calibration-first

The repo's calibration-first convention (ADR-024) targets heuristics with a real false-positive
surface — trigger-phrase matching over agent prose, where the corpus is unproven. This check
compares a structured command string against a fixed shape: no paraphrase axis, no judgment. That
is the same matcher class `block-concurrent-bulk-mutation` and `block-secret-file-read`'s mt#4017
extension cite for shipping straight to deny.

The cost asymmetry agrees. A false positive costs one override on a command the operator can
immediately re-run. A false negative costs the working set.

## Known recall limits (misses, never false fires)

- **Expanded PID lists.** `kill $(pgrep -f claude)` names no literal PIDs, so the count cannot be
  taken and the guard is silent.
- **Process classes outside the list.** Deliberate: the list is about which targets constitute a
  working set, not about which verbs are dangerous.
- **PIDs the agent itself backgrounded.** mt#4081's spec listed this as an exclusion. The hook
  input carries no record of which PIDs the agent spawned, and inferring it from the process tree
  would be a guess with a silent failure mode — so the exclusion is not implemented and the
  override covers the case. Recorded as a deviation in the task spec.

Each of these degrades recall in the same direction as `chained-verification-commands`' documented
stale-pattern-list note: a miss, never a wrong deny.

### Retired recall limit: a redirection displacing the target (mt#4193)

Until mt#4193 a fourth limit sat here without ever being written down, because nobody had noticed
it. `pkill`/`killall` took their target as "the last non-flag argument", so any redirection
displaced the real one:

| Command                     | Target the guard read         | Denied |
| --------------------------- | ----------------------------- | ------ |
| `pkill -f node`             | `node`                        | yes    |
| `pkill -f node 2>/dev/null` | `null` (after the path strip) | **no** |
| `pkill -f node > /dev/null` | `/dev/null` → `null`          | **no** |

The same defect reached the OTHER consumer in the opposite direction. `findKillInvocation` counts
targets for `operator-deferral`'s act-path surface, and the space-separated form left the redirect
PATH in the list — so `kill 4821 > /dev/null` counted two targets and a one-process cleanup read as
a multi-target kill.

Both are fixed at TOKENIZATION rather than in either consumer's filter: `stripRedirections` removes
redirections from the argument list inside `eachKillSegment`, so every consumer sees the same
arguments. That is why `isTargetToken` is now only a flag test — the previous split, where one
consumer's filter carried the redirection rule and the other had an inline copy of "non-flag", is
exactly how the two directions of one bug stayed alive in two places.

Note this is the guard's first RECALL WIDENING — every prior note in this section degrades recall
by design. It denies strictly more than before, and only commands that already denied without
their output plumbing. A class the guard deliberately misses (`pkill -f minsky-mcp`) still misses
with or without a redirect; there is a regression test pinning that.

## Relationship to the detector

`operator-deferral-detector`'s **surface F** (act-path workaround) records the same shape as an
observation — a destructive action in a turn with no capability search — and writes it to the
family's evaluation stream so the miss rate stays measurable. The detector cannot be the
load-bearing half: it ships `INJECTION_ENABLED = false`, so even a correct fire emits nothing to
the agent in the turn that matters. This guard is what actually stops the call.

## Cross-references

`hook-files.mdc` (index entry) · `docs/architecture/hooks/operator-deferral-detector.md`
(surface F) · mem#707 (family root, R8) · mt#2459 (the defer-path fix, DONE) · mt#3999 (surface E,
whose `absenceClaimPresent` leg missed this turn) · ADR-024 (the ladder this guard sits outside).
