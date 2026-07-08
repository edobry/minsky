#!/usr/bin/env bun
/**
 * Runs every src/mcp/**.test.ts file in its own separate `bun test` process.
 *
 * Why this exists (mt#2665): `bun test` 1.2.21 silently truncates when
 * several real-MCP-server-subprocess test files under src/mcp run together
 * in the same invocation -- confirmed down to a minimal 4-file combination
 * (disconnect-tracker, drift-gate, presence-write-path, server), and even
 * running ALL 11 files under src/mcp together (with nothing else) truncates.
 * A single file per invocation was, in every case tried during the mt#2665
 * investigation, reliably healthy (proper summary, correct exit code). This
 * script is the mitigation: isolate each file so no unsafe combination of
 * these files ever shares a Bun process. See docs/testing-patterns.md "Root
 * cause, pinned" for the full investigation.
 *
 * Applies the same mt#2665 CI-hardening discipline per sub-invocation: a
 * file's run only counts as passing if it BOTH exits 0 AND prints its own
 * "Ran N tests across M files" completion summary. A missing summary is
 * treated as a failure regardless of exit code (the exact silent-truncation
 * signature this script exists to route around).
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

const MCP_DIR = "./src/mcp";

const files = readdirSync(MCP_DIR)
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => join(MCP_DIR, f))
  .sort();

if (files.length === 0) {
  console.error(
    "run-tests-mcp-isolated.ts: found zero *.test.ts files under src/mcp -- this is almost " +
      "certainly a bug (either this script's path is stale, or src/mcp's test files moved). " +
      "Refusing to report a false-green result."
  );
  process.exit(1);
}

console.log(
  `run-tests-mcp-isolated.ts: running ${files.length} file(s) individually:\n${files.map((f) => `  - ${f}`).join("\n")}\n`
);

let failures = 0;
for (const file of files) {
  console.log(`\n=== ${file} ===`);
  const proc = Bun.spawnSync(
    ["bun", "test", "--preload", "./tests/setup.ts", "--timeout=15000", file],
    { stdout: "pipe", stderr: "pipe" }
  );
  const stdout = proc.stdout.toString();
  const stderr = proc.stderr.toString();
  process.stdout.write(stdout);
  process.stderr.write(stderr);

  // NOTE: bun prints singular "1 file" (no trailing "s") for a single-file
  // run -- which every invocation in this script is, by construction. The
  // "s?" here is load-bearing; without it every file would false-positive
  // as "no completion summary" (discovered empirically running this script).
  const summaryPattern = /Ran \d+ tests across \d+ files?/;
  const hasSummary = summaryPattern.test(stdout) || summaryPattern.test(stderr);
  const exitOk = proc.exitCode === 0;

  if (!hasSummary) {
    console.error(
      `::error::${file}: no completion summary printed -- treating as a failure ` +
        `regardless of exit code (${proc.exitCode}). This is the silent-truncation signature ` +
        `this script exists to route around; seeing it on a SINGLE isolated file would be a new ` +
        `and more severe finding than anything in the mt#2665 investigation -- escalate rather ` +
        `than retry.`
    );
    failures++;
  } else if (!exitOk) {
    console.error(
      `::error::${file}: exited ${proc.exitCode} with a completion summary present ` +
        `(a genuine test failure, not truncation).`
    );
    failures++;
  }
}

if (failures > 0) {
  console.error(`\nrun-tests-mcp-isolated.ts: ${failures} of ${files.length} file(s) failed.`);
  process.exit(1);
}

console.log(`\nrun-tests-mcp-isolated.ts: all ${files.length} file(s) passed.`);
