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
- **Stale / carried-over CI check.** Verified via the GitHub Actions API
  (`GET /repos/edobry/minsky/actions/runs/28900851179`) that the `build` job for commit
  `05547b401` was a genuine fresh `push`-triggered run (`event: "push"`, `run_attempt:
1`, `created_at: 2026-07-07T21:45:09Z` — 3 seconds after the commit's own `2026-07-07
17:45:06 -0400` = `21:45:06Z` timestamp), not a rerun and not a check carried over from
  an earlier commit or the PR's pre-merge synthetic-merge test.
- **Bun exit-code semantics in general.** A synthetic single-file test with one failing
  assertion (`bun test <file>`) correctly returns exit code 1 locally. Running
  `subagent-dispatch-tracker.test.ts` alone returns exit 1 with the expected 6 failures.
  Bun version matches exactly: local `bun --version` == CI's pinned `1.2.21`
  (`.github/workflows/ci.yml`, `oven-sh/setup-bun@v2`).

### What was found: CI's `Test` step can report `success` despite a real, currently-reproducible failure

Querying the GitHub Checks API directly for commit `05547b401`
(`GET /repos/edobry/minsky/commits/05547b401/check-runs`) shows the `build` check run
(id `85736968600`, same workflow run `28900851179`) concluded `success`. But that same
check run's own annotations
(`GET /repos/edobry/minsky/check-runs/85736968600/annotations`) include:

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

### What remains open

The precise Bun-internal (or CI-runner-specific) mechanism was **not** pinned down.
Local reproduction attempts:

- Running `cockpit-credential-integration.test.ts` alone: exit 1 (correctly fails).
- Running it combined with `subagent-dispatch-tracker.test.ts` (2 files, replicating
  both of the CI run's known failures in one invocation): exit 1, 7 fail reported
  correctly — the swallowing did **not** reproduce at 2-file scale.
- Running the full `./src` directory (147 test files, matching CI's actual scale more
  closely) did not complete within the available local tooling budget (120s), so
  scale-dependence (a worker-pool crash/timeout being mis-treated as non-fatal at 100+
  files, resource contention specific to `ubuntu-latest` runners, or a genuine Bun
  1.2.21 aggregation bug) is the leading hypothesis but is **unverified**.

This residual gap is tracked in mt#2665 (a further member of the mt#2608 CI-blind-spot
class): reproduce the swallow at CI's actual scale, pin down the mechanism, and either
file an upstream Bun issue or add a belt-and-suspenders CI hardening step that parses
`bun test`'s own summary line (`\d+ fail`) as a second gate independent of process exit
code.

### Practical takeaway until mt#2665 lands

**A green `build` check on this repo's CI is not currently proof that `bun run test`
found zero failures.** If a PR's local test run is red on a file also touched by CI, do
not assume CI's green status supersedes the local finding — reproduce locally in
isolation (`bun test --preload ./tests/setup.ts --timeout=15000 <specific file(s)>`) and
trust that over the CI badge until mt#2665 closes.

### Cross-references

- mt#2662 — this investigation (parent task)
- mt#2654 — the `subagent-dispatch-tracker.test.ts` date-drift fix (injected-clock seam)
- mt#2664 — the concrete broken test (`cockpit-credential-integration.test.ts`) this same
  CI run failed to catch
- mt#2665 — follow-up: pin down the CI-gating swallow mechanism, harden the gate
- mt#2608 — CI blind-spot closure (parent class this is a residual member of)
- `.github/workflows/ci.yml` — the `build` job, `Test` step
- `package.json` — the `"test"` script (`bun run test`'s exact invocation)
- `bunfig.toml` — `[test]` defaults (`preload`, `randomize`, `pathIgnorePatterns`) used by
  bare `bun test`
