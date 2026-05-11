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

// ─── Dependency interfaces (for testability) ─────────────────────────────────

/**
 * Filesystem operations needed by the bin entry logic.
 *
 * `readFileSync` returns a string here (utf8 is the only encoding we use);
 * dropping the encoding parameter sidesteps Bun's stricter overload typing
 * for `fs.readFileSync` vs Node's. The production wrapper applies "utf8"
 * internally.
 */
export interface FsDeps {
  existsSync(path: string): boolean;
  readFileSync(path: string): string;
  writeFileSync(path: string, data: string): void;
  realpathSync(path: string): string;
}

/** Process-execution operations needed by the bin entry logic. */
export interface ExecDeps {
  /** Run `git rev-parse HEAD` in the given cwd. Returns stdout or "" on failure. */
  gitRevParseHead(cwd: string): string;
  /** Run `bun build --target=bun --outfile=<bundlePath> <sourcePath>` in cwd. Returns exit code. */
  bunBuild(args: { cwd: string; bundlePath: string; sourcePath: string }): number;
}

/** stderr writer for warnings and errors. */
export interface StderrDeps {
  write(message: string): void;
}

// ─── Core decision logic (exported for testing) ───────────────────────────────

export interface BundleDecision {
  /** Whether this is a source install (src/cli.ts was found). */
  isSourceInstall: boolean;
  /** Whether the bundle is present and ready to execute. */
  bundlePresent: boolean;
  /** Whether a rebuild was attempted and whether it succeeded. */
  rebuildAttempted: boolean;
  rebuildSucceeded: boolean;
}

/**
 * Computes the bundle state for the given package root.
 * This is pure decision logic — it handles freshness detection and triggering
 * the build, but leaves the actual import() to the caller.
 *
 * @param packageRoot - absolute path to the package root
 * @param fs - filesystem dependency injection
 * @param exec - execution dependency injection
 * @param stderr - stderr writer dependency injection
 */
export function computeBundleDecision(
  packageRoot: string,
  bundlePath: string,
  stampPath: string,
  sourcePath: string,
  fs: FsDeps,
  exec: ExecDeps,
  stderr: StderrDeps
): BundleDecision {
  const isSourceInstall = fs.existsSync(sourcePath);
  let rebuildAttempted = false;
  let rebuildSucceeded = false;

  if (isSourceInstall) {
    // Read the current git HEAD. If git isn't available (shouldn't happen in a
    // source install, but defensive), stale defaults to true → triggers a build.
    const head = exec.gitRevParseHead(packageRoot);

    let stale = true;
    if (head) {
      try {
        stale = fs.readFileSync(stampPath).trim() !== head;
      } catch {
        // Stamp file missing → treat as stale (first run or dist/ cleaned).
        stale = true;
      }
    }

    if (stale) {
      rebuildAttempted = true;
      const exitCode = exec.bunBuild({ cwd: packageRoot, bundlePath, sourcePath });
      if (exitCode === 0 && head) {
        try {
          fs.writeFileSync(stampPath, head);
          rebuildSucceeded = true;
        } catch {
          // Stamp write failure is non-fatal: bundle still executes; next run
          // re-checks freshness and rebuilds (idempotent, not a correctness issue).
          stderr.write("[minsky] warning: could not write build stamp\n");
          rebuildSucceeded = true; // bundle itself was written successfully
        }
      } else if (exitCode !== 0) {
        stderr.write("[minsky] bundle build failed; falling back to source\n");
        rebuildSucceeded = false;
      }
    }
  }

  const bundlePresent = fs.existsSync(bundlePath);
  return { isSourceInstall, bundlePresent, rebuildAttempted, rebuildSucceeded };
}

// ─── Production implementations ──────────────────────────────────────────────

function makeProductionFsDeps(): FsDeps {
  return {
    existsSync,
    readFileSync: (path: string): string => readFileSync(path, "utf8") as string,
    writeFileSync: (path: string, data: string) => writeFileSync(path, data),
    realpathSync,
  };
}

function makeProductionExecDeps(): ExecDeps {
  return {
    gitRevParseHead(cwd: string): string {
      const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
      return result.stdout?.trim() ?? "";
    },
    bunBuild({ cwd, bundlePath, sourcePath }): number {
      const result = spawnSync(
        "bun",
        ["build", "--target=bun", `--outfile=${bundlePath}`, sourcePath],
        { cwd, stdio: "inherit" }
      );
      return result.status ?? 1;
    },
  };
}

// ─── Entry point ─────────────────────────────────────────────────────────────

// Guard with `import.meta.main` so importing this module for tests does NOT
// trigger the bundle/source exec. Without the guard, `import("../scripts/cli-entry")`
// from a test would actually start the CLI.
if (import.meta.main) {
  // Resolve the real path of THIS script file, following symlinks (e.g. bun link).
  // fileURLToPath(import.meta.url) gives the path through the symlink; realpathSync
  // resolves it to the actual file location in the package root.
  const launcherPath = realpathSync(fileURLToPath(import.meta.url));
  const packageRoot = join(dirname(launcherPath), "..");
  const bundlePath = join(packageRoot, "dist", "minsky.js");
  const stampPath = join(packageRoot, "dist", ".build-stamp");
  const sourcePath = join(packageRoot, "src", "cli.ts");

  const stderrDeps: StderrDeps = {
    write: (msg) => process.stderr.write(msg),
  };

  const decision = computeBundleDecision(
    packageRoot,
    bundlePath,
    stampPath,
    sourcePath,
    makeProductionFsDeps(),
    makeProductionExecDeps(),
    stderrDeps
  );

  if (decision.bundlePresent) {
    // Load-bearing: import(), NOT spawnSync. The current Bun process IS the runtime.
    // Spawning a subprocess would double the Bun-startup cost and defeat the optimization.
    await import(bundlePath);
  } else {
    // Fallback: fresh clone with no bundle yet, or build failure.
    // Works for Profile A (source install) only — Profile D has no src/cli.ts.
    await import(sourcePath);
  }
}
