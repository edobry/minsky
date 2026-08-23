## CLOSED 2026-08-14 — central claim falsified; evidence moved to mt#3053

**This task should not have been filed.** Its headline claim — "main is red, this blocks merges
generally" — is false, and its stated mechanism ("~52s to serve `/health`") did not reproduce.

What actually happened, in the order it came in:

1. A `/health` poll measured first-200 at 52s. That run was concurrent with a 900s full-suite run;
   a clean re-measure on an idle machine gave **3s**. The 52s figure was load, not boot cost.
2. CI's `build` job — the full suite — passed on the same tree, 20/20 checks green (PR #3009). So
   `main` is not red. The 12/67 failure is local to one developer machine running concurrent agent
   sessions and their MCP daemons.
3. mt#3053 already owns this exact file's instability, explicitly scoped as "the FILE, not one
   test", and already names multiple concurrent agent sessions on one machine as the aggravating
   condition.

The duplicate check recorded below reasoned that mt#3053 was a _different_ phenomenon because this
one was "deterministic, standalone, idle machine". Two of those three were wrong: the machine was
not idle, and CI green makes it environment-specific rather than deterministic. The guard's own
duplicate probe had failed open on a timeout for this create, so nothing caught it.

The genuinely new evidence — that the file now fails 12/67 _standalone_, that the failures are on
**ephemeral** ports rather than mt#3053's hard-coded 41006 (so its "root cause found" does not cover
this signature), and that the file went from a measured 17.30s to 258–282s — has been appended to
**mt#3053** under `## 2026-08-14 local occurrence`. That is where the work belongs.

Nothing here is actionable on its own. Closed as subsumed.

## Summary

`main` is currently red. `src/commands/mcp/start-command.test.ts` fails **12 of 67**, every failure
the same shape — `HTTP server did not ready within timeout on port <N>` from `spawnHttpMcp`
(`start-command.test.ts:824`), each burning its full ~20s budget. The full gated suite no longer
completes: `run-tests-main.ts` is terminated by its 900s wall-clock watchdog and
`run-tests-gated.ts` fail-closes on the missing completion summary.

The server is not failing to boot. It boots and serves — just far too slowly. Measured on main
(`ddd6035aa`), idle machine, real binary:

```
$ bun run src/cli.ts mcp start --http --host=127.0.0.1 --port=39322
  polled GET /health once a second
READY after 52s (http 200)
```

52s against a 20s readiness budget accounts for all 12 failures exactly.

## This is a fresh regression, and the window is four commits wide

At **`60e0337c3`** (the commit this session branched from) the full gated suite passed:
`Ran 13754 tests across 931 files. [210.13s]`, `run-tests-gated.ts: all test steps passed`, zero
failures. That run covers `src/commands/mcp/start-command.test.ts` — it is in `run-tests-main.ts`'s
roots and is not under the excluded `src/mcp/**`. Earlier in the same session, on pre-merge main, a
real `mcp start --http` was up and serving inside a 20-second window (it booted, swept a 35-event
backlog and wrote 38 rows before being killed at 20s).

After merging `origin/main` the same file fails 12/67. The regression is therefore in one of the
four commits that merge brought in:

- `ddd6035aa` fix(mt#2702): Mask credential values in the config set/unset write echo
- `4495495d9` feat(mt#3815): Supervise a registry of N daemons, and register the local MCP daemon
- `76b73826e` fix(mt#4147): Stop flagging decision types nobody was ever going to render
- `58200d0d4` / `c29dce471` (mt#2702 / mt#4147 duplicates on the same range)

**`4495495d9` (mt#3815) is the leading suspect and is UNVERIFIED as the cause.** It is the only one
of the four that touches MCP daemon startup — it registers the local MCP daemon with a supervisor
registry, which is exactly the phase that got slow. Nobody has bisected. Do not treat the
attribution as established; run the bisect below first.

## Reproduction

Reproduced twice, independently, on an idle machine with no other test processes running:

- Main workspace (`/Users/edobry/Projects/minsky`, `ddd6035aa`):
  `bun test --preload ./tests/setup.ts --timeout=30000 src/commands/mcp/start-command.test.ts`
  → `55 pass, 12 fail, Ran 67 tests across 1 file. [257.79s]`
- A session workspace whose only diff was an unrelated two-file change: identical `55 pass /
12 fail` split.

The identical split in both trees is what rules out the session's own changes.

## Success Criteria

- [ ] The regressing commit is identified by bisect across the four-commit window above, and named
      here. `git bisect` over `bun test ... start-command.test.ts` is sufficient — the failure is
      deterministic, not flaky.
- [ ] Boot time to first `GET /health` 200 is measured before and after the fix, on an idle
      machine, and both numbers are recorded here. The pre-regression figure is under 20s (the
      tests' budget); the current figure is ~52s.
- [ ] `bun test --preload ./tests/setup.ts src/commands/mcp/start-command.test.ts` passes 67/67.
- [ ] `MINSKY_PREPUSH_FULL_SUITE=1 bun scripts/run-tests-gated.ts` completes and prints
      `all test steps passed` — i.e. no longer trips the 900s watchdog.

## Scope

**In scope:** whatever the bisect identifies as having slowed MCP HTTP boot, and its fix.

**Out of scope:** raising the tests' 20s readiness budget or the 900s watchdog. Both are the
measuring instruments; moving them hides the regression rather than fixing it, and the watchdog
exists precisely to make a hang visible (mt#3156). If the new boot cost turns out to be deliberate
and irreducible, that is a decision to record explicitly, not a threshold to quietly raise.

## Acceptance Tests

1. `bun test --preload ./tests/setup.ts --timeout=30000 src/commands/mcp/start-command.test.ts`
   → 67 pass, 0 fail. Paste the counts.
2. The boot-timing probe (poll `GET /health` once a second against a real
   `mcp start --http`) reports ready in under 20s. Paste the measured seconds.
3. `MINSKY_PREPUSH_FULL_SUITE=1 bun scripts/run-tests-gated.ts` prints a completion summary and
   `all test steps passed`.

## Context

Found while running the full suite for mt#4131, whose own diff (`packages/domain/src/events/emitter.ts`,
`src/mcp/disconnect-event-sweep.ts`) is unrelated and was ruled out by the two-tree reproduction above.

This blocks merges generally: any PR whose CI runs the full suite inherits the failure, so it is not
specific to one changeset.

A same-session side effect worth noting for whoever picks this up: MCP tool calls against the local
server were also intermittently slow or failing during this window (`session_exec` and
`tasks_search` each exceeding 120s; two `Failed query: select ... from "sessions"` errors, one
carrying `write CONNECT_TIMEOUT`). Whether that shares a root cause with the slow boot is
UNVERIFIED — it may simply be load from the 900s test run. Recorded because it is a cheap signal if
it recurs, not as a claim.

Duplicate check: `tasks_search` for "start-command test HTTP server did not ready within timeout MCP
boot failures on main" returned 8 candidates. Nearest is **mt#3053** (1.097) — "Flaky: OAuth
Discovery 'POST /register returns 400 when DB unavailable' times out at 30s under full-suite CI
parallelism". Same test family, different phenomenon: mt#3053 is flakiness under CI parallelism,
whereas this is deterministic (12/12, twice, standalone, idle machine) and the server demonstrably
takes 52s to serve. Fixing this may well retire mt#3053's symptom; it should not be folded into it,
because mt#3053's premise is contention and this one's is a boot-cost regression. Also reviewed and
rejected: mt#1396 (HTTP session-cap race), mt#3777 (leaked `mcp start --http` processes), mt#1257
(MCP timeout config), mt#1427, mt#935, mt#892, mt#1135 — none concern MCP boot latency. No duplicate.
