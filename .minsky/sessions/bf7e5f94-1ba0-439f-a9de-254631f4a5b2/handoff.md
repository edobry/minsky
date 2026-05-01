# mt#1493 Handoff

Session: bf7e5f94-1ba0-439f-a9de-254631f4a5b2
Branch: task/mt-1493
Last commit: e1118b441

## Done

### Files created/modified

1. **`services/reviewer/scripts/measure-calibration.ts`** — Main measurement script.

   - `--mode=trivial`: auto-enumerates closed PRs from last 30 days with <=10 lines changed (broadens to <=20 lines / 60 days if <10 found); calls reviewer N times per PR; records `event` (REQUEST_CHANGES/COMMENT/APPROVE/NONE) per attempt.
   - `--mode=larger`: hardcoded corpus (PR #732 R1, #744 R1, #761 R1, #763 R1, #805 R1); records event + BLOCKING/NON-BLOCKING/PRE-EXISTING counts.
   - `--mode=contradiction`: replays PR #881 R3 with R1+R2 in prior-review summary; checks for direct contradiction of R1's accepted BLOCKING (process.exit vs exit() helper, row 54).
   - `--dry-run`: fetches corpus + builds prompts WITHOUT calling OpenAI; prints diff sizes, prior-review markdown sizes, system/user prompt sizes.
   - Free-text fallback: if `output.toolCalls` is empty and `output.text` contains structured findings, parses via `parseFindingsFromBody`. `findingSource` field records which path was used.
   - Outputs JSON to `services/reviewer/scripts/measure-calibration-<mode>-results.json`.

2. **`services/reviewer/scripts/replay-severity.ts`** — Copied verbatim from `task/mt-1465` (PR #920). The severity-inflation harness for mt#1465 A/B comparisons.

3. **`services/reviewer/src/replay-summary.ts`** — Extended with severity-inflation helpers from `task/mt-1465`:

   - `FlatFinding` interface
   - `parseFindingsFromBody()` — parses findings from review body text (both bold and bare marker formats)
   - `detectSeverityInflation()` — detects BLOCKING findings that escalate prior NON-BLOCKING/PRE-EXISTING
   - `SeverityInflationResult` interface

4. **`services/reviewer/src/replay-summary.test.ts`** — 25 unit tests for `parseFindingsFromBody` and `detectSeverityInflation` (all passing).

### Verification done

- `bun x tsc --noEmit` in `services/reviewer/` — clean, no errors
- `bun test src/replay-summary.test.ts` — 25/25 pass
- The dry-run smoke tests (Step 7 in the spec) require a real GITHUB_TOKEN. The `GITHUB_TOKEN` env var was not available in `session_exec` during this dispatch, so live dry-run verification is deferred to the main agent.

## What is NOT yet done

- **Step 7 dry-run smoke tests** — Main agent must run:

  ```
  cd /path/to/session/services/reviewer
  GITHUB_TOKEN=<token> bun scripts/measure-calibration.ts --mode=trivial --dry-run
  GITHUB_TOKEN=<token> bun scripts/measure-calibration.ts --mode=larger --dry-run
  GITHUB_TOKEN=<token> bun scripts/measure-calibration.ts --mode=contradiction --dry-run
  ```

  Verify: >=10 PRs in trivial corpus, no 404s for larger/contradiction prior-review fetches.

- **The 3 live measurement runs** — authorized by main agent only:

  ```
  GITHUB_TOKEN=<token> OPENAI_API_KEY=<key> bun scripts/measure-calibration.ts --mode=trivial
  GITHUB_TOKEN=<token> OPENAI_API_KEY=<key> bun scripts/measure-calibration.ts --mode=larger
  GITHUB_TOKEN=<token> OPENAI_API_KEY=<key> bun scripts/measure-calibration.ts --mode=contradiction
  ```

- **PR creation** — deferred to main agent post-measurements.

## Estimated cost

- ~$10 per live run at gpt-5 rates
- 3 runs = ~$30 total
- Default: 3 attempts per entry; trivial mode caps at 20 PRs

## Known issues / scope concerns

1. **GITHUB_TOKEN not available in session_exec** — The dry-run smoke tests could not be executed during this dispatch. The scripts compile cleanly and all unit tests pass. The main agent should run dry-run mode with a real token before authorizing live runs.

2. **No-op tool handler limitation** (inherited from replay-severity.ts) — Tools are enabled with no-op readFile/listDirectory handlers. This means `blockingCount` and `currentFindings` in larger-mode and contradiction-mode measurements come from either tool-call output or the free-text fallback parser. The `findingSource` field records which path was used per attempt, so the main agent can assess data quality post-run.

3. **Trivial corpus broadening** — If the primary window (<=10 lines, 30 days) yields <10 PRs, the script broadens to <=20 lines / 60 days and logs `corpusBroadeningNote` in the JSON output. This is expected behavior and is documented in the script.

4. **PR #881 R3 prior-review count** — The contradiction corpus assumes PR #881 has at least 3 bot reviews. If it only has 2, `fetchIterationContext` will throw a clear error during dry-run. Verify in dry-run before authorizing the live run.

5. **`replay-summary.ts` diverges from task/mt-1465** — The version in this session omits the `aggregateSummary`/`ReplaySummary`/`ReplayRunResult` exports that are in `task/mt-1465`'s version (those were already present on main). The severity-inflation additions (`FlatFinding`, `parseFindingsFromBody`, `detectSeverityInflation`, `SeverityInflationResult`) are the delta, and all 25 tests cover them.
