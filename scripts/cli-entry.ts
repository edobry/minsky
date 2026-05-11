#!/usr/bin/env bun
/**
 * Bin entry for the `minsky` CLI (mt#1740).
 *
 * Handles three install profiles:
 *   Profile A — source install (git clone + bun link / bun run)
 *   Profile C — future local HTTP daemon source install
 *   Profile D — published npm install (no src/ present)
 *
 * Profile B (Railway HTTP) bypasses this entry entirely: the Dockerfile runs
 * `bun build` at image-build time and execs `dist/minsky.js` directly via CMD.
 *
 * Design (from mt#1720 RFC):
 *   1. Detect source-vs-published install via realpath + file-presence on src/cli.ts.
 *   2. For source installs: check freshness via git HEAD + dist/.build-stamp.
 *      If stale, rebuild via `bun build`; update stamp on success.
 *      If build fails, log a warning and fall through to source fallback.
 *   3. Import the bundle (`dist/minsky.js`) if present; otherwise fall back to
 *      the source entry (`src/cli.ts`). The fallback handles "fresh clone, no bundle
 *      yet" and post-build-failure gracefully — no crash.
 *
 * Critical design point: uses `await import(bundlePath)`, NOT child_process.spawn.
 * This means the bin entry's Bun process becomes the bundle's runtime — no extra
 * process, no double-Bun-startup cost. The import() is load-bearing.
 *
 * TOCTOU analysis (all three windows accepted as idempotent — see mt#1740 PR body):
 *   1. Read atomicity: two reads (git rev-parse HEAD + read stamp). Between reads,
 *      HEAD could advance. Worst case: "rebuild we didn't need" or "skip we should
 *      have done". Accepted: idempotent — next invocation re-checks.
 *   2. Decision-action gap: between freshness decision and `bun build` invocation,
 *      source could be edited again. Accepted: idempotent — bun build reads source
 *      at build time; either old-or-new build is valid.
 *   3. Stale-read: dist/.build-stamp could be from a previous invocation. Accepted:
 *      by design — the stamp tracks the last-built HEAD; staleness is the test.
 */

import { realpathSync, existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

// Resolve the real path of THIS script file, following symlinks (e.g. bun link).
// fileURLToPath(import.meta.url) gives the path through the symlink; realpathSync
// resolves it to the actual file location in the package root.
const launcherPath = realpathSync(fileURLToPath(import.meta.url));
const packageRoot = join(dirname(launcherPath), "..");
const bundlePath = join(packageRoot, "dist", "minsky.js");
const stampPath = join(packageRoot, "dist", ".build-stamp");
const sourcePath = join(packageRoot, "src", "cli.ts");

// Source-vs-published detection: if src/cli.ts exists, we're in a source install.
// Published installs (Profile D) only ship dist/ + scripts/cli-entry.ts per the
// package.json "files" field — src/ is excluded from the npm publish artifact.
const isSourceInstall = existsSync(sourcePath);

if (isSourceInstall) {
  // Read the current git HEAD. If git isn't available (shouldn't happen in a
  // source install, but defensive), stale defaults to true → triggers a build.
  const gitResult = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  const head = gitResult.stdout?.trim() ?? "";

  let stale = true;
  if (head) {
    try {
      stale = readFileSync(stampPath, "utf8").trim() !== head;
    } catch {
      // Stamp file missing → treat as stale (first run or dist/ cleaned).
      stale = true;
    }
  }

  if (stale) {
    const buildResult = spawnSync(
      "bun",
      ["build", "--target=bun", `--outfile=${bundlePath}`, sourcePath],
      { cwd: packageRoot, stdio: "inherit" }
    );
    if (buildResult.status === 0 && head) {
      try {
        writeFileSync(stampPath, head);
      } catch {
        // Stamp write failure is non-fatal: bundle still executes; next run
        // re-checks freshness and rebuilds (idempotent, not a correctness issue).
        process.stderr.write("[minsky] warning: could not write build stamp\n");
      }
    } else if (buildResult.status !== 0) {
      process.stderr.write("[minsky] bundle build failed; falling back to source\n");
    }
  }
}

if (existsSync(bundlePath)) {
  // Load-bearing: import(), NOT spawnSync. The current Bun process IS the runtime.
  // Spawning a subprocess would double the Bun-startup cost and defeat the optimization.
  await import(bundlePath);
} else {
  // Fallback: fresh clone with no bundle yet, or build failure.
  // Works for Profile A (source install) only — Profile D has no src/cli.ts.
  await import(sourcePath);
}
