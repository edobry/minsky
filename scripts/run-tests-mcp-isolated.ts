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
 *
 * Cross-file substring-collision hardening (mt#3014): `bun test <path>` does
 * NOT treat a positional argument as an exact single-file target. It performs
 * its own default repo-wide file discovery (subject only to bun's HARD-CODED
 * node_modules/.git exclusion -- confirmed empirically that bunfig.toml's
 * `pathIgnorePatterns` has NO effect at all once ANY positional arg is
 * supplied to `bun test`), then matches each discovered candidate file
 * against the given arg via literal SUBSTRING containment (not a
 * path-segment-aware or anchored match -- confirmed via
 * `bun test sub/foo.test.ts` also running an unrelated
 * `sub/foo.test.ts.extra.test.ts`). Since this script's entire purpose is
 * guaranteeing ONE file per process, an un-prefixed file path that happened
 * to be a literal substring of some OTHER file's path elsewhere in the repo
 * would silently pull that other file into the SAME invocation --
 * defeating the isolation guarantee (and this script's own health check only
 * verifies "a completion summary was printed", not "exactly one file ran", so
 * such a leak would go undetected as long as the combined run still produced
 * a normal-looking summary). No such collision exists in the CURRENT file
 * tree (verified during mt#3014's investigation), but the exposure is
 * structural, not merely historical. Every file arg is prefixed with `./` via
 * `toBunTestArg` below, mirroring the already-validated fix in
 * scripts/run-tests-main-sharded.ts (see that file's header docstring for the
 * full empirical repro) -- anchoring the match and eliminating this
 * collision class.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const MCP_DIR = "./src/mcp";

// mt#2665 R1 review fix: the docstring above says "**.test.ts" (recursive),
// but the original implementation only read the top-level directory --
// silently skipping src/mcp/middleware/*.test.ts (3 files) and
// src/mcp/stdio-proxy/*.test.ts (1 file). Those 4 files were consequently
// never run by ANY CI step: excluded from the main "Test" step by
// scripts/run-tests-main.ts's src/mcp/** prefix exclusion, and silently
// dropped here too. Recurse properly.
function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) {
      walk(full, out);
    } else if (entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
}

/**
 * Walks `mcpDir` (defaulting to this script's own MCP_DIR) recursively and
 * returns the sorted list of `*.test.ts` files. Exported (mt#3014) so this
 * script's discovery logic can be exercised without triggering a real `bun
 * test` fan-out as a side effect -- mirrors the `import.meta.main` guard
 * convention already used in scripts/run-tests-main.ts /
 * scripts/run-tests-main-sharded.ts (mt#2932/mt#2990).
 */
export function discoverMcpTestFiles(mcpDir: string = MCP_DIR): string[] {
  const files: string[] = [];
  // Guard the root call: a missing src/mcp should hit the same fail-loud
  // refusal below (R3 non-blocking nit), not a raw readdirSync ENOENT throw.
  if (existsSync(mcpDir)) {
    walk(mcpDir, files);
  }
  files.sort();
  return files;
}

/**
 * Prefixes a single file path with `./` before it is passed to `bun test` as
 * a positional arg (mt#3014 hardening). See this file's header docstring
 * ("Cross-file substring-collision hardening") for why.
 */
export function toBunTestArg(file: string): string {
  return `./${file}`;
}

export interface IsolatedRunVerification {
  file: string;
  passed: boolean;
  /** Populated only when passed === false. */
  reason?: string;
}

// NOTE: bun prints singular "1 file" (no trailing "s") for a single-file run
// -- which every invocation of this script is, by construction. The "s?"
// here is load-bearing; without it every file would false-positive as "no
// completion summary" (discovered empirically running this script).
const SUMMARY_PATTERN = /Ran \d+ tests across \d+ files?/;

/**
 * Verifies ONE isolated single-file run using the mt#2665 CI-hardening
 * discipline: a run only counts as passing if it BOTH exits 0 AND prints its
 * own completion summary. A missing summary is treated as a failure
 * regardless of exit code -- the exact silent-truncation signature this
 * script exists to route around. Exported (mt#3014) for unit testing without
 * spawning a real subprocess.
 */
export function verifyIsolatedRun(
  file: string,
  stdout: string,
  stderr: string,
  exitCode: number | null
): IsolatedRunVerification {
  const hasSummary = SUMMARY_PATTERN.test(stdout) || SUMMARY_PATTERN.test(stderr);
  if (!hasSummary) {
    return {
      file,
      passed: false,
      reason:
        `no completion summary printed -- treating as a failure regardless of exit code ` +
        `(${exitCode}). This is the silent-truncation signature this script exists to route ` +
        `around; seeing it on a SINGLE isolated file would be a new and more severe finding ` +
        `than anything in the mt#2665 investigation -- escalate rather than retry.`,
    };
  }
  if (exitCode !== 0) {
    return {
      file,
      passed: false,
      reason: `exited ${exitCode} with a completion summary present (a genuine test failure, not truncation).`,
    };
  }
  return { file, passed: true };
}

// mt#3014: guarded so this script's discovery/verification helpers can be
// imported by a test file without triggering a real `bun test` fan-out +
// process.exit as a side effect of the import -- the same mt#2932/mt#2990
// convention already used by scripts/run-tests-main.ts /
// scripts/run-tests-main-sharded.ts.
if (import.meta.main) {
  const files = discoverMcpTestFiles();

  if (files.length === 0) {
    console.error(
      "run-tests-mcp-isolated.ts: found zero *.test.ts files under src/mcp (recursive) -- this is " +
        "almost certainly a bug (either this script's path is stale, or src/mcp's test files " +
        "moved). Refusing to report a false-green result -- a silently-empty isolation step is " +
        "exactly the failure class this task exists to close."
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
      ["bun", "test", "--preload", "./tests/setup.ts", "--timeout=15000", toBunTestArg(file)],
      { stdout: "pipe", stderr: "pipe" }
    );
    // Decode explicitly rather than relying on .toString(): under Bun,
    // spawnSync's stdout/stderr are Node Buffers (utf-8 .toString() is
    // correct), but a plain Uint8Array's .toString() would yield comma-joined
    // bytes and silently break the summary regex. TextDecoder handles both.
    const decoder = new TextDecoder();
    const stdout = decoder.decode(proc.stdout);
    const stderr = decoder.decode(proc.stderr);
    process.stdout.write(stdout);
    process.stderr.write(stderr);

    const verification = verifyIsolatedRun(file, stdout, stderr, proc.exitCode);
    if (!verification.passed) {
      console.error(`::error::${file}: ${verification.reason}`);
      failures++;
    }
  }

  if (failures > 0) {
    console.error(`\nrun-tests-mcp-isolated.ts: ${failures} of ${files.length} file(s) failed.`);
    process.exit(1);
  }

  console.log(`\nrun-tests-mcp-isolated.ts: all ${files.length} file(s) passed.`);
}
