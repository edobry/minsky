#!/usr/bin/env bun
/**
 * Production opt-in parallel-sharded test runner for scripts/run-tests-main.ts (mt#2990).
 *
 * Splits the ~651-file main suite across N concurrently-spawned `bun test`
 * processes and reports ONE aggregated pass/fail result. Reuses (does not
 * re-derive) run-tests-main.ts's file-discovery (`discoverTestFiles`) and
 * mirrors/hardens scripts/run-tests-sharded-prototype.ts's validated
 * shard-splitting / concurrency / aggregation design (mt#2981's Outcome
 * section -- read that before touching this file). NOT wired into
 * `bun run test`, `.husky/pre-push`, or `src/hooks/pre-commit.ts` -- this is
 * an ADDITIVE, OPT-IN script (`bun run test:sharded`); flipping any of those
 * defaults to use this runner is a separate, later decision (mt#2981 Outcome
 * section 6).
 *
 * `bun test --help` reconfirmed at implementation time (bun 1.2.21, the
 * version pinned in this repo): no native `--shard`/`--parallel` flag exists
 * (only --timeout, -u/--update-snapshots, --rerun-each, --only, --todo,
 * --coverage[-reporter|-dir], --bail, -t/--test-name-pattern, --reporter,
 * --reporter-outfile) -- mt#2981's flagged "may exist in a later Bun" claim
 * remains unconfirmed and this hand-rolled `Bun.spawn` fan-out remains
 * necessary. Re-run `bun test --help` before extending this file further if
 * the pinned Bun version has since changed.
 *
 * Production hardening over the prototype (mt#2981 PR #2131 review, six
 * findings deliberately deferred to this task -- see mt#2990 spec "Production-
 * hardening requirements"):
 *
 *   1. Shard timeout/abort -- each shard is bounded by Bun.spawn's native
 *      `timeout` option (killSignal SIGKILL); once ANY shard is confirmed
 *      timed out, a shared AbortController aborts every still-running
 *      sibling too, rather than letting the run stall indefinitely on one
 *      hung process while healthy siblings keep burning CI time on a run
 *      that has already failed. See `runShardsConcurrently`.
 *   2. ANSI sanitization -- captured output is stripped of ANSI escapes
 *      before the completion-summary/fail-count regexes run. Empirically
 *      confirmed necessary during implementation: `FORCE_COLOR=1 bun test`
 *      wraps the "<N> fail" line as `\x1b[31m 1 fail\x1b[0m`, and the
 *      trailing `\x1b[0m` right after "fail" defeats the
 *      `^...$`-anchored FAIL_LINE_PATTERN (the `$` no longer lands at the
 *      literal end of the "fail" text). See `stripAnsi` / `verifyShard`.
 *   3. Empty-command guard -- `runShardsConcurrently` refuses to spawn any
 *      shard whose `command` array is empty (a caller/config bug), AND this
 *      script's own orchestration skips (never builds a command for) a
 *      shard the bin-packer assigned zero files to, rather than invoking
 *      bare `bun test` with no positional file args -- which would silently
 *      fall back to bun's own default file discovery, running the WRONG
 *      file set instead of erroring or no-opping.
 *   4. Separate stdout/stderr parsing -- confirmed empirically at
 *      implementation time (piped, non-TTY `bun test` invocation, bun
 *      1.2.21): the ENTIRE completion summary (pass/fail counts, "Ran N
 *      tests across M files") is written to stderr; stdout carries only the
 *      "bun test vX.Y.Z (...)" banner. `verifyShard` parses `outcome.stderr`
 *      as the sole, deterministic source -- it does NOT concatenate
 *      `${stdout}\n${stderr}` (joining two independently-captured streams
 *      with an artificial separator risks a regex spanning that seam, and a
 *      stdout fallback would mask genuine truncation on an empty stderr).
 *   5. Bin-packing completeness assertion -- `assertBinPackCompleteness`
 *      verifies every input file is assigned to exactly one shard (no drops,
 *      no duplicates, no phantom entries) after every `binPackFiles` call.
 *   6. Summary/fail-line contract fidelity -- see
 *      run-tests-main-sharded.test.ts's "matches the CI/pre-push grep
 *      contract" tests, which assert the synthesized `summaryLine`/`failLine`
 *      satisfy the EXACT patterns `.github/workflows/ci.yml` and
 *      `.husky/pre-push` (via scripts/run-tests-gated.ts's
 *      `evaluateBunTestSummary`) grep for.
 *
 * Cross-shard file-targeting hardening (R1 review, mt#2990 -- found via this
 * PR's own live verification against the real suite, not anticipated by the
 * prototype): `bun test <path>` matches positional args as SUBSTRINGS against
 * its own default repo-wide discovery, not as exact single-file targets.
 * Confirmed empirically: `packages/domain/src/**` mirrors several `src/**`
 * paths one-for-one, and an un-prefixed `"src/composition/container.test.ts"`
 * is a literal substring of
 * `"packages/domain/src/composition/container.test.ts"` -- so a shard given
 * the former as a bare arg also runs the latter, regardless of which shard
 * (if any) it was actually bin-packed into. PRIMARY fix: every file arg is
 * prefixed with `./`, which anchors the match and eliminates this collision
 * class (verified). DEFENSE-IN-DEPTH backstop: `detectShardScopeViolations`
 * compares each shard's own JUnit report against its assigned file list and
 * fails that shard closed if anything leaked in, catching any collision
 * class the prefix fix doesn't. See `detectShardScopeViolations`'s docstring
 * for the full empirical repro.
 *
 * Shard count: auto-detected via `os.cpus().length`, capped to the file
 * count (never more shards than files -- an excess shard would otherwise be
 * built with zero files); override with TEST_SHARD_COUNT (must be a positive
 * integer). Shard timeout: TEST_SHARD_TIMEOUT_MS (default below, grounded in
 * the ~130s measured sequential baseline -- mt#2933/mt#2981).
 *
 * Duration cache: scripts/test-duration-cache.json (gitignored, mt#2990), a
 * flat `{ [filePath]: durationMs }` map self-updated after every run from
 * each shard's own `--reporter=junit` output (reusing, not re-deriving,
 * scripts/analyze-test-timing.ts's `parseTestcases`) -- NOT via that script's
 * own `--run` single-XML-per-invocation assumption, since a sharded run
 * naturally produces N per-shard XML fragments (mt#2981 Outcome section 1,
 * "implementation-time wrinkle", option (b): a self-updating cache file,
 * decoupled from the JUnit reporter entirely as the read-side input). A file
 * with no history yet (new file, or the very first run) round-robins per
 * `binPackFiles`'s documented cold-start fallback.
 *
 * Any extra CLI args are forwarded to every shard's `bun test` invocation,
 * mirroring run-tests-main.ts -- EXCEPT `--reporter`/`--reporter-outfile`,
 * which this script reserves for its own per-shard JUnit capture; passing
 * either disables this run's duration-cache update (logged, non-fatal) so as
 * not to clobber the caller's own reporter output.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { readTextFileSync } from "@minsky/shared/fs";
import { parseTestcases, type TestCase } from "./analyze-test-timing";
import { discoverTestFiles } from "./run-tests-main";
import { binPackFiles as binPackFilesCore } from "./run-tests-sharded-prototype";

// ---------------------------------------------------------------------------
// Configuration (auto-detected, env-var overridable -- never hardcoded)
// ---------------------------------------------------------------------------

export const DURATION_CACHE_PATH = join(import.meta.dir, "test-duration-cache.json");

// Grounded in mt#2933/mt#2981's measured sequential baseline (~130s wall-clock
// for the FULL 651-file suite): a single shard holds only a SUBSET of the
// suite, so it should never legitimately approach that long. 5 minutes gives
// generous headroom for a slow/contended CI runner while still failing a
// genuinely hung process well before a human would give up waiting on it.
export const DEFAULT_SHARD_TIMEOUT_MS = 5 * 60 * 1000;

export function resolveShardCount(
  fileCount: number,
  cpuCount: number = cpus().length || 1
): number {
  const override = process.env.TEST_SHARD_COUNT;
  let requested: number;
  if (override) {
    requested = Number(override);
    if (!Number.isInteger(requested) || requested < 1) {
      throw new Error(
        `run-tests-main-sharded: TEST_SHARD_COUNT must be a positive integer, got "${override}"`
      );
    }
  } else {
    requested = cpuCount;
  }
  // Never more shards than files -- an excess shard would be built with zero
  // files, which this script's orchestration skips rather than spawning (see
  // hardening requirement #3), so capping here just avoids wasted bin-packer
  // work on shards that can never receive a file.
  return Math.max(1, Math.min(requested, fileCount));
}

export function resolveShardTimeoutMs(): number {
  const override = process.env.TEST_SHARD_TIMEOUT_MS;
  if (!override) return DEFAULT_SHARD_TIMEOUT_MS;
  const parsed = Number(override);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `run-tests-main-sharded: TEST_SHARD_TIMEOUT_MS must be a positive number, got "${override}"`
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// ANSI sanitization (production-hardening requirement #2)
// ---------------------------------------------------------------------------

// The standard strip-ansi pattern (sindresorhus/ansi-regex -- widely-used
// community regex, not re-derived from scratch). This repo does not have a
// direct `strip-ansi` dependency (only a transitive one, pinned in
// package.json's `overrides` for an unrelated enquirer/ansi-regex version
// conflict -- see the `_comment_ansi_regex_strip_ansi` note there), and a
// defensive regex this small does not warrant adding a new direct dependency.
const ANSI_PATTERN = new RegExp(
  [
    "[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d/#&.:=?%@~_]*)*)?(?:\\u0007|\\u001B\\u005C|\\u009C))",
    "(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))",
  ].join("|"),
  "g"
);

export function stripAnsi(input: string): string {
  return input.replace(ANSI_PATTERN, "");
}

// ---------------------------------------------------------------------------
// 1. Shard-splitting -- reuses the prototype's validated greedy-LPT
//    bin-packing algorithm unchanged; adds the completeness assertion
//    (hardening requirement #5) as a wrapper.
// ---------------------------------------------------------------------------

export interface FileDuration {
  path: string;
  /** Historical duration in ms. 0 or undefined means "no history yet". */
  durationMs: number;
}

/**
 * Asserts every file in `files` is assigned to exactly one shard in `shards`
 * -- no drops (would silently reduce coverage), no duplicates (would
 * silently double-run/double-count a file), and no phantom entries (a shard
 * containing a path that was never in the input). Throws with a diagnostic
 * listing the offending paths (truncated to 10) rather than allowing a
 * silently-incomplete run.
 */
export function assertBinPackCompleteness(files: FileDuration[], shards: string[][]): void {
  const expected = new Set(files.map((f) => f.path));
  const assigned = shards.flat();

  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const p of assigned) {
    if (seen.has(p)) dupes.add(p);
    seen.add(p);
  }
  if (dupes.size > 0) {
    throw new Error(
      `run-tests-main-sharded: binPackFiles produced duplicate file assignment(s) -- a file ` +
        `assigned to more than one shard would be double-run: ${[...dupes].slice(0, 10).join(", ")}` +
        `${dupes.size > 10 ? ", ..." : ""}`
    );
  }

  const missing = [...expected].filter((p) => !seen.has(p));
  if (missing.length > 0) {
    throw new Error(
      `run-tests-main-sharded: binPackFiles dropped ${missing.length} file(s) that were never ` +
        `assigned to any shard -- this would silently reduce test coverage: ` +
        `${missing.slice(0, 10).join(", ")}${missing.length > 10 ? ", ..." : ""}`
    );
  }

  const extra = [...seen].filter((p) => !expected.has(p));
  if (extra.length > 0) {
    throw new Error(
      `run-tests-main-sharded: binPackFiles assigned ${extra.length} file(s) not present in the ` +
        `input file list: ${extra.slice(0, 10).join(", ")}${extra.length > 10 ? ", ..." : ""}`
    );
  }
}

export function binPackFiles(files: FileDuration[], shardCount: number): string[][] {
  const shards = binPackFilesCore(files, shardCount);
  assertBinPackCompleteness(files, shards);
  return shards;
}

// ---------------------------------------------------------------------------
// 2. Concurrency primitive -- `Bun.spawn` fan-out + `Promise.all`, hardened
//    with a native per-process timeout, a shared cross-shard abort, and an
//    empty-command guard (hardening requirements #1 and #3).
// ---------------------------------------------------------------------------

export interface ShardCommand {
  label: string;
  command: string[];
}

export interface ShardOutcome {
  label: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  /** true iff this shard was terminated by a signal (its own native timeout,
   * or a shared abort triggered by a sibling's timeout) rather than exiting
   * normally. */
  timedOut: boolean;
  /**
   * Files this shard actually ran (per its own JUnit report) that were NOT in
   * its assigned file list -- cross-shard leakage (R1 review finding, see
   * `detectShardScopeViolations`). Populated by the orchestration layer after
   * parsing the shard's JUnit output; undefined when no JUnit report was
   * generated for this run (e.g. the caller supplied its own `--reporter`
   * flag) or none were found.
   */
  scopeViolationFiles?: string[];
}

/**
 * Returns the subset of `actualFiles` (files a shard's own JUnit report shows
 * it ran) that are NOT present in `assignedFiles` (the files this shard was
 * bin-packed to run) -- i.e. files that leaked in from elsewhere.
 *
 * Why this is possible at all: `bun test <path>` does NOT treat a positional
 * argument as an exact single-file target. It performs its own default
 * repo-wide test-file discovery (governed by `bunfig.toml`, not this
 * script's `ROOTS`/`EXCLUDE_DIR_PREFIXES`) and matches each given argument as
 * a SUBSTRING against that discovered set. Confirmed empirically against
 * this repo's real suite (R1 review, mt#2990): `packages/domain/src/**`
 * mirrors several `src/**` paths one-for-one (e.g. both
 * `src/composition/container.test.ts` and
 * `packages/domain/src/composition/container.test.ts` exist), and
 * `"src/composition/container.test.ts"` is a literal SUFFIX/substring of
 * `"packages/domain/src/composition/container.test.ts"` -- so a shard given
 * the former as a bare positional arg also runs the latter, regardless of
 * which shard (if any) the latter was actually bin-packed into.
 *
 * The PRIMARY fix (see the orchestration below) prefixes every positional
 * arg with `./`, which anchors the match and empirically eliminates this
 * specific collision class (confirmed: `bun test ./src/composition/container.test.ts`
 * runs exactly one file). This function is the DEFENSE-IN-DEPTH backstop:
 * even with the `./` prefix applied, if some other unanticipated collision
 * class exists, this detects it from data already being parsed (each shard's
 * own JUnit report) and fails the run closed rather than silently accepting
 * inflated/corrupted results -- mirroring this file's `assertBinPackCompleteness`
 * and the project-wide mt#2665 fail-closed philosophy this task already applies
 * elsewhere.
 */
export function detectShardScopeViolations(
  assignedFiles: string[],
  actualFiles: string[]
): string[] {
  const assignedSet = new Set(assignedFiles);
  return actualFiles.filter((f) => !assignedSet.has(f));
}

/**
 * Fans out N shard commands as concurrent `Bun.spawn` child processes and
 * awaits all of them via `Promise.all` -- the plain runtime primitive already
 * used elsewhere in this repo's scripts, not a new process-pool/worker
 * dependency (mt#2981 Outcome, community-practice check).
 *
 * Each child is bounded by `timeoutMs` via Bun.spawn's own native `timeout`
 * option (killed with SIGKILL on expiry) -- more reliable than a manual
 * `setTimeout` race, since it is enforced natively rather than depending on
 * this process's own event-loop scheduling. All shards additionally share one
 * `AbortController`: once any shard is confirmed terminated by a signal (its
 * own timeout, or an earlier sibling's), every other still-running shard is
 * aborted too -- the overall run has already failed at that point, so there
 * is no reason to let healthy-but-slower siblings keep running to completion.
 */
export async function runShardsConcurrently(
  shardCommands: ShardCommand[],
  timeoutMs: number = DEFAULT_SHARD_TIMEOUT_MS
): Promise<ShardOutcome[]> {
  const empty = shardCommands.filter((c) => c.command.length === 0);
  if (empty.length > 0) {
    throw new Error(
      `run-tests-main-sharded: refusing to spawn shard(s) with an empty command array ` +
        `(${empty.map((c) => c.label).join(", ")}) -- this indicates a misconfiguration upstream ` +
        "(e.g. a shard assigned zero files whose command was built anyway); fix the caller rather " +
        "than spawning an invalid process."
    );
  }

  const controller = new AbortController();

  return Promise.all(
    shardCommands.map(async ({ label, command }) => {
      const proc = Bun.spawn(command, {
        stdout: "pipe",
        stderr: "pipe",
        signal: controller.signal,
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        // AGENT=1 mirrors scripts/run-tests-gated.ts's existing convention
        // (keeps bun's reporter in clean non-interactive mode); FORCE_COLOR/
        // NO_COLOR proactively suppress ANSI color at the source, in addition
        // to (not instead of) the defense-in-depth `stripAnsi` parsing below.
        env: { ...process.env, AGENT: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      // `signalCode` is non-null ONLY when the process was terminated by a
      // signal rather than exiting normally -- a real `bun test` completion
      // always calls process.exit() with a numeric code, so this is a more
      // reliable timeout signal than comparing elapsed wall-clock time
      // against `timeoutMs` (which would be sensitive to host scheduling
      // noise near the boundary).
      const timedOut = proc.signalCode !== null;
      if (timedOut) {
        controller.abort(new Error(`shard "${label}" was terminated (timeout or sibling abort)`));
      }
      return { label, stdout, stderr, exitCode, timedOut };
    })
  );
}

// ---------------------------------------------------------------------------
// 3. Aggregation contract -- mirrors the prototype's fail-closed discipline;
//    hardened for ANSI + stream-separation (requirements #2 and #4).
// ---------------------------------------------------------------------------

// Mirrors run-tests-mcp-isolated.ts / scripts/run-tests-gated.ts exactly:
// bun prints singular "1 file" (no trailing "s") for a single-file run -- the
// "s?" is load-bearing. "tests?" (mt#3014 finding) is equally load-bearing:
// bun independently pluralizes the test count too -- a shard whose combined
// output happens to have exactly one test prints "Ran 1 test across ..."
// (singular), confirmed empirically against the pinned bun 1.2.21; without
// the "?" this would fail-close a genuinely-passing shard.
const SUMMARY_PATTERN = /Ran (\d+) tests? across (\d+) files?/;

// Mirrors .github/workflows/ci.yml's / scripts/run-tests-gated.ts's outer
// gate exactly.
const FAIL_LINE_PATTERN = /^ *(\d+) fail$/m;

export interface ShardVerification {
  label: string;
  passed: boolean;
  /** Populated only when passed === false. */
  reason?: string;
  testCount?: number;
  fileCount?: number;
  failCount?: number;
}

/**
 * Verifies ONE shard's outcome using the same fail-closed discipline as
 * run-tests-mcp-isolated.ts / scripts/run-tests-gated.ts (per-shard
 * completion-summary requirement, fail-closed "<N> fail" parsing), hardened
 * per mt#2990's production-hardening requirements:
 *
 *  - A shard terminated by timeout/abort is FAILED immediately, with a
 *    dedicated reason (requirement #1) -- checked before any text parsing.
 *  - Text is stripped of ANSI escapes before either regex runs
 *    (requirement #2).
 *  - Only `outcome.stderr` is parsed -- bun 1.2.21 writes its entire
 *    completion summary there, never to stdout, confirmed empirically at
 *    implementation time; stdout and stderr are never concatenated
 *    (requirement #4).
 */
export function verifyShard(outcome: ShardOutcome): ShardVerification {
  if (outcome.timedOut) {
    return {
      label: outcome.label,
      passed: false,
      reason:
        "shard exceeded its bounded timeout (or was aborted after a sibling did) and was killed -- " +
        "treating as FAILED; a hung shard must never stall the run indefinitely nor pass silently.",
    };
  }

  if (outcome.scopeViolationFiles && outcome.scopeViolationFiles.length > 0) {
    return {
      label: outcome.label,
      passed: false,
      reason:
        `bun ran ${outcome.scopeViolationFiles.length} file(s) not assigned to this shard -- ` +
        "cross-shard substring-match leakage (see detectShardScopeViolations' docstring): " +
        `${outcome.scopeViolationFiles.slice(0, 5).join(", ")}` +
        `${outcome.scopeViolationFiles.length > 5 ? ", ..." : ""} -- failing closed rather than ` +
        "accepting possibly double-counted or cross-contaminated results.",
    };
  }

  const sanitized = stripAnsi(outcome.stderr);

  const summaryMatch = SUMMARY_PATTERN.exec(sanitized);
  if (!summaryMatch) {
    return {
      label: outcome.label,
      passed: false,
      reason:
        `no completion summary printed on stderr (exited ${outcome.exitCode}) -- this is the exact ` +
        "mt#2665 silent-truncation signature; treating as FAILED regardless of exit code.",
    };
  }
  const testCount = Number(summaryMatch[1]);
  const fileCount = Number(summaryMatch[2]);

  const failMatch = FAIL_LINE_PATTERN.exec(sanitized);
  if (!failMatch) {
    return {
      label: outcome.label,
      passed: false,
      reason:
        'completion summary present but the "<N> fail" line could not be found -- ' +
        "fail-closed (mirrors ci.yml), refusing to assume 0 failures.",
      testCount,
      fileCount,
    };
  }
  const failCount = Number(failMatch[1]);
  if (Number.isNaN(failCount)) {
    return {
      label: outcome.label,
      passed: false,
      reason: '"<N> fail" line found but its count could not be parsed -- fail-closed.',
      testCount,
      fileCount,
    };
  }
  if (failCount > 0) {
    return {
      label: outcome.label,
      passed: false,
      reason: `reported ${failCount} failing test(s).`,
      testCount,
      fileCount,
      failCount,
    };
  }
  if (outcome.exitCode !== 0) {
    return {
      label: outcome.label,
      passed: false,
      reason:
        `completion summary present with 0 reported failures, but exited ${outcome.exitCode} -- ` +
        "the non-zero exit contradicts the summary; treating as FAILED rather than papering over " +
        "the discrepancy.",
      testCount,
      fileCount,
      failCount,
    };
  }

  return { label: outcome.label, passed: true, testCount, fileCount, failCount };
}

export interface AggregateResult {
  passed: boolean;
  shardResults: ShardVerification[];
  totalTests: number;
  totalFiles: number;
  totalFail: number;
  /** Synthesized in bun's own exact textual shape, for downstream grep
   * compatibility (hardening requirement #6). */
  summaryLine: string;
  failLine: string;
}

/**
 * Verifies every shard independently, then aggregates: the overall run PASSES
 * only if every shard passed. On success, synthesizes a unified
 * completion-summary line in bun's own exact textual shape
 * ("Ran N tests across M files.") plus a "<N> fail" line, so a downstream
 * grep-based gate (.github/workflows/ci.yml's "Test" step, mirrored by
 * .husky/pre-push via scripts/run-tests-gated.ts) would keep matching
 * unchanged if this aggregator's combined output were ever piped through
 * that same gate.
 */
export function aggregateShardResults(outcomes: ShardOutcome[]): AggregateResult {
  const shardResults = outcomes.map(verifyShard);
  const passed = shardResults.every((r) => r.passed);
  const totalTests = shardResults.reduce((s, r) => s + (r.testCount ?? 0), 0);
  const totalFiles = shardResults.reduce((s, r) => s + (r.fileCount ?? 0), 0);
  const totalFail = shardResults.reduce((s, r) => s + (r.failCount ?? 0), 0);

  return {
    passed,
    shardResults,
    totalTests,
    totalFiles,
    totalFail,
    summaryLine: `Ran ${totalTests} tests across ${totalFiles} file${totalFiles === 1 ? "" : "s"}.`,
    failLine: `${totalFail} fail`,
  };
}

// ---------------------------------------------------------------------------
// Duration cache -- self-updating `{ [filePath]: durationMs }` JSON map.
// ---------------------------------------------------------------------------

export type DurationCache = Record<string, number>;

export function readDurationCache(path: string = DURATION_CACHE_PATH): DurationCache {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readTextFileSync(path));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as DurationCache;
    }
    console.error(
      `run-tests-main-sharded: duration cache at ${path} was not a JSON object -- ignoring and ` +
        "starting cold (round-robin fallback)."
    );
  } catch (err) {
    console.error(
      `run-tests-main-sharded: could not read/parse duration cache at ${path} ` +
        `(${err instanceof Error ? err.message : String(err)}) -- ignoring and starting cold ` +
        "(round-robin fallback)."
    );
  }
  return {};
}

export function writeDurationCache(cache: DurationCache, path: string = DURATION_CACHE_PATH): void {
  try {
    const sortedKeys = Object.keys(cache).sort();
    writeFileSync(path, `${JSON.stringify(cache, sortedKeys, 2)}\n`);
  } catch (err) {
    console.error(
      `run-tests-main-sharded: failed to persist duration cache to ${path} ` +
        `(${err instanceof Error ? err.message : String(err)}) -- next run falls back to ` +
        "round-robin for files without history. Non-fatal."
    );
  }
}

/**
 * Parses every readable JUnit XML fragment in `junitPaths` (one per shard,
 * reusing scripts/analyze-test-timing.ts's `parseTestcases` rather than
 * re-deriving XML parsing) and sums per-file testcase time in SECONDS. A
 * missing or unparseable fragment (e.g. a shard that crashed before bun's
 * JUnit reporter could flush) is skipped silently -- this is a best-effort
 * performance optimization for the NEXT run's bin-packing, never a
 * pass/fail signal, so it must never throw or affect the aggregate result.
 */
export function collectShardDurationsSec(junitPaths: string[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const path of junitPaths) {
    if (!existsSync(path)) continue;
    let cases: TestCase[];
    try {
      cases = parseTestcases(readTextFileSync(path));
    } catch {
      continue;
    }
    for (const tc of cases) {
      totals.set(tc.file, (totals.get(tc.file) ?? 0) + tc.timeSec);
    }
  }
  return totals;
}

/**
 * Returns the set of unique file paths ONE shard's own JUnit report shows it
 * actually ran (reusing `parseTestcases`, not re-deriving XML parsing), or
 * `undefined` if the report is missing or unparseable. Feeds
 * `detectShardScopeViolations` -- the cross-shard-leakage defense-in-depth
 * backstop (R1 review, mt#2990). Best-effort like `collectShardDurationsSec`:
 * never throws.
 */
export function collectShardActualFiles(junitPath: string): string[] | undefined {
  if (!existsSync(junitPath)) return undefined;
  try {
    const cases = parseTestcases(readTextFileSync(junitPath));
    return [...new Set(cases.map((c) => c.file))];
  } catch {
    return undefined;
  }
}

export function mergeDurationsIntoCache(
  cache: DurationCache,
  freshSec: Map<string, number>
): DurationCache {
  const next = { ...cache };
  for (const [file, sec] of freshSec) {
    next[file] = Math.round(sec * 1000);
  }
  return next;
}

// ---------------------------------------------------------------------------
// Orchestration (import.meta.main-guarded, mirrors run-tests-main.ts's own
// guard so this file can also be imported for its exports without triggering
// a real test run as a side effect).
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const files = discoverTestFiles();

  if (files.length === 0) {
    console.error(
      "run-tests-main-sharded.ts: found zero test files -- this is almost certainly a bug in " +
        "run-tests-main.ts's ROOTS/exclusion list, not a legitimately empty suite. Refusing to " +
        "report a false-green result."
    );
    process.exit(1);
  }

  const shardCount = resolveShardCount(files.length);
  const shardTimeoutMs = resolveShardTimeoutMs();
  const cache = readDurationCache();
  const fileDurations: FileDuration[] = files.map((f) => ({ path: f, durationMs: cache[f] ?? 0 }));
  const shards = binPackFiles(fileDurations, shardCount).filter((s) => s.length > 0);

  if (shards.length === 0) {
    // Unreachable given the files.length === 0 check above, but fail loud
    // rather than silently proceeding with zero shards if it ever happens.
    console.error("run-tests-main-sharded.ts: bin-packing produced zero non-empty shards -- bug.");
    process.exit(1);
  }

  const rawExtraArgs = process.argv.slice(2);
  const callerSuppliesReporter = rawExtraArgs.some(
    (a) =>
      a === "--reporter" ||
      a.startsWith("--reporter=") ||
      a === "--reporter-outfile" ||
      a.startsWith("--reporter-outfile=")
  );
  if (callerSuppliesReporter) {
    console.error(
      "run-tests-main-sharded.ts: a --reporter/--reporter-outfile flag was passed through -- this " +
        "script reserves those flags for its own per-shard JUnit capture (used only to update the " +
        "duration cache). Skipping this run's duration-cache update; your reporter flag is " +
        "forwarded to every shard as-is."
    );
  }

  const shardTmpDir = callerSuppliesReporter
    ? undefined
    : mkdtempSync(join(tmpdir(), "run-tests-main-sharded-"));

  const shardCommands: ShardCommand[] = shards.map((shardFiles, i) => {
    const junitOutfile = shardTmpDir ? join(shardTmpDir, `shard-${i}.xml`) : undefined;
    const command = [
      "bun",
      "test",
      "--preload",
      "./tests/setup.ts",
      "--timeout=15000",
      ...(junitOutfile ? ["--reporter=junit", `--reporter-outfile=${junitOutfile}`] : []),
      ...rawExtraArgs,
      // `./`-prefixed (R1 review, mt#2990): `bun test <path>` matches its
      // positional args as SUBSTRINGS against its own default repo-wide
      // discovery, not as exact single-file targets. Confirmed empirically
      // against this repo's real suite: `packages/domain/src/**` mirrors
      // several `src/**` paths one-for-one, and an un-prefixed
      // `"src/composition/container.test.ts"` is a literal substring of
      // `"packages/domain/src/composition/container.test.ts"` -- so an
      // un-prefixed shard arg can incidentally run a sibling shard's file
      // too. The leading `./` anchors the match and eliminates this
      // collision class (verified: `bun test ./src/composition/container.test.ts`
      // runs exactly the one intended file); bun's own JUnit `file` attribute
      // still reports the un-prefixed form, so this has no effect on the
      // duration-cache key format (verified). `detectShardScopeViolations`
      // below is the defense-in-depth backstop for anything this doesn't
      // catch.
      ...shardFiles.map((f) => `./${f}`),
    ];
    return { label: `shard-${i}`, command };
  });

  console.log(
    `run-tests-main-sharded.ts: ${files.length} file(s) across ${shardCommands.length} shard(s) ` +
      `(auto-detected: os.cpus().length=${cpus().length}; override with TEST_SHARD_COUNT), per-shard ` +
      `timeout ${shardTimeoutMs}ms (override with TEST_SHARD_TIMEOUT_MS)...\n`
  );
  shards.forEach((s, i) => console.log(`  shard-${i}: ${s.length} file(s)`));
  console.log("");

  const startedAt = Date.now();
  const rawOutcomes = await runShardsConcurrently(shardCommands, shardTimeoutMs);
  const wallClockMs = Date.now() - startedAt;

  // Re-emit each shard's own output so a human/CI log still shows real
  // failures and their context, not just the synthesized aggregate below.
  for (const o of rawOutcomes) {
    console.log(`\n=== ${o.label} ===`);
    if (o.stdout) process.stdout.write(o.stdout);
    if (o.stderr) process.stderr.write(o.stderr);
    if (o.timedOut) {
      console.error(
        `::error::${o.label} was terminated (own timeout of ${shardTimeoutMs}ms, or aborted after a sibling's).`
      );
    }
  }

  // Defense-in-depth (R1 review, mt#2990): even with the `./`-prefix fix
  // above, detect from each shard's own JUnit report whether it ran any file
  // it wasn't assigned (cross-shard substring-match leakage) and fail that
  // shard closed rather than silently accept inflated/corrupted results.
  const outcomes = shardTmpDir
    ? rawOutcomes.map((o, i) => {
        const actualFiles = collectShardActualFiles(join(shardTmpDir, `shard-${i}.xml`));
        if (!actualFiles) return o;
        // `shards` and `rawOutcomes` are index-aligned by construction (one shard
        // array per shard command). Unlike the `!actualFiles` check above -- a
        // legitimately best-effort, sometimes-missing report -- `shards[i]` being
        // undefined here means that invariant broke. Fail loudly (mirrors
        // `binPackFiles`'s invariant guards in run-tests-sharded-prototype.ts)
        // rather than silently skip the scope-violation check, which would mask
        // real cross-shard leakage instead of detecting it.
        const assignedFiles = shards[i];
        if (!assignedFiles) {
          throw new Error(
            `run-tests-main-sharded: invariant violated -- shard ${i} missing from the bin-packed ` +
              `shards array (shards.length=${shards.length}, rawOutcomes.length=${rawOutcomes.length}). ` +
              "shards and rawOutcomes must be index-aligned by construction; this should never happen."
          );
        }
        const violations = detectShardScopeViolations(assignedFiles, actualFiles);
        return violations.length > 0 ? { ...o, scopeViolationFiles: violations } : o;
      })
    : rawOutcomes;

  const result = aggregateShardResults(outcomes);

  if (shardTmpDir) {
    const durationsSec = collectShardDurationsSec(
      shardCommands.map((_, i) => join(shardTmpDir, `shard-${i}.xml`))
    );
    writeDurationCache(mergeDurationsIntoCache(cache, durationsSec));
    try {
      rmSync(shardTmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup only; a leftover tmp dir is not a correctness issue
    }
  }

  console.log(
    `\nrun-tests-main-sharded.ts: wall-clock ${wallClockMs}ms across ${shardCommands.length} shard(s).`
  );
  for (const r of result.shardResults) {
    if (!r.passed) console.error(`::error::${r.label}: ${r.reason}`);
  }
  // Synthesized in bun's own exact textual shape -- see
  // run-tests-main-sharded.test.ts's contract-fidelity tests (hardening
  // requirement #6) for the exact grep patterns this must keep matching.
  console.log(result.summaryLine);
  console.log(result.failLine);

  process.exit(result.passed ? 0 : 1);
}
