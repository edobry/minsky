import { describe, expect, it } from "bun:test";
import {
  aggregateShardResults,
  binPackFiles,
  runShardsConcurrently,
  verifyShard,
  type ShardOutcome,
} from "./run-tests-sharded-prototype";

describe("binPackFiles", () => {
  it("throws for a non-positive shardCount", () => {
    expect(() => binPackFiles([], 0)).toThrow();
    expect(() => binPackFiles([], -1)).toThrow();
  });

  it("balances files with known historical duration via greedy LPT", () => {
    const files = [
      { path: "a.test.ts", durationMs: 5 },
      { path: "b.test.ts", durationMs: 5 },
      { path: "c.test.ts", durationMs: 5 },
      { path: "d.test.ts", durationMs: 5 },
    ];
    const shards = binPackFiles(files, 2);
    expect(shards).toHaveLength(2);
    expect(shards[0]).toHaveLength(2);
    expect(shards[1]).toHaveLength(2);
    // Every file assigned exactly once, none dropped or duplicated.
    const allAssigned = [...shards[0], ...shards[1]].sort();
    expect(allAssigned).toEqual(["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts"]);
  });

  it("assigns the single longest file to its own shard before shorter files pile up", () => {
    const files = [
      { path: "slow.test.ts", durationMs: 100 },
      { path: "fast1.test.ts", durationMs: 10 },
      { path: "fast2.test.ts", durationMs: 10 },
      { path: "fast3.test.ts", durationMs: 10 },
    ];
    const shards = binPackFiles(files, 2);
    const shardWithSlow = shards.find((s) => s.includes("slow.test.ts"));
    expect(shardWithSlow).toEqual(["slow.test.ts"]);
  });

  it("round-robins files with no timing history (cold start) instead of alphabetical-contiguous split", () => {
    const files = Array.from({ length: 6 }, (_, i) => ({ path: `f${i}.test.ts`, durationMs: 0 }));
    const shards = binPackFiles(files, 3);
    expect(shards).toHaveLength(3);
    for (const shard of shards) {
      expect(shard).toHaveLength(2);
    }
    // Round-robin, not a contiguous alphabetical chunk: shard 0 gets f0 and f3, not f0/f1.
    expect(shards[0]).toEqual(["f0.test.ts", "f3.test.ts"]);
  });
});

describe("verifyShard", () => {
  const healthy: ShardOutcome = {
    label: "shard-a",
    stdout: "5 pass\n0 fail\n10 expect() calls\nRan 5 tests across 2 files. [12.00ms]\n",
    stderr: "",
    exitCode: 0,
  };

  // The exact mt#2665 signature: some fixture noise, then NOTHING -- no
  // completion summary at all -- yet exit code 0.
  const truncated: ShardOutcome = {
    label: "shard-c",
    stdout: '{"message":"mcp_disconnect","serverName":"srv"}\n',
    stderr: "",
    exitCode: 0,
  };

  it("passes a shard with a valid completion summary and 0 reported failures", () => {
    const v = verifyShard(healthy);
    expect(v.passed).toBe(true);
    expect(v.testCount).toBe(5);
    expect(v.fileCount).toBe(2);
    expect(v.failCount).toBe(0);
  });

  it("FAILS a shard with no completion summary even though it exited 0 (mt#2665 signature)", () => {
    const v = verifyShard(truncated);
    expect(v.passed).toBe(false);
    expect(v.reason).toMatch(/no completion summary/);
  });

  it("fails closed when the summary is present but the fail-count line is missing", () => {
    const malformed: ShardOutcome = {
      label: "shard-d",
      stdout: "Ran 2 tests across 1 file. [1.00ms]\n",
      stderr: "",
      exitCode: 0,
    };
    const v = verifyShard(malformed);
    expect(v.passed).toBe(false);
    expect(v.reason).toMatch(/fail-closed/);
  });

  it("fails a shard reporting N > 0 failures even with a valid summary", () => {
    const failing: ShardOutcome = {
      label: "shard-e",
      stdout: "4 pass\n1 fail\n8 expect() calls\nRan 5 tests across 2 files. [9.00ms]\n",
      stderr: "",
      exitCode: 1,
    };
    const v = verifyShard(failing);
    expect(v.passed).toBe(false);
    expect(v.failCount).toBe(1);
  });

  it("fails a shard whose non-zero exit contradicts a clean-looking summary", () => {
    const contradictory: ShardOutcome = {
      label: "shard-f",
      stdout: "2 pass\n0 fail\n4 expect() calls\nRan 2 tests across 1 file. [2.00ms]\n",
      stderr: "",
      exitCode: 1,
    };
    const v = verifyShard(contradictory);
    expect(v.passed).toBe(false);
    expect(v.reason).toMatch(/non-zero exit contradicts/);
  });

  it("handles the singular 'file' form (no trailing s)", () => {
    const single: ShardOutcome = {
      label: "shard-g",
      stdout: "1 pass\n0 fail\n2 expect() calls\nRan 1 tests across 1 file. [1.00ms]\n",
      stderr: "",
      exitCode: 0,
    };
    expect(verifyShard(single).passed).toBe(true);
  });
});

describe("aggregateShardResults", () => {
  const healthyA: ShardOutcome = {
    label: "shard-a",
    stdout: "5 pass\n0 fail\n10 expect() calls\nRan 5 tests across 2 files. [12.00ms]\n",
    stderr: "",
    exitCode: 0,
  };
  const healthyB: ShardOutcome = {
    label: "shard-b",
    stdout: "3 pass\n0 fail\n6 expect() calls\nRan 3 tests across 1 file. [8.00ms]\n",
    stderr: "",
    exitCode: 0,
  };
  const truncated: ShardOutcome = {
    label: "shard-c",
    stdout: '{"message":"mcp_disconnect","serverName":"srv"}\n',
    stderr: "",
    exitCode: 0,
  };

  it("aggregates all-healthy shards to an overall PASS with a synthesized summary line", () => {
    const result = aggregateShardResults([healthyA, healthyB]);
    expect(result.passed).toBe(true);
    expect(result.totalTests).toBe(8);
    expect(result.totalFiles).toBe(3);
    expect(result.totalFail).toBe(0);
    expect(result.summaryLine).toBe("Ran 8 tests across 3 files.");
    // Confirm the synthesized line still matches ci.yml's own grep contract.
    expect(/Ran \d+ tests across \d+ files?/.test(result.summaryLine)).toBe(true);
    expect(/^\d+ fail$/.test(result.failLine)).toBe(true);
  });

  it("mt#2981 acceptance test: a deliberately-truncated shard mixed with healthy shards fails the WHOLE run, not passed through as green", () => {
    const result = aggregateShardResults([healthyA, truncated, healthyB]);
    expect(result.passed).toBe(false);
    expect(result.shardResults.find((r) => r.label === "shard-c")?.passed).toBe(false);
    // Healthy shards are still individually verified correctly -- only the
    // truncated one fails -- but the OVERALL result must not be green.
    expect(result.shardResults.find((r) => r.label === "shard-a")?.passed).toBe(true);
    expect(result.shardResults.find((r) => r.label === "shard-b")?.passed).toBe(true);
  });
});

describe("runShardsConcurrently (real Bun.spawn fan-out)", () => {
  it("fails the aggregated run when one real subprocess silently truncates", async () => {
    const outcomes = await runShardsConcurrently([
      {
        label: "shard-healthy",
        command: [
          "bun",
          "-e",
          'console.log("2 pass\\n0 fail\\n4 expect() calls\\nRan 2 tests across 1 file. [3.00ms]")',
        ],
      },
      {
        label: "shard-truncated",
        // Simulates mt#2665: prints some output, then exits 0 with no completion summary.
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

  it("runs shards genuinely concurrently, not sequentially (wall-clock evidence)", async () => {
    const SLEEP_MS = 300;
    const shardCount = 4;
    const commands = Array.from({ length: shardCount }, (_, i) => ({
      label: `shard-${i}`,
      command: [
        "bun",
        "-e",
        `await Bun.sleep(${SLEEP_MS}); console.log("1 pass\\n0 fail\\n1 expect() calls\\nRan 1 tests across 1 file. [${SLEEP_MS}.00ms]")`,
      ],
    }));

    // performance.now() (monotonic, duration-measurement API), not Date.now() --
    // this is a wall-clock elapsed-time measurement, not path/id generation.
    const start = performance.now();
    const outcomes = await runShardsConcurrently(commands);
    const elapsedMs = performance.now() - start;

    expect(outcomes).toHaveLength(shardCount);
    expect(aggregateShardResults(outcomes).passed).toBe(true);
    // Sequential execution would take >= shardCount * SLEEP_MS (1200ms). Running
    // concurrently should stay well under that -- generous headroom for
    // process-spawn overhead / CI jitter.
    expect(elapsedMs).toBeLessThan(shardCount * SLEEP_MS * 0.75);
  }, 10000);
});
