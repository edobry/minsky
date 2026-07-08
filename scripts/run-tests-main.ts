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
 * Any extra CLI args (e.g. --coverage, --watch) are forwarded to `bun test`.
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOTS = [
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
const EXCLUDE_DIR_PREFIXES = ["src/mcp", "src/cockpit/web", "services", "node_modules", ".git"];

function shouldExclude(relPath: string): boolean {
  return EXCLUDE_DIR_PREFIXES.some(
    (prefix) => relPath === prefix || relPath.startsWith(`${prefix}/`)
  );
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

const files: string[] = [];
for (const root of ROOTS) {
  walk(root, files);
}
files.sort();

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
  ["bun", "test", "--preload", "./tests/setup.ts", "--timeout=15000", ...extraArgs, ...files],
  { stdio: ["inherit", "inherit", "inherit"] }
);
process.exit(proc.exitCode ?? 1);
