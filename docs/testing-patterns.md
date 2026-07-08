# Testing patterns: known divergences and gotchas

Cross-observation notes that don't fit `docs/testing.md` (test-suite overview) or
`docs/bun-test-patterns.md` (mocking recipes) — findings from specific incidents where
a test result surprised someone, kept here so the next observer doesn't have to
re-investigate from scratch.

## mt#2662: local `bun test` red, CI `bun run test` green, identical commit, same day

### Observation (PR #1817, 2026-07-07)

While implementing mt#2654, a local run of `src/mcp/subagent-dispatch-tracker.test.ts`
against the exact content of main's HEAD (commit `05547b401`) reproduced 6 failing
tests. CI's required `build` job — which runs `bun run test` over (among other paths)
`./src`, the same file — reported `success` on that same commit, same day. mt#2654 made
the test file date-independent (mooting the specific 6 failures going forward), but the
divergence mechanism itself — how CI and a local run of ostensibly the same command over
identical content could disagree — was left undiagnosed and is the subject of this entry.

### What the 6 failures actually were

`subagent-dispatch-tracker.test.ts` (pre-mt#2654) hardcoded `BASE_DATE = new
Date("2026-05-11T12:00:00.000Z")` and built fixtures relative to it (`hoursAgo(n)`).
Several assertions depend on the tracker's `getCadence()` / `getEscalation()` methods,
which queried "last 24 hours" against the real wall clock (`new Date()`) at call time —
not an injected clock. By 2026-07-07/08, `BASE_DATE` was **~57 days** stale relative to
real "now". Every fixture built from it sat far outside any 24-hour (or 26-hour) window
used by the assertions. This is a **static, deterministic** drift, not a time-of-day
boundary effect — it fails identically at any hour of any day past
`BASE_DATE + threshold`. mt#2654 fixed it by threading an optional `now: Date` parameter
through `getCadence()`/`getEscalation()` and pinning every test call site to `BASE_DATE`.

Reproduction (still valid — checks out the pre-fix pair of files against current
`tests/setup.ts` and runs them in isolation):

```bash
# CAUTION: this overwrites the two files in your working tree. Run `git status`
# first and make sure it's clean (no uncommitted changes to these two paths)
# before doing this, and restore with `git restore` immediately after reading
# the result — don't leave the tree in this state. Prefer a scratch worktree
# if you want to avoid touching your primary checkout at all:
#   git worktree add /tmp/mt2662-repro 05547b401
#   cd /tmp/mt2662-repro && bun install --frozen-lockfile
#   bun test --preload ./tests/setup.ts --timeout=15000 src/mcp/subagent-dispatch-tracker.test.ts
#   cd - && git worktree remove /tmp/mt2662-repro
git show 05547b401:src/mcp/subagent-dispatch-tracker.ts > src/mcp/subagent-dispatch-tracker.ts
git show 05547b401:src/mcp/subagent-dispatch-tracker.test.ts > src/mcp/subagent-dispatch-tracker.test.ts
bun test --preload ./tests/setup.ts --timeout=15000 src/mcp/subagent-dispatch-tracker.test.ts
# 35 pass, 6 fail, exit code 1
git restore src/mcp/subagent-dispatch-tracker.ts src/mcp/subagent-dispatch-tracker.test.ts
```

### What was ruled out

Investigation compared CI's exact invocation against local invocations along every axis
named in the mt#2662 spec:

- **Preload.** Both `bare bun test` (via `bunfig.toml`'s `[test] preload =
["./tests/setup.ts"]`) and `bun run test` (package.json script, which passes
  `--preload ./tests/setup.ts` explicitly) load the same preload file.
- **Bunfig / glob resolution.** `bunfig.toml`'s `pathIgnorePatterns` excludes only
  `services/**` and `src/cockpit/web/**`. `src/mcp/subagent-dispatch-tracker.test.ts` is
  covered by both a bare `bun test` scan and the package.json `"test"` script's explicit
  `./src` argument — it is not silently excluded either way.
- **TZ / clock skew.** The drift is ~57 days; no plausible timezone offset or clock skew
  between a local machine and a CI runner explains a pass vs. fail flip at that
  magnitude.
- **Stale / carried-over CI check.** Verified via the GitHub Actions API — replicable
  with `curl -s https://api.github.com/repos/edobry/minsky/actions/runs/28900851179`
  (or `gh api repos/edobry/minsky/actions/runs/28900851179`) — that the `build` job for
  commit `05547b401` was a genuine fresh `push`-triggered run (`event: "push"`,
  `run_attempt: 1`, `created_at: 2026-07-07T21:45:09Z` — 3 seconds after the commit's
  own `2026-07-07 17:45:06 -0400` = `21:45:06Z` timestamp, itself read with `git show -s
--format='%H %ci' 05547b401`), not a rerun and not a check carried over from an
  earlier commit or the PR's pre-merge synthetic-merge test.
- **Note on tooling:** `mcp__minsky__forge_ci_run_view_log` (the in-repo MCP tool for
  fetching a workflow run's raw step logs) failed to decode every entry for both this
  run and a separate fresh run tried during this investigation — every log entry
  returned `[DEFLATE entry could not be inflated (unexpected end of file)]`. The
  unauthenticated GitHub REST API (`.../check-runs` and `.../annotations`, both used
  above) was the working fallback and is what all API-derived claims in this doc are
  sourced from. The raw step-log path remains unverified as a source; if you need actual
  step-by-step CI console output (not just check-run annotations), expect this tool to
  fail and use `curl`/`gh api` against the endpoints cited in this doc instead.
- **Bun exit-code semantics in general.** A synthetic single-file test with one failing
  assertion (`bun test <file>`) correctly returns exit code 1 locally. Running
  `subagent-dispatch-tracker.test.ts` alone returns exit 1 with the expected 6 failures.
  Bun version matches exactly: local `bun --version` == CI's pinned `1.2.21`
  (`.github/workflows/ci.yml`, `oven-sh/setup-bun@v2`).

### What was found (indirect signal): CI's `Test` step can report `success` despite a real, currently-reproducible failure

Querying the GitHub Checks API directly for commit `05547b401` — replicable with
`curl -s https://api.github.com/repos/edobry/minsky/commits/05547b401/check-runs`
(unauthenticated works; this is a public repo) or the equivalent
`gh api repos/edobry/minsky/commits/05547b401/check-runs` — shows the `build` check
run (id `85736968600`, same workflow run `28900851179`) concluded `success`. But that
same check run's own annotations — `curl -s
https://api.github.com/repos/edobry/minsky/check-runs/85736968600/annotations` (or
`gh api repos/edobry/minsky/check-runs/85736968600/annotations`) — include:

```json
{
  "path": "src/cockpit/cockpit-credential-integration.test.ts",
  "message": "Expected: false, Received: true",
  "annotation_level": "failure",
  "title": "error: expect(received).toBe(expected)"
}
```

This is a **real, independently-reproducible failure**, unrelated to date drift. Running
it locally, in isolation, against current main:

```bash
bun test --preload ./tests/setup.ts --timeout=15000 src/cockpit/cockpit-credential-integration.test.ts
# 15 pass, 1 fail, exit code 1
#
# 161 |       const result = await writer.setConfigValue("bogusTopLevel.key", "value");
# 162 |       expect(result.success).toBe(false);
#                                    ^
# error: expect(received).toBe(expected)
# Expected: false
# Received: true
#   at src/cockpit/cockpit-credential-integration.test.ts:162:30
```

Same file, same assertion, same message the CI annotation recorded — this test is
genuinely broken on main right now (tracked separately in mt#2664; it is a pre-existing
gap in the `ConfigWriter` / Zod strictObject schema, unrelated to the tracker's
date-drift bug).

**The conclusion this supports:** on the exact CI run being investigated
(`05547b401` / run `28900851179`), the `Test` step (`bun run test`) executed a genuine,
still-currently-reproducible failing assertion — and the check run still concluded
`success`. Since the `subagent-dispatch-tracker.test.ts` failures from that same run are
deterministic (not order- or timing-sensitive), the most parsimonious explanation is that
**the same failure-swallowing mechanism that let the `cockpit-credential-integration`
failure through also let the tracker's 6 failures through**, on that same `bun run test`
invocation. This was verified as a live phenomenon, not conjecture: two independent test
files, both provably broken by direct local reproduction, both present in the exact CI
run whose `build` job nonetheless reported `success`.

### Root cause, pinned: full-suite `bun test` silently truncates with exit 0 when an MCP-server-lifecycle test file is in the file set

The indirect signal above (an annotated failure coexisting with a `success` conclusion)
motivated a direct, fresh, at-scale local reproduction of CI's _exact_ invocation —
`bun run test`, i.e. `bun test --preload ./tests/setup.ts --timeout=15000 ./src
./tests/adapters ./tests/domain ./tests/scripts ./tests/unit ./tests/mcp
./tests/dev-tooling ./tests/architecture ./packages/domain ./packages/shared/src` (the
literal `package.json` `"test"` script, run via `bun run test` exactly as CI's `Test`
step does — not a narrower `bun test <file>` invocation). Two consecutive runs, same
machine, same bun `1.2.21`:

```bash
bun run test > /tmp/full-run.log 2>&1; echo "EXIT_CODE=$?" >> /tmp/full-run.log
wc -l /tmp/full-run.log        # 659 lines, both runs, byte-identical structure
grep "Ran .* tests" /tmp/full-run.log   # <no match> — no completion summary, either run
tail -3 /tmp/full-run.log
# ...(JSON test-fixture noise from src/mcp/disconnect-tracker.test.ts)...
# EXIT_CODE=0
```

Both runs: **no `(fail)` lines, no `X pass / Y fail` summary, no `Ran N tests across M
files` line — nothing past a burst of JSON fixture output from one early test file —
yet exit code 0.** `time` on the second run: `2.750s total`. A 147-file, 9-directory
suite cannot have genuinely executed in 2.75 seconds; this is a truncated run reporting
false success, not a fast comprehensive one.

**Isolating the trigger.** The JSON noise (`"message":"mcp_disconnect"` /
`"mcp_process_start"` / `"mcp_reconnect"`, `"serverName":"srv"`) is
`src/mcp/disconnect-tracker.test.ts`'s own intentional test fixture output (it validates the
MCP-disconnect-cadence JSONL log shape documented in this repo's `CLAUDE.md`). Run
**alone**, that file is completely healthy:

```bash
bun test --preload ./tests/setup.ts --timeout=15000 src/mcp/disconnect-tracker.test.ts
# 57 pass, 0 fail, 163 expect() calls
# Ran 57 tests across 1 file. [545.00ms]
# exit code 0
```

Excluding it from the full-suite run (temporarily moved out of the tree, full `bun run
test` re-run, then restored) did **not** fix the truncation — it recurred, at the same
~2.4s / 54-line shape, this time on a **different** MCP-server-lifecycle file
(`"serverName":"Test Server"`, matching `src/mcp/presence-write-path.test.ts` and
`src/mcp/server.test.ts`). Both of those, run together in isolation, are also
completely healthy (39 pass, 0 fail, `Ran 39 tests across 2 files. [1345.00ms]`, exit
0).

**Conclusion.** This is not one broken file — it is a **class**: any test file in
`src/mcp/` that spawns/tracks real MCP server subprocess lifecycle events (real PIDs,
disconnect/reconnect JSONL fixtures) is healthy in isolation but, when it is part of
`bun run test`'s full ~147-file / 9-directory invocation, the entire `bun test` process
silently stops after that file's output — before printing that file's own summary, let
alone the aggregate one — while still exiting 0. This satisfies the "genuinely
Bun-internal" bar: the failure is not in this repo's test _logic_ (every implicated file
passes cleanly alone and in small combinations up to at least 2 files); it is in how
`bun test` 1.2.21 handles a large multi-directory file set that includes a real-subprocess-
spawning MCP test file. The exact internal fault (worker-thread crash on child-process
teardown, an fd/pipe interaction with Bun's own test reporter, or something else
Bun-side) was not further isolated — that remains for mt#2665 — but the _trigger class_
and the _externally observable shape_ (silent truncation, exit 0, no summary) are now
pinned with a same-day, twice-independently-reproduced local repro, not just the
indirect CI-annotation signal above.

This fully explains both original observations:
`src/cockpit/cockpit-credential-integration.test.ts` sorts alphabetically before
`src/mcp/` (`c` < `m`), so it ran and its failure was captured as a check-run annotation
before the truncation point; `src/mcp/subagent-dispatch-tracker.test.ts` sorts after
`src/mcp/disconnect-tracker.test.ts` (`d` < `s`) within the same directory, so on the CI
run in question it most likely never ran at all — its 6 failures were never reached,
never annotated, and never affected the exit code.

**Task-spec disposition (per mt#2662's Outcome note, `mcp__minsky__tasks_spec_patch`):**
this is the evidence-backed **Arm 3** split — root cause pinned as genuinely Bun-internal
at the observable-behavior level, deep internal fault isolation deferred to mt#2665
(re-scoped narrower: reproduce with a minimal 2-file repro — one MCP-lifecycle file +
enough padding files to cross whatever file-count/worker threshold triggers it — instead
of the full 147-file suite, then either file an upstream Bun issue or land the
`bun test`-summary-line CI hardening described below).

### Practical takeaway until mt#2665 lands

**A green `build` check on this repo's CI is not currently proof that `bun run test`
found zero failures, or even that it ran to completion.** If a PR's local test run is
red on a file also touched by CI, do not assume CI's green status supersedes the local
finding — reproduce locally in isolation (`bun test --preload ./tests/setup.ts
--timeout=15000 <specific file(s)>`) and trust that over the CI badge until mt#2665
lands a fix or a hardened gate. As a rule of thumb: if `bun run test`'s CI step log
doesn't show a `Ran N tests across M files` summary line, treat the run as inconclusive
regardless of its reported exit code — this repro shows exit 0 is reachable without one.

### Cross-references

- mt#2662 — this investigation (parent task)
- mt#2654 — the `subagent-dispatch-tracker.test.ts` date-drift fix (injected-clock seam)
- mt#2664 — the concrete broken test (`cockpit-credential-integration.test.ts`) this same
  CI run failed to catch
- mt#2665 — follow-up: isolate the exact Bun-internal fault behind the pinned
  MCP-lifecycle-test-file truncation (root cause already pinned here; this task is the
  deep-fault-isolation + upstream-report + CI-hardening follow-through), or harden the
  gate
- mt#2608 — CI blind-spot closure (parent class this is a residual member of)
- `.github/workflows/ci.yml` — the `build` job, `Test` step
- `package.json` — the `"test"` script (`bun run test`'s exact invocation)
- `bunfig.toml` — `[test]` defaults (`preload`, `randomize`, `pathIgnorePatterns`) used by
  bare `bun test`
