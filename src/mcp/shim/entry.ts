#!/usr/bin/env bun
/**
 * Executable entry point for `minsky mcp shim` (mt#3812, ADR-038).
 *
 * This is the ONLY file this package builds as `dist/mcp-shim.js`
 * (see package.json's `build:mcp-shim` script) and the ONLY source file
 * `scripts/cli-entry.ts` falls back to for a source install. Both paths
 * import `./main` — never `../../cli.ts`, never anything under
 * `src/commands/`, never the tsyringe DI container — because pulling in
 * ANY of those would silently restore the ~24MB bundle-import cost this
 * task's BLOCKING section identifies as the trap that erases the whole
 * resource case for the shared-daemon topology (today's `minsky mcp proxy`
 * sits at ~55MB mean for exactly this reason). `main.ts`'s own docblock and
 * `rss-budget.test.ts` are the two backstops that keep that true over time.
 *
 * Runs unconditionally at module top level (no `import.meta.main` guard):
 * when `scripts/cli-entry.ts` reaches this file via
 * `await import(shimEntry)`, THIS module is not Bun's "main" module (that's
 * cli-entry.ts, or — for a bundled dist/mcp-shim.js run directly — itself),
 * so `import.meta.main` is unreliable here. `src/cli.ts` uses the identical
 * unconditional-top-level-execution pattern for the same reason.
 */

import { parseArgs, runShim } from "./main";

runShim(parseArgs(process.argv.slice(2)));
