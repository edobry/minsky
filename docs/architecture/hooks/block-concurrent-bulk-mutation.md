# block-concurrent-bulk-mutation (mt#4055)

Denies invoking a repo script in its EXECUTE mode while another process is already running that
same script.

- **Event / matcher:** `PreToolUse` on `Bash|mcp__minsky__session_exec`, routed through the guard
  dispatcher's `GUARD_REGISTRY` (ADR-028 D1).
- **Posture:** denies from day one. Not calibration-first — see [Why it denies](#why-it-denies).
- **Override:** `MINSKY_ALLOW_CONCURRENT_BULK_MUTATION=1`.

## What it checks

Two steps, in order:

1. **Trigger (pure).** Does a top-level segment of the command invoke a `scripts/<name>.ts` AND
   carry an execute-class flag (`--execute` or `--apply`) as a whole argument? Segment splitting is
   quote-aware (shared with `chained-verification-commands` via `command-shape`), so a separator or
   a flag inside quotes can neither manufacture nor suppress a match.
2. **Probe (impure).** `pgrep -f <script basename>`, then `ps` on the returned pids for elapsed
   time and command line. Any live process other than this one denies.

Matching on the **basename** is deliberate: the two runs in the originating incident spelled the
path differently (one relative, one absolute), and the basename is what makes them the same script.

## Why the trigger is not a curated script list

mt#4055's spec proposed a maintained list of bulk-mutation script paths, reasoning that `--execute`
alone would over-fire. Measured before building: **30 scripts** under `scripts/` accept `--execute`,
and some are plainly benign (`smoke-*`, `verify-npm-pack-install`).

That measurement inverts the conclusion rather than supporting it. The deny condition is not _this
script is dangerous_ — it is _a second copy of this script is already running_, which is near-never
intended for a smoke test exactly as much as for a backfill. Keying on the concurrency removes the
need for a list, and with it the list's failure mode: a newly added script sitting silently outside
the guard. Recorded as a deviation in mt#4055 `## Design change`.

## Why it denies

The repo-wide observer convention is calibration-first, aimed at heuristics with a real
false-positive surface — trigger-phrase matching over agent prose, where the corpus is unproven.
This check has no such surface: a structured command string against a fixed flag set, then a yes/no
question to the process table. No paraphrase axis, no judgment. Same matcher class
`block-secret-file-read` cites for shipping its mt#4017 extension straight to deny.

The cost asymmetry agrees. A false positive costs one override on a command the operator re-runs
immediately; a false negative is a second writer on production state.

## Fail-open, deliberately

If the process probe throws, the guard returns **no** processes and the command proceeds. An
unreadable `ps` must not be indistinguishable from a real collision — this guard exists to catch a
duplicate run, not to stand between the operator and their tooling.

## Canary

The registry canary expects `calibration`, not `deny`, and that is not an oversight: the deny
depends on the host's process table, which a canary cannot arrange without actually starting a
second process. So the canary exercises the real (pure) trigger and stops — `run` short-circuits in
canary mode before the probe, so no canary shells out. The deny path's coverage lives in
`block-concurrent-bulk-mutation.test.ts`, where the probe is injected.

## Originating incident (2026-08-12)

An approved authorization ask (ask#8035) licensed clearing the `agent_tool_call_projection` orphan
backlog. Acting on it, an agent ran
`bun scripts/backfill-agent-tool-call-projection.ts --execute --verify-sample=50` against
production — while another actor had been running the identical full-keyset script for ~2.5 hours
under mt#4050. Two concurrent writers on one production table for ~50 minutes. Both runs exit 0;
the collision surfaced only by chance, when an unfamiliar PID appeared in `pgrep` output while
tailing the log.

The structural gap it exposed: every duplication gate in the repo binds to a **task-graph** surface
(`parallel-work-guard` on `tasks_create`/`session_start`/`tasks_dispatch`, `/plan-task` gate (g),
the duplicate-check record, the duplicate-signature scan). The **execution** surface had none, so
the accumulated family of fixes gave exactly zero coverage here.

Two prior structural fixes in this family had already shipped DONE and did not contain it:
**mt#1305** (scoped to `session_start`) and **mt#2785** (the "bulk mutations require a task wrapper"
rule — precisely the rule violated, shipped as prose with nothing enforcing it).

The reasoning error, recorded in **mem#999**: an approval answers _may this be done_; it never
answers _is it already being done_. The denial message carries the correction, including the
second-order tell from the same incident — the agent then misidentified the running process's owner
by reading a peer session's log **filename**.

## Cross-references

- `mem#999` — the bridge memory; retires when this guard ships.
- `mem#256` — family root (distributed state vs. local view). Its "How to apply" step 1 already
  listed "schema migrations on shared DB" and "deploy starts" as needing this probe; the class was
  named three months before it was gated.
- `hook-files.mdc` — the gate index entry.
- ADR-028 D1 — the dispatcher/registry design this registers under.
