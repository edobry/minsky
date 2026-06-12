#!/usr/bin/env bun
/**
 * CLI-outside-repo smoke test (mt#1428)
 *
 * Verifies that repo-orthogonal minsky commands work from a directory that is
 * NOT a git repository, without spawning `git remote get-url origin` noise:
 *
 *   1. `minsky --version`     → exit 0, no `fatal: not a git repository` lines
 *   2. `minsky config list`   → exit 0, no `fatal:` lines
 *
 * Regression gate for the eager repository-backend detection bug: the CLI used
 * to run git-remote detection at container boot for EVERY command, crashing
 * (pre-mt#2460) or leaking `fatal:` stderr noise (post-mt#2460) outside a git
 * checkout. Detection is now lazy (mt#1428).
 *
 * Usage: bun scripts/smoke-cli-outside-repo.ts
 * No env requirements — DB-needing commands are deliberately not exercised.
 *
 * Exit codes: 0 = pass, 1 = fail.
 */

import { spawnSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { safeTruncate } from "../src/utils/safe-truncate";

const repoRoot = import.meta.dir.replace(/\/scripts$/, "");
const cliPath = join(repoRoot, "src", "cli.ts");

const tempDir = mkdtempSync(join(tmpdir(), "minsky-outside-repo-"));
console.log(`Temp dir (non-git cwd): ${tempDir}`);

let failed = false;

function check(label: string, args: string[]): void {
  const result = spawnSync("bun", [cliPath, ...args], {
    cwd: tempDir,
    stdio: "pipe",
    encoding: "utf8",
    timeout: 60_000,
  });
  const output = [result.stdout ?? "", result.stderr ?? ""].join("\n");

  if (result.status !== 0) {
    console.error(`FAIL: ${label} exited ${result.status}`);
    console.error(safeTruncate(output, 2000, "head"));
    failed = true;
    return;
  }
  if (/fatal: not a git repository/.test(output)) {
    console.error(`FAIL: ${label} leaked 'fatal: not a git repository' to its output`);
    console.error(safeTruncate(output, 2000, "head"));
    failed = true;
    return;
  }
  console.log(`PASS: ${label} (exit 0, no fatal lines)`);
}

check("minsky --version from non-git dir", ["--version"]);
check("minsky config list from non-git dir", ["config", "list"]);

try {
  rmSync(tempDir, { recursive: true });
} catch {
  // best-effort cleanup
}

if (failed) {
  console.error("\ncli-outside-repo smoke: FAILED");
  process.exit(1);
}
console.log("\ncli-outside-repo smoke: PASSED");
process.exit(0);
