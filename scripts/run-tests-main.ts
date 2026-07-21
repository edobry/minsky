#!/usr/bin/env bun
/**
 * Runs the main test suite as an explicit file list, excluding src/mcp/**.
 *
 * Why this exists (mt#2665): `bun test` 1.2.21 silently truncates (exits 0,
 * prints no "Ran N tests across M files" completion summary) when several
 * real-MCP-server-subprocess test files under src/mcp run together in the
 * same invocation as the rest of this repo's ~552-file suite -- or even
 * alone, as just the 11 files under src/mcp. See docs/testing-patterns.md
 * "Root cause, pinned" for the investigation and a minimal 4-file repro.
 *
 * Directory-arg-based invocation (`bun test ./src`) and bunfig.toml's
 * `pathIgnorePatterns` do NOT reliably exclude a subdirectory once its
 * parent is explicitly targeted (confirmed empirically during mt#2665 --
 * several pattern variants tried against `bun test ./src`, none excluded
 * src/mcp). An EXPLICIT FILE LIST does reliably respect exclusions (verified
 * up to 537 files without truncation), so this script enumerates files
 * itself instead of relying on bun's own directory/glob exclusion.
 *
 * src/mcp/**.test.ts is run separately, one file per `bun test` process, via
 * `bun run test:mcp-isolated` (scripts/run-tests-mcp-isolated.ts) -- see that
 * script for why per-file isolation (not just moving mcp into its own single
 * invocation) is necessary.
 *
 * Cross-file substring-collision hardening (mt#3014): `bun test <path>` does
 * NOT treat a positional argument as an exact single-file target. It performs
 * its own default repo-wide file discovery (subject only to bun's HARD-CODED
 * node_modules/.git exclusion -- confirmed empirically that bunfig.toml's
 * `pathIgnorePatterns` has NO effect at all once ANY positional arg is
 * supplied to `bun test`, e.g. `bun test services` still discovers and runs
 * every services/**.test.ts file despite `pathIgnorePatterns = ["services/**"]`
 * in bunfig.toml -- so this script's own EXCLUDE_DIR_PREFIXES is the ONLY
 * thing keeping src/mcp/**, src/cockpit/web/**, and services/** out of a run
 * that passes explicit file args), then matches each discovered candidate
 * file against the given args via literal SUBSTRING containment (not a
 * path-segment-aware or anchored match -- confirmed via
 * `bun test sub/foo.test.ts` also running an unrelated
 * `sub/foo.test.ts.extra.test.ts`). An un-prefixed included-file path could,
 * in principle, be a literal substring of an EXCLUDED file's path elsewhere
 * in the repo, silently pulling it back into this invocation and
 * reintroducing the exact multi-MCP-file truncation risk mt#2665 fixed --
 * completely undetected, since this script trusts bun's own exit code with no
 * output inspection. No such collision exists in the CURRENT file tree
 * (verified during mt#3014's investigation), but the exposure is structural,
 * not merely historical. Every file arg is prefixed with `./` via
 * `toBunTestArgs` below, mirroring the already-validated fix in
 * scripts/run-tests-main-sharded.ts (see that file's header docstring for the
 * full empirical repro) -- anchoring the match and eliminating this
 * collision class.
 *
 * Any extra CLI args (e.g. --coverage, --watch) are forwarded to `bun test`.
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const ROOTS = [
  "./src",
  "./tests/adapters",
  "./tests/domain",
  "./tests/scripts",
  "./tests/unit",
  "./tests/mcp",
  "./tests/dev-tooling",
  "./tests/architecture",
  "./packages/domain",
  "./packages/shared/src",
];

// Mirrors bunfig.toml's pathIgnorePatterns, plus the src/mcp exclusion this
// script exists to enforce reliably.
export const EXCLUDE_DIR_PREFIXES = [
  "src/mcp",
  "src/cockpit/web",
  "services",
  "node_modules",
  ".git",
];

export function shouldExclude(relPath: string): boolean {
  return EXCLUDE_DIR_PREFIXES.some(
    (prefix) => relPath === prefix || relPath.startsWith(`${prefix}/`)
  );
}

/**
 * Prefixes each file path with `./` before it is passed to `bun test` as a
 * positional arg (mt#3014 hardening). See this file's header docstring
 * ("Cross-file substring-collision hardening") for why: an un-prefixed path
 * can be a literal substring of an unrelated (and possibly EXCLUDED) file's
 * path elsewhere in the repo, causing bun's own substring-based positional-arg
 * matching to silently pull that other file into this invocation too. The
 * leading `./` anchors the match to the start of the argument; no real
 * discovered file path in this repo contains a literal "./" substring
 * mid-path, so this empirically eliminates the collision (verified in
 * run-tests-main.test.ts and scripts/run-tests-main-sharded.test.ts).
 */
export function toBunTestArgs(files: string[]): string[] {
  return files.map((f) => `./${f}`);
}

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    // node:path's `relative()` uses the platform separator (backslash on
    // Windows); EXCLUDE_DIR_PREFIXES above are POSIX-style. CI is
    // ubuntu-only and local dev here is macOS, so this has never actually
    // mattered, but normalizing is a one-liner (mt#2665 R1 review).
    const rel = relative(".", full).split("\\").join("/");
    if (shouldExclude(rel)) continue;
    let info: ReturnType<typeof statSync>;
    try {
      info = statSync(full);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      walk(full, out);
    } else if (entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
}

/**
 * Walks `roots` (defaulting to this script's own ROOTS) and returns the sorted
 * list of `*.test.ts` files, applying the same EXCLUDE_DIR_PREFIXES exclusion
 * rules as the sequential runner below. Exported (mt#2990) so the sharded
 * runner (scripts/run-tests-main-sharded.ts) reuses exactly this
 * file-discovery logic instead of re-deriving it -- the same mt#2932
 * rationale that already motivated exporting ROOTS/shouldExclude: keep
 * exactly ONE definition of "what is the main suite".
 */
export function discoverTestFiles(roots: string[] = ROOTS): string[] {
  const files: string[] = [];
  for (const root of roots) {
    walk(root, files);
  }
  files.sort();
  return files;
}

// mt#2932: guarded so `import { ROOTS, EXCLUDE_DIR_PREFIXES, shouldExclude }
// from "./run-tests-main"` (the changed-file -> related-test mapping layer)
// can reuse this script's scope/exclusion list without triggering a full
// `bun test` spawn + process.exit as a side effect of the import. mt#2990
// extends the same guard to cover `discoverTestFiles` (the sharded runner).
if (import.meta.main) {
  const files = discoverTestFiles();

  if (files.length === 0) {
    console.error(
      "run-tests-main.ts: found zero test files -- this is almost certainly a bug " +
        "in this script's ROOTS/exclusion list, not a legitimately empty suite. Refusing to " +
        "report a false-green result."
    );
    process.exit(1);
  }

  const extraArgs = process.argv.slice(2);
  const proc = Bun.spawnSync(
    [
      "bun",
      "test",
      "--preload",
      "./tests/setup.ts",
      "--timeout=15000",
      ...extraArgs,
      ...toBunTestArgs(files),
    ],
    { stdio: ["ignore", "inherit", "inherit"] }
  );
  process.exit(proc.exitCode ?? 1);
}
