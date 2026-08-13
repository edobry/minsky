#!/usr/bin/env bun
/**
 * Live verification for mt#3973's resident-memory capture.
 *
 * Two independent checks, because the task's two open questions are different
 * kinds of claim:
 *
 *   AT1 — behavioral. Start a REAL `minsky mcp start`, set the watermark and
 *   ceiling below its actual RSS so both fire on the first poll, and assert the
 *   capture artifact was written AND the process still self-terminated. That
 *   pair is the point: the capture must not be able to prevent the kill.
 *
 *   AT3 — measurement. Settle whether Bun's JSC-backed `generateHeapSnapshot`
 *   carries the cost profile Node documents for V8's ("memory about twice the
 *   size of the heap", "a synchronous operation which blocks the event loop" —
 *   https://nodejs.org/api/v8.html). That figure decides whether an in-process
 *   snapshot can fit under the 2048MB ceiling at all, and it has been an
 *   ASSUMPTION in this task's design until this script runs.
 *
 * Usage:
 *   bun scripts/verify-memory-capture.ts            # both checks
 *   bun scripts/verify-memory-capture.ts --at1      # behavioral only
 *   bun scripts/verify-memory-capture.ts --at3      # measurement only
 *
 * Exit 0 = pass, non-zero = fail. Structured result to stdout as JSON.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const MB = 1024 * 1024;

interface CheckResult {
  name: string;
  passed: boolean;
  details: Record<string, unknown>;
}

/**
 * AT1 — start a real server with the thresholds pulled below its live RSS.
 *
 * Watermark 64MB / ceiling 128MB against a process whose floor is ~200MB means
 * both watchers cross on their first poll, which is the whole point: it
 * exercises the ordering without needing to reproduce a real leak.
 */
async function runAt1(): Promise<CheckResult> {
  const stateDir = mkdtempSync(join(tmpdir(), "mt3973-capture-"));
  try {
    const proc = Bun.spawn(["bun", "src/cli.ts", "mcp", "start"], {
      env: {
        ...process.env,
        MINSKY_STATE_DIR: stateDir,
        MINSKY_MCP_MEMORY_CAPTURE_MB: "64",
        MINSKY_MCP_MEMORY_CAPTURE_POLL_MS: "1000",
        MINSKY_MCP_MEMORY_CEILING_MB: "128",
        MINSKY_MCP_MEMORY_CEILING_POLL_MS: "1000",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await Promise.race([
      proc.exited,
      new Promise<number>((resolve) => setTimeout(() => resolve(-1), 45_000)),
    ]);
    if (exitCode === -1) proc.kill();

    const stderr = await new Response(proc.stderr).text();
    const captureDir = join(stateDir, "memory-captures");

    let artifacts: string[] = [];
    try {
      artifacts = readdirSync(captureDir);
    } catch {
      // No directory means no capture fired — reported as a failure below
      // rather than swallowed, since its absence IS the finding.
      artifacts = [];
    }

    const jsonArtifact = artifacts.find((f) => f.endsWith(".json"));
    const record = jsonArtifact
      ? JSON.parse(readFileSync(join(captureDir, jsonArtifact), "utf-8"))
      : null;

    const capturedWritten = record !== null;
    const processExited = exitCode !== -1;
    const ceilingLogged = /mt#3886/.test(stderr);

    return {
      name: "AT1: capture artifact written AND process still self-terminated",
      passed: capturedWritten && processExited,
      details: {
        captureArtifactWritten: capturedWritten,
        artifactName: jsonArtifact ?? null,
        processExited,
        exitCode,
        ceilingBreachLogged: ceilingLogged,
        record,
      },
    };
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

/**
 * AT3 — measure snapshot cost against a deliberately-grown heap.
 *
 * Reports the snapshot's byte size and generation wall time alongside RSS
 * before and after, so the "~2x the heap" question is answered with numbers
 * from THIS runtime rather than inherited from Node's documentation of a
 * different engine.
 */
function runAt3(): CheckResult {
  const ballast: string[][] = [];
  for (let i = 0; i < 40; i++) {
    const chunk: string[] = [];
    for (let j = 0; j < 40_000; j++) chunk.push(`mt3973-ballast-${i}-${j}-${"x".repeat(64)}`);
    ballast.push(chunk);
  }

  const rssBefore = process.memoryUsage.rss();
  const started = performance.now();
  const bunGlobal: unknown = Reflect.get(globalThis, "Bun");
  if (!bunGlobal || typeof bunGlobal !== "object") {
    throw new Error("Bun global unavailable — this script must run under bun");
  }
  const generate: unknown = Reflect.get(bunGlobal, "generateHeapSnapshot");
  if (typeof generate !== "function") {
    throw new Error("Bun.generateHeapSnapshot unavailable in this runtime");
  }
  const snapshot = (generate as (f: "v8", e: "arraybuffer") => ArrayBuffer)("v8", "arraybuffer");
  const elapsedMs = performance.now() - started;
  const rssAfter = process.memoryUsage.rss();

  // Keep the ballast reachable until after the measurement, or the snapshot
  // measures a heap the GC has already reclaimed.
  const ballastLength = ballast.length;

  return {
    name: "AT3: heap-snapshot cost measured in this runtime",
    passed: snapshot.byteLength > 0,
    details: {
      ballastChunks: ballastLength,
      rssBeforeMb: Math.round(rssBefore / MB),
      rssAfterMb: Math.round(rssAfter / MB),
      rssDeltaMb: Math.round((rssAfter - rssBefore) / MB),
      rssGrowthRatio: Number((rssAfter / rssBefore).toFixed(2)),
      snapshotBytes: snapshot.byteLength,
      snapshotMb: Math.round(snapshot.byteLength / MB),
      generationMs: Math.round(elapsedMs),
      nodeDocumentedExpectation:
        "V8: ~2x heap, synchronous/blocking (https://nodejs.org/api/v8.html)",
    },
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const runAll = !args.includes("--at1") && !args.includes("--at3");
  const results: CheckResult[] = [];

  if (runAll || args.includes("--at3")) results.push(runAt3());
  if (runAll || args.includes("--at1")) results.push(await runAt1());

  const allPassed = results.every((r) => r.passed);
  console.log(JSON.stringify({ task: "mt#3973", allPassed, results }, null, 2));
  process.exit(allPassed ? 0 : 1);
}

await main();
