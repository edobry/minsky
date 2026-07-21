/* eslint-disable custom/no-real-fs-in-tests -- the duration-cache describe block below tests
   real fs read/write round-tripping (readDurationCache/writeDurationCache/
   collectShardDurationsSec are thin wrappers over node:fs by design); exercising real fs I/O
   IS the contract under test, mirroring src/cockpit/prod-state-cache.test.ts's identical
   justification for the same rule. */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  aggregateShardResults,
  assertBinPackCompleteness,
  binPackFiles,
  collectShardDurationsSec,
  mergeDurationsIntoCache,
  readDurationCache,
  resolveShardCount,
  resolveShardTimeoutMs,
  runShardsConcurrently,
  stripAnsi,
  verifyShard,
  writeDurationCache,
  type ShardOutcome,
} from "./run-tests-main-sharded";

// ---------------------------------------------------------------------------
// resolveShardCount / resolveShardTimeoutMs
// ---------------------------------------------------------------------------

describe("resolveShardCount", () => {
  const originalOverride = process.env.TEST_SHARD_COUNT;
  afterEach(() => {
    if (originalOverride === undefined) delete process.env.TEST_SHARD_COUNT;
    else process.env.TEST_SHARD_COUNT = originalOverride;
  });

  it("defaults to the provided cpu count, capped to the file count", () => {
    delete process.env.TEST_SHARD_COUNT;
    expect(resolveShardCount(100, 8)).toBe(8);
    expect(resolveShardCount(4, 8)).toBe(4); // capped: never more shards than files
  });

  it("never returns less than 1", () => {
    delete process.env.TEST_SHARD_COUNT;
    expect(resolveShardCount(0, 8)).toBe(1);
  });

  it("respects a valid TEST_SHARD_COUNT override", () => {
    process.env.TEST_SHARD_COUNT = "3";
    expect(resolveShardCount(100, 16)).toBe(3);
  });

  it("caps an override larger than the file count", () => {
    process.env.TEST_SHARD_COUNT = "50";
    expect(resolveShardCount(5, 16)).toBe(5);
  });

  it("throws on a non-integer or non-positive override", () => {
    process.env.TEST_SHARD_COUNT = "not-a-number";
    expect(() => resolveShardCount(10, 8)).toThrow();
    process.env.TEST_SHARD_COUNT = "0";
    expect(() => resolveShardCount(10, 8)).toThrow();
    process.env.TEST_SHARD_COUNT = "-1";
    expect(() => resolveShardCount(10, 8)).toThrow();
    process.env.TEST_SHARD_COUNT = "2.5";
    expect(() => resolveShardCount(10, 8)).toThrow();
  });
});

describe("resolveShardTimeoutMs", () => {
  const originalOverride = process.env.TEST_SHARD_TIMEOUT_MS;
  afterEach(() => {
    if (originalOverride === undefined) delete process.env.TEST_SHARD_TIMEOUT_MS;
    else process.env.TEST_SHARD_TIMEOUT_MS = originalOverride;
  });

  it("defaults to 5 minutes when unset", () => {
    delete process.env.TEST_SHARD_TIMEOUT_MS;
    expect(resolveShardTimeoutMs()).toBe(5 * 60 * 1000);
  });

  it("respects a valid override", () => {
    process.env.TEST_SHARD_TIMEOUT_MS = "12345";
    expect(resolveShardTimeoutMs()).toBe(12345);
  });

  it("throws on a non-positive or non-numeric override", () => {
    process.env.TEST_SHARD_TIMEOUT_MS = "0";
    expect(() => resolveShardTimeoutMs()).toThrow();
    process.env.TEST_SHARD_TIMEOUT_MS = "-5";
    expect(() => resolveShardTimeoutMs()).toThrow();
    process.env.TEST_SHARD_TIMEOUT_MS = "nope";
    expect(() => resolveShardTimeoutMs()).toThrow();
  });
});

// ---------------------------------------------------------------------------
// stripAnsi (production-hardening requirement #2)
// ---------------------------------------------------------------------------

describe("stripAnsi", () => {
  it("strips ANSI color codes captured from a REAL `FORCE_COLOR=1 bun test` failure line", () => {
    // Captured empirically during mt#2990 implementation: `1 fail` wrapped in
    // a red-color escape, with a reset code immediately after "fail" -- this
    // is the exact byte sequence that defeats FAIL_LINE_PATTERN's `$` anchor
    // if not stripped first.
    const raw = "\x1b[31m 1 fail\x1b[0m";
    expect(stripAnsi(raw)).toBe(" 1 fail");
  });

  it("strips ANSI codes from a colorized completion-summary line without altering the text", () => {
    const raw = "Ran \x1b[1m5\x1b[0m tests across \x1b[1m2\x1b[0m files. \x1b[2m[12.00ms]\x1b[0m";
    expect(stripAnsi(raw)).toBe("Ran 5 tests across 2 files. [12.00ms]");
  });

  it("is a no-op on plain text", () => {
    const plain = "5 pass\n0 fail\nRan 5 tests across 2 files.";
    expect(stripAnsi(plain)).toBe(plain);
  });
});

// ---------------------------------------------------------------------------
// Bin-packing completeness assertion (hardening requirement #5)
// ---------------------------------------------------------------------------

describe("assertBinPackCompleteness", () => {
  const files = [
    { path: "a.test.ts", durationMs: 10 },
    { path: "b.test.ts", durationMs: 10 },
    { path: "c.test.ts", durationMs: 10 },
  ];

  it("does not throw for a complete, non-duplicated assignment", () => {
    expect(() =>
      assertBinPackCompleteness(files, [["a.test.ts"], ["b.test.ts", "c.test.ts"]])
    ).not.toThrow();
  });

  it("throws when a file is dropped (never assigned to any shard)", () => {
    expect(() => assertBinPackCompleteness(files, [["a.test.ts"], ["b.test.ts"]])).toThrow(
      /dropped/
    );
  });

  it("throws when a file is duplicated across shards", () => {
    expect(() =>
      assertBinPackCompleteness(files, [
        ["a.test.ts", "b.test.ts"],
        ["b.test.ts", "c.test.ts"],
      ])
    ).toThrow(/duplicate/);
  });

  it("throws when a shard contains a phantom file not present in the input", () => {
    expect(() =>
      assertBinPackCompleteness(files, [["a.test.ts", "b.test.ts", "c.test.ts", "ghost.test.ts"]])
    ).toThrow(/not present in the input/);
  });
});

describe("binPackFiles (production wrapper over the prototype's validated LPT algorithm)", () => {
  it("balances known-duration files and asserts completeness", () => {
    const files = [
      { path: "a.test.ts", durationMs: 5 },
      { path: "b.test.ts", durationMs: 5 },
      { path: "c.test.ts", durationMs: 5 },
      { path: "d.test.ts", durationMs: 5 },
    ];
    const shards = binPackFiles(files, 2);
    expect(shards).toHaveLength(2);
    const allAssigned = shards.flat().sort();
    expect(allAssigned).toEqual(["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts"]);
  });

  it("delegates the shardCount<1 guard to the core algorithm", () => {
    expect(() => binPackFiles([], 0)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// verifyShard -- ANSI + stream-separation hardening (requirements #2, #4)
// ---------------------------------------------------------------------------

describe("verifyShard", () => {
  it("passes a healthy shard using only stderr", () => {
    const healthy: ShardOutcome = {
      label: "shard-a",
      stdout: "bun test v1.2.21 (7c45ed97)\n",
      stderr: "5 pass\n0 fail\n10 expect() calls\nRan 5 tests across 2 files. [12.00ms]\n",
      exitCode: 0,
      timedOut: false,
    };
    const v = verifyShard(healthy);
    expect(v.passed).toBe(true);
    expect(v.testCount).toBe(5);
    expect(v.fileCount).toBe(2);
    expect(v.failCount).toBe(0);
  });

  it("parses correctly even when stderr is wrapped in ANSI color codes", () => {
    const colored: ShardOutcome = {
      label: "shard-colored",
      stdout: "",
      stderr:
        "\x1b[32m 4 pass\x1b[0m\n\x1b[31m 1 fail\x1b[0m\n1 expect() calls\nRan 5 tests across 2 files.\n",
      exitCode: 1,
      timedOut: false,
    };
    const v = verifyShard(colored);
    expect(v.passed).toBe(false);
    expect(v.failCount).toBe(1);
  });

  it("uses ONLY stderr -- a misleading/fabricated summary on stdout is ignored", () => {
    const misleadingStdout: ShardOutcome = {
      label: "shard-b",
      // A fabricated, WRONG summary on stdout must never be trusted.
      stdout: "Ran 999 tests across 1 files.\n0 fail\n",
      stderr: "", // real bun output never leaves stderr empty on a genuine run
      exitCode: 0,
      timedOut: false,
    };
    const v = verifyShard(misleadingStdout);
    expect(v.passed).toBe(false);
    expect(v.reason).toMatch(/no completion summary/);
  });

  it("FAILS a shard with no completion summary on stderr even though it exited 0 (mt#2665 signature)", () => {
    const truncated: ShardOutcome = {
      label: "shard-c",
      stdout: "",
      stderr: '{"message":"mcp_disconnect","serverName":"srv"}\n',
      exitCode: 0,
      timedOut: false,
    };
    const v = verifyShard(truncated);
    expect(v.passed).toBe(false);
    expect(v.reason).toMatch(/no completion summary/);
  });

  it("fails closed when the summary is present but the fail-count line is missing", () => {
    const malformed: ShardOutcome = {
      label: "shard-d",
      stdout: "",
      stderr: "Ran 2 tests across 1 file. [1.00ms]\n",
      exitCode: 0,
      timedOut: false,
    };
    const v = verifyShard(malformed);
    expect(v.passed).toBe(false);
    expect(v.reason).toMatch(/fail-closed/);
  });

  it("fails a shard whose non-zero exit contradicts a clean-looking summary", () => {
    const contradictory: ShardOutcome = {
      label: "shard-f",
      stdout: "",
      stderr: "2 pass\n0 fail\n4 expect() calls\nRan 2 tests across 1 file. [2.00ms]\n",
      exitCode: 1,
      timedOut: false,
    };
    const v = verifyShard(contradictory);
    expect(v.passed).toBe(false);
    expect(v.reason).toMatch(/non-zero exit contradicts/);
  });

  it("handles the singular 'file' form (no trailing s)", () => {
    const single: ShardOutcome = {
      label: "shard-g",
      stdout: "",
      stderr: "1 pass\n0 fail\n2 expect() calls\nRan 1 tests across 1 file. [1.00ms]\n",
      exitCode: 0,
      timedOut: false,
    };
    expect(verifyShard(single).passed).toBe(true);
  });

  it("FAILS immediately on timedOut, without inspecting output text (requirement #1)", () => {
    const timedOut: ShardOutcome = {
      label: "shard-hung",
      // Even if the output happens to LOOK healthy, timedOut must dominate.
      stdout: "",
      stderr: "5 pass\n0 fail\nRan 5 tests across 2 files.\n",
      exitCode: 0,
      timedOut: true,
    };
    const v = verifyShard(timedOut);
    expect(v.passed).toBe(false);
    expect(v.reason).toMatch(/timeout/);
  });
});

// ---------------------------------------------------------------------------
// aggregateShardResults -- contract fidelity with the CI/pre-push grep gate
// (hardening requirement #6)
// ---------------------------------------------------------------------------

describe("aggregateShardResults", () => {
  const healthyA: ShardOutcome = {
    label: "shard-a",
    stdout: "",
    stderr: "5 pass\n0 fail\n10 expect() calls\nRan 5 tests across 2 files. [12.00ms]\n",
    exitCode: 0,
    timedOut: false,
  };
  const healthyB: ShardOutcome = {
    label: "shard-b",
    stdout: "",
    stderr: "3 pass\n0 fail\n6 expect() calls\nRan 3 tests across 1 file. [8.00ms]\n",
    exitCode: 0,
    timedOut: false,
  };
  const truncated: ShardOutcome = {
    label: "shard-c",
    stdout: "",
    stderr: '{"message":"mcp_disconnect","serverName":"srv"}\n',
    exitCode: 0,
    timedOut: false,
  };

  it("aggregates all-healthy shards to an overall PASS with correct sums", () => {
    const result = aggregateShardResults([healthyA, healthyB]);
    expect(result.passed).toBe(true);
    expect(result.totalTests).toBe(8);
    expect(result.totalFiles).toBe(3);
    expect(result.totalFail).toBe(0);
  });

  it("mt#2981/mt#2990 acceptance test: a truncated shard mixed with healthy shards fails the WHOLE run", () => {
    const result = aggregateShardResults([healthyA, truncated, healthyB]);
    expect(result.passed).toBe(false);
    expect(result.shardResults.find((r) => r.label === "shard-c")?.passed).toBe(false);
    expect(result.shardResults.find((r) => r.label === "shard-a")?.passed).toBe(true);
    expect(result.shardResults.find((r) => r.label === "shard-b")?.passed).toBe(true);
  });

  it("synthesized summaryLine matches .github/workflows/ci.yml's exact grep pattern", () => {
    const result = aggregateShardResults([healthyA, healthyB]);
    // Literal pattern from .github/workflows/ci.yml's "Test" step (and
    // scripts/run-tests-gated.ts's evaluateBunTestSummary, which pre-push
    // shares) -- requirement #6.
    expect(/Ran [0-9]+ tests across [0-9]+ files?/.test(result.summaryLine)).toBe(true);
  });

  it("synthesized failLine matches .github/workflows/ci.yml's exact grep pattern", () => {
    const result = aggregateShardResults([healthyA, healthyB]);
    // Literal pattern: `grep -E "^ *[0-9]+ fail$"` from ci.yml / run-tests-gated.ts.
    expect(/^ *[0-9]+ fail$/.test(result.failLine)).toBe(true);
  });

  it("singular-file summaryLine still matches the ci.yml pattern (files? load-bearing)", () => {
    const result = aggregateShardResults([healthyB]);
    expect(result.summaryLine).toBe("Ran 3 tests across 1 file.");
    expect(/Ran [0-9]+ tests across [0-9]+ files?/.test(result.summaryLine)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runShardsConcurrently -- empty-command guard (#3) + timeout/abort (#1)
// ---------------------------------------------------------------------------

describe("runShardsConcurrently", () => {
  it("throws synchronously for an empty command array WITHOUT spawning anything", async () => {
    await expect(runShardsConcurrently([{ label: "broken", command: [] }])).rejects.toThrow(
      /empty command array/
    );
  });

  it("fails the aggregated run when one real subprocess silently truncates", async () => {
    const outcomes = await runShardsConcurrently([
      {
        label: "shard-healthy",
        command: [
          "bun",
          "-e",
          'console.error("2 pass\\n0 fail\\n4 expect() calls\\nRan 2 tests across 1 file. [3.00ms]")',
        ],
      },
      {
        label: "shard-truncated",
        command: [
          "bun",
          "-e",
          'console.log("{\\"message\\":\\"mcp_disconnect\\"}"); process.exit(0)',
        ],
      },
    ]);
    expect(outcomes).toHaveLength(2);
    const result = aggregateShardResults(outcomes);
    expect(result.passed).toBe(false);
    expect(result.shardResults.find((r) => r.label === "shard-truncated")?.passed).toBe(false);
    expect(result.shardResults.find((r) => r.label === "shard-healthy")?.passed).toBe(true);
  });

  it("aborts hung shards (and their siblings) rather than letting them stall past the timeout (requirement #1)", async () => {
    const timeoutMs = 200;
    const sleepMs = 5000;
    const commands = [
      {
        label: "hung-a",
        command: ["bun", "-e", `await Bun.sleep(${sleepMs}); console.log("should never print")`],
      },
      {
        label: "hung-b",
        command: ["bun", "-e", `await Bun.sleep(${sleepMs}); console.log("should never print")`],
      },
    ];
    const start = Date.now();
    const outcomes = await runShardsConcurrently(commands, timeoutMs);
    const elapsed = Date.now() - start;

    // Well under the full sleep duration -- proves both were killed near
    // the timeout boundary rather than allowed to run to completion.
    expect(elapsed).toBeLessThan(sleepMs - 1000);
    expect(outcomes.every((o) => o.timedOut)).toBe(true);
    expect(outcomes.every((o) => !o.stdout.includes("should never print"))).toBe(true);
    expect(aggregateShardResults(outcomes).passed).toBe(false);
  }, 10000);

  it("does not flag a healthy, fast shard as timed out under a generous timeout", async () => {
    const outcomes = await runShardsConcurrently(
      [
        {
          label: "fast",
          command: [
            "bun",
            "-e",
            'console.error("1 pass\\n0 fail\\n1 expect() calls\\nRan 1 tests across 1 file.")',
          ],
        },
      ],
      60_000
    );
    expect(outcomes[0].timedOut).toBe(false);
    expect(aggregateShardResults(outcomes).passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Duration cache round-trip
// ---------------------------------------------------------------------------

describe("duration cache", () => {
  let dir: string;
  let cachePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "run-tests-main-sharded-cache-test-"));
    cachePath = join(dir, "test-duration-cache.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("readDurationCache returns {} when the file does not exist", () => {
    expect(readDurationCache(cachePath)).toEqual({});
  });

  it("round-trips through write/read", () => {
    writeDurationCache({ "src/a.test.ts": 123, "src/b.test.ts": 456 }, cachePath);
    expect(existsSync(cachePath)).toBe(true);
    expect(readDurationCache(cachePath)).toEqual({ "src/a.test.ts": 123, "src/b.test.ts": 456 });
  });

  it("gracefully ignores a corrupt cache file (starts cold rather than throwing)", () => {
    writeFileSync(cachePath, "{ not valid json");
    expect(readDurationCache(cachePath)).toEqual({});
  });

  it("gracefully ignores a non-object JSON cache file", () => {
    writeFileSync(cachePath, "[1,2,3]");
    expect(readDurationCache(cachePath)).toEqual({});
  });

  it("mergeDurationsIntoCache overwrites only the files present in the fresh measurement", () => {
    const cache = { "src/a.test.ts": 100, "src/stale.test.ts": 999 };
    const fresh = new Map([["src/a.test.ts", 0.05]]); // 50ms
    const merged = mergeDurationsIntoCache(cache, fresh);
    expect(merged["src/a.test.ts"]).toBe(50);
    expect(merged["src/stale.test.ts"]).toBe(999); // untouched, not dropped
  });

  it("collectShardDurationsSec parses a real bun JUnit fragment and skips a missing file", () => {
    const xmlPath = join(dir, "shard-0.xml");
    writeFileSync(
      xmlPath,
      `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="1" assertions="1" failures="0" skipped="0" time="0.007277">
  <testsuite name="x.test.ts" file="x.test.ts" tests="1" assertions="1" failures="0" skipped="0" time="0" hostname="Mac">
    <testcase name="a" classname="" time="0.000012" file="x.test.ts" line="2" assertions="1" />
  </testsuite>
</testsuites>`
    );
    const missingPath = join(dir, "does-not-exist.xml");
    const totals = collectShardDurationsSec([xmlPath, missingPath]);
    expect(totals.get("x.test.ts")).toBeCloseTo(0.000012, 6);
  });
});

// ---------------------------------------------------------------------------
// Fault-injection acceptance test (mt#2990 requirement): a deliberately
// truncated shard mixed with a REAL suite file must fail the aggregate, not
// pass through as green.
// ---------------------------------------------------------------------------

describe("fault-injection acceptance test: truncated shard vs a REAL suite file", () => {
  it("fails the aggregate even though a real, healthy test file ran successfully in a sibling shard", async () => {
    const outcomes = await runShardsConcurrently(
      [
        {
          label: "real-shard",
          command: [
            "bun",
            "test",
            "--preload",
            "./tests/setup.ts",
            "--timeout=15000",
            "scripts/run-tests-sharded-prototype.test.ts",
          ],
        },
        {
          label: "truncated-shard",
          command: [
            "bun",
            "-e",
            'console.log("{\\"message\\":\\"mcp_disconnect\\"}"); process.exit(0)',
          ],
        },
      ],
      60_000
    );
    const result = aggregateShardResults(outcomes);
    expect(result.passed).toBe(false);

    const real = result.shardResults.find((r) => r.label === "real-shard");
    expect(real?.passed).toBe(true);
    expect(real?.testCount).toBeGreaterThan(0);

    const truncated = result.shardResults.find((r) => r.label === "truncated-shard");
    expect(truncated?.passed).toBe(false);
  }, 30000);
});
