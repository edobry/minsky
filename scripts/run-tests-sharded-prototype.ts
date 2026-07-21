#!/usr/bin/env bun
/**
 * mt#2981 design-pass prototype: parallel-sharding for scripts/run-tests-main.ts.
 *
 * NOT wired into `bun run test`, CI, or `.husky/pre-push` -- this script exists solely
 * to demonstrate, with fast fake fixtures (not the real 651-file suite), that a
 * multi-shard aggregation contract can preserve mt#2665's "missing completion-summary
 * line = FAILURE" discipline per shard even when shards run CONCURRENTLY via
 * `Bun.spawn` rather than sequentially. See scripts/run-tests-mcp-isolated.ts for the
 * sequential-isolation precedent this generalizes to concurrent execution.
 *
 * If mt#2981's design pass recommends building the production sharded runner, that
 * work is a SEPARATE follow-up task (do not extend this file into that rewrite --
 * see the mt#2981 spec `## Outcome` section for the filed follow-up task id).
 *
 * Exercises three design decisions from the mt#2981 Outcome:
 *
 *   1. Shard-splitting strategy: greedy LPT (longest-processing-time-first) bin
 *      packing by historical per-file duration, falling back to round-robin for
 *      files with no timing history (cold start) -- see `binPackFiles`.
 *   2. Concurrency primitive: `Bun.spawn` fan-out + `Promise.all`, no new
 *      dependency -- see `runShardsConcurrently`.
 *   3. Aggregation contract: per-shard "Ran N tests across M files" verification
 *      (mirrors run-tests-mcp-isolated.ts) + fail-closed "<N> fail" parsing (mirrors
 *      .github/workflows/ci.yml's outer gate), then a synthesized unified summary
 *      line so a downstream grep-based gate would keep matching unchanged if this
 *      were ever wired into that path -- see `verifyShard` / `aggregateShardResults`.
 *
 * See scripts/run-tests-sharded-prototype.test.ts for the acceptance-test
 * demonstration required by the mt#2981 spec: a deliberately-truncated shard (exits
 * 0, prints no completion summary -- the exact mt#2665 signature) is treated as
 * FAILED, not passed through as green.
 */

// ---------------------------------------------------------------------------
// 1. Shard-splitting strategy
// ---------------------------------------------------------------------------

export interface FileDuration {
  path: string;
  /** Historical duration in ms, from a prior run's JUnit report (see
   * scripts/analyze-test-timing.ts). 0 or undefined means "no history yet". */
  durationMs: number;
}

/**
 * Greedy longest-processing-time-first (LPT) bin packing: sort files with known
 * historical duration in descending order, then repeatedly assign the next file to
 * whichever shard currently has the LOWEST accumulated time. This is the
 * community-standard heuristic for duration-aware test sharding (Tuist, Vitest
 * duration-aware-sharding proposal, Pest v4.6 time-based sharding all converge on
 * this same greedy-min-bucket approach; see mt#2981 spec Outcome for citations).
 *
 * Files with no timing history (durationMs <= 0, e.g. a newly-added test file, or
 * the very first run before any timing cache exists) are round-robin distributed
 * across shards in their given order -- NOT bin-packed by size/alphabetical-
 * contiguous split, which would risk clustering an entire slow directory into one
 * shard. Callers should pass files pre-sorted (e.g. alphabetically, matching
 * run-tests-main.ts's own `files.sort()`) for deterministic round-robin assignment.
 */
export function binPackFiles(files: FileDuration[], shardCount: number): string[][] {
  if (shardCount < 1) {
    throw new Error(`binPackFiles: shardCount must be >= 1, got ${shardCount}`);
  }

  const shards: string[][] = Array.from({ length: shardCount }, () => []);
  const shardTotals: number[] = new Array(shardCount).fill(0);

  const known = files
    .filter((f) => f.durationMs > 0)
    .slice()
    .sort((a, b) => b.durationMs - a.durationMs);
  const unknown = files.filter((f) => !(f.durationMs > 0));

  for (const file of known) {
    let minIdx = 0;
    for (let i = 1; i < shardCount; i++) {
      if (shardTotals[i] < shardTotals[minIdx]) {
        minIdx = i;
      }
    }
    shards[minIdx].push(file.path);
    shardTotals[minIdx] += file.durationMs;
  }

  unknown.forEach((file, i) => {
    shards[i % shardCount].push(file.path);
  });

  return shards;
}

// ---------------------------------------------------------------------------
// 2. Concurrency primitive
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
}

/**
 * Fans out N shard commands as concurrent `Bun.spawn` child processes and awaits
 * all of them via `Promise.all` -- the plain runtime primitive already used
 * elsewhere in this repo's scripts (e.g. scripts/measure-source-only.ts,
 * scripts/smoke-session-attachment.ts), not a new process-pool/worker dependency.
 * Community practice for simple parallel subprocess fan-out in Node/Bun scripts is
 * exactly this shape; a library would be over-engineering relative to the need
 * (see mt#2981 spec Outcome, community-practice check).
 *
 * Each child's stdout/stderr is captured (not "inherit") so concurrent shards don't
 * interleave chaotically on the terminal -- a real production runner would print
 * each shard's captured output sequentially as it completes, mirroring
 * run-tests-mcp-isolated.ts's capture-then-print discipline.
 */
export async function runShardsConcurrently(
  shardCommands: ShardCommand[]
): Promise<ShardOutcome[]> {
  return Promise.all(
    shardCommands.map(async ({ label, command }) => {
      const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { label, stdout, stderr, exitCode };
    })
  );
}

// ---------------------------------------------------------------------------
// 3. Aggregation contract
// ---------------------------------------------------------------------------

// Mirrors run-tests-mcp-isolated.ts exactly: bun prints singular "1 file" (no
// trailing "s") for a single-file run -- the "s?" is load-bearing.
const SUMMARY_PATTERN = /Ran (\d+) tests across (\d+) files?/;

// Mirrors .github/workflows/ci.yml's outer gate exactly.
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
 * Verifies ONE shard's outcome using the exact same fail-closed discipline as
 * run-tests-mcp-isolated.ts (per-shard completion-summary requirement) plus
 * ci.yml's outer gate (fail-closed "<N> fail" parsing). A shard that exits 0 but
 * prints no completion summary -- the exact mt#2665 silent-truncation signature --
 * is FAILED regardless of exit code.
 */
export function verifyShard(outcome: ShardOutcome): ShardVerification {
  const combined = `${outcome.stdout}\n${outcome.stderr}`;

  const summaryMatch = SUMMARY_PATTERN.exec(combined);
  if (!summaryMatch) {
    return {
      label: outcome.label,
      passed: false,
      reason:
        `no completion summary printed (exited ${outcome.exitCode}) -- this is the exact ` +
        "mt#2665 silent-truncation signature; treating as FAILED regardless of exit code.",
    };
  }
  const testCount = Number(summaryMatch[1]);
  const fileCount = Number(summaryMatch[2]);

  const failMatch = FAIL_LINE_PATTERN.exec(combined);
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
        "the non-zero exit contradicts the summary; treating as FAILED rather than papering " +
        "over the discrepancy.",
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
  /** Synthesized in bun's own exact textual shape, for downstream grep compatibility. */
  summaryLine: string;
  failLine: string;
}

/**
 * Verifies every shard independently, then aggregates: the overall run PASSES only
 * if every shard passed. On success, synthesizes a unified completion-summary line
 * in bun's own exact textual shape ("Ran N tests across M files.") plus a "<N> fail"
 * line, so a downstream grep-based gate (.github/workflows/ci.yml's "Test" step,
 * mirrored by .husky/pre-push per mt#2716) would keep matching unchanged if this
 * aggregator's combined output were ever piped through that same gate.
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
// Self-demo (manual `bun scripts/run-tests-sharded-prototype.ts` invocation)
// ---------------------------------------------------------------------------

if (import.meta.main) {
  console.log(
    "run-tests-sharded-prototype: fake 3-shard demo (NOT the real suite) -- shard-c is " +
      "deliberately truncated to demonstrate the aggregation contract.\n"
  );

  const demo = await runShardsConcurrently([
    {
      label: "shard-a (healthy)",
      command: [
        "bun",
        "-e",
        'console.log("5 pass\\n0 fail\\n10 expect() calls\\nRan 5 tests across 2 files. [12.00ms]")',
      ],
    },
    {
      label: "shard-b (healthy)",
      command: [
        "bun",
        "-e",
        'console.log("3 pass\\n0 fail\\n6 expect() calls\\nRan 3 tests across 1 file. [8.00ms]")',
      ],
    },
    {
      label: "shard-c (truncated -- simulates mt#2665)",
      command: [
        "bun",
        "-e",
        'console.log("{\\"message\\":\\"mcp_disconnect\\"}"); process.exit(0)',
      ],
    },
  ]);

  const result = aggregateShardResults(demo);
  console.log(JSON.stringify(result, null, 2));
  console.log(
    result.passed
      ? "\nOVERALL: PASS (unexpected for this demo -- shard-c should have failed it)"
      : "\nOVERALL: FAILED (expected -- shard-c's silent truncation correctly failed the whole run)"
  );
  process.exit(result.passed ? 0 : 1);
}
