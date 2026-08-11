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

// Must precede the `await import(bundlePath)` at the bottom of this file, and
// stay a STATIC import so it is fully evaluated before any dynamic import runs
// (mt#3735). Bun 1.3.x no longer evaluates reflect-metadata's CommonJS body
// before tsyringe's ESM body inside the bundle, so a bundle imported without
// the polyfill already in place dies at startup with "tsyringe requires a
// reflect polyfill" (mt#3561). `Dockerfile`'s CMD solves the same problem with
// `--preload reflect-metadata`; this file is the other site that executes
// `dist/minsky.js`, and it is the one every installed `minsky` invocation goes
// through — including the local `minsky mcp proxy` server in `.mcp.json`.
// `src/cli.ts` carries its own copy for the source-fallback path; importing it
// twice is a no-op, so this is safe on both branches below.
//
// KEPT after mt#3680, which made the bundle self-sufficient and dropped the
// `--preload` from every other site. This import is now redundant for the
// `await import(bundlePath)` branch — but not for `await import(sourcePath)`,
// and not for a published Profile D install whose bundle predates the fix. It
// costs one already-resolved module and removes a whole class of ordering
// dependency from this file, so the redundancy is deliberate rather than
// oversight. mt#3735's `tests/scripts/cli-entry.test.ts` pins it in place.
import "reflect-metadata";

import { realpathSync, existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, basename } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

// ─── Canonical bun-build invocation (mt#3091) ─────────────────────────────────

/**
 * Single source of truth for the `bun build` invocation shared across the
 * three previously hand-maintained build sites: `package.json`'s `build`
 * script, this file's own self-rebuild (below), and the Dockerfile's
 * Profile-B image-build `RUN` line. Before mt#3091 a flag change in one
 * place had to be manually copied to the other two — mt#3006 aligned two
 * sites and found the third late via a reviewer sweep; mt#3023 existed
 * solely to align that third site.
 *
 * Lives here — rather than a new shared module under `src/` — because
 * `scripts/cli-entry.ts` is the ONLY script file, besides `dist/` and
 * `package.json` itself, listed in package.json's `files` array (what
 * ships to a published-npm install, Profile D). A module living outside
 * that set would fail to resolve at import time for a Profile D install
 * even though the codepath using it never executes there (ESM imports are
 * resolved eagerly, before any `if (isSourceInstall)` guard runs). Every
 * other consumer of this function (the Dockerfile generator, the
 * package.json drift check) runs in a full-repo dev/CI context and can
 * freely import this file — it only touches Node/Bun builtins itself, and
 * importing it for these exports does not execute the CLI (guarded by
 * `import.meta.main` below).
 *
 * `--outdir` + `--entry-naming`, NOT `--outfile`: bun rejects an external
 * source map written through `--outfile` outright (mt#3023). Flag
 * CHOICE (`--minify --sourcemap=external`) is out of scope for mt#3091 —
 * this only removes the duplication, not the decision.
 */
export const BUN_BUILD_TARGET = "bun";
export const BUN_BUILD_OUTDIR = "dist";
export const BUN_BUILD_ENTRY_NAME = "minsky.js";
export const BUN_BUILD_SOURCE_ENTRY = "src/cli.ts";

/**
 * Build the full `bun build` argv (everything after the `bun` binary
 * itself, i.e. starting with the `build` subcommand) for the given
 * output directory / entry filename / source entry point. Order and flag
 * set are canonical — every one of the three build sites either calls
 * this directly or is mechanically checked/generated against it.
 */
export function bunBuildArgs(opts?: {
  outDir?: string;
  entryName?: string;
  sourceEntry?: string;
}): string[] {
  const outDir = opts?.outDir ?? BUN_BUILD_OUTDIR;
  const entryName = opts?.entryName ?? BUN_BUILD_ENTRY_NAME;
  const sourceEntry = opts?.sourceEntry ?? BUN_BUILD_SOURCE_ENTRY;
  return [
    "build",
    `--target=${BUN_BUILD_TARGET}`,
    `--outdir=${outDir}`,
    "--entry-naming",
    entryName,
    "--sourcemap=external",
    "--minify",
    sourceEntry,
  ];
}

/**
 * `bunBuildArgs()` rendered as a single shell-ready command string
 * (`"bun build --target=bun ... src/cli.ts"`), prefixed with the `bun`
 * binary itself. Used by consumers that need a literal command string
 * rather than an argv array — the Dockerfile `RUN` line and the
 * package.json build-script drift check.
 */
export function bunBuildCommand(opts?: Parameters<typeof bunBuildArgs>[0]): string {
  return ["bun", ...bunBuildArgs(opts)].join(" ");
}

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
  /** Run the canonical `bunBuildArgs()` invocation (see above) in cwd. Returns exit code. */
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

    // R1 fix: also treat as stale if the bundle file itself is missing.
    // Without this, a deleted bundle whose stamp file still matches HEAD would
    // cause permanent source-fallback until HEAD changes (silent perf regression).
    if (!stale && !fs.existsSync(bundlePath)) {
      stale = true;
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
      const outDir = dirname(bundlePath);
      const entryName = basename(bundlePath);
      const result = spawnSync(
        "bun",
        bunBuildArgs({ outDir, entryName, sourceEntry: sourcePath }),
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

  // mt#3812 BLOCKING requirement: `minsky mcp shim` must NEVER go through
  // the bundle-or-source-fallback import below — both branches pull in the
  // entire CLI (tsyringe DI, the full command registry), which is exactly
  // why today's `minsky mcp proxy` sits at ~55MB mean instead of the ~38MB
  // a byte-pipe-only process measures. Intercept before ANY bundle-decision
  // logic runs (freshness check, rebuild, MINSKY_LOADED_COMMIT bookkeeping)
  // so this path touches nothing the normal CLI path touches.
  //
  // `dist/mcp-shim.js` is this package's OWN separate build artifact (see
  // package.json's `build:mcp-shim` script and its `files` entry) — never
  // dist/minsky.js. The source fallback mirrors the existing
  // bundle-present/bundle-absent pattern below for a fresh source-install
  // clone with no dist/ built yet.
  const argv = process.argv.slice(2);
  const isShimInvocation = argv[0] === "mcp" && argv[1] === "shim";

  if (isShimInvocation) {
    // NOTE: no top-level `return` here — illegal in an ES module (this file
    // is loaded as ESM, not CommonJS, so there is no enclosing function body
    // for `return` to exit). The `else` below is what keeps this branch from
    // falling through into the bundle-decision logic.
    const shimBundlePath = join(packageRoot, "dist", "mcp-shim.js");
    const shimSourcePath = join(packageRoot, "src", "mcp", "shim", "entry.ts");
    const shimEntry = existsSync(shimBundlePath) ? shimBundlePath : shimSourcePath;
    await import(shimEntry);
  } else {
    const bundlePath = join(packageRoot, "dist", "minsky.js");
    const stampPath = join(packageRoot, "dist", ".build-stamp");
    const sourcePath = join(packageRoot, "src", "cli.ts");

    const stderrDeps: StderrDeps = {
      write: (msg) => process.stderr.write(msg),
    };

    const fsDeps = makeProductionFsDeps();
    const execDeps = makeProductionExecDeps();

    const decision = computeBundleDecision(
      packageRoot,
      bundlePath,
      stampPath,
      sourcePath,
      fsDeps,
      execDeps,
      stderrDeps
    );

    // mt#2335: record loaded-source freshness facts into process env BEFORE the
    // import so src/mcp/source-freshness.ts (surfaced in debug.systemInfo) can
    // report whether the running code is current with HEAD. Must be set before
    // import(): the freshness module lives inside the bundle and cannot be called
    // from here. For a bundle run, the loaded commit is the build stamp (the
    // commit the imported bundle reflects, post-rebuild-attempt); for a
    // source-fallback run, it is the live HEAD. All three vars are registered in
    // HOOK_ONLY_ENV_VARS so the config parser skips them at boot (mt#1785 class).
    const runMode = decision.bundlePresent ? "bundle" : "source-fallback";
    let loadedCommit = "";
    if (runMode === "bundle") {
      try {
        loadedCommit = fsDeps.readFileSync(stampPath).trim();
      } catch {
        loadedCommit = "";
      }
    } else {
      loadedCommit = execDeps.gitRevParseHead(packageRoot);
    }
    process.env.MINSKY_LOADED_COMMIT = loadedCommit;
    process.env.MINSKY_RUN_MODE = runMode;
    process.env.MINSKY_PACKAGE_ROOT = packageRoot;

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
}
