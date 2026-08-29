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
 * `toBunTestArgs` below (reusing scripts/run-related-tests.ts's already-idempotent
 * `toBunTestPath` -- R1 review, mt#3014: it's a no-op for a path that already
 * starts with `./`/`../`/`/`, avoiding a `././`-prefixed arg that would fail
 * to substring-match ANY discovered path, per that file's own docstring for
 * why it must be idempotent), mirroring the already-validated fix in
 * scripts/run-tests-main-sharded.ts (see that file's header docstring for the
 * full empirical repro) -- anchoring the match and eliminating this
 * collision class.
 *
 * Any extra CLI args (e.g. --coverage, --watch) are forwarded to `bun test`.
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { toBunTestPath } from "./run-related-tests";
import {
  spawnWithWatchdog,
  resolveWatchdogBudgetMs,
  formatWatchdogTimeout,
  WATCHDOG_BUDGETS_MS,
  FULL_SUITE_PER_TEST_TIMEOUT_MS,
} from "./spawn-with-watchdog";

export const ROOTS = [
  "./src",
  // mt#1084: `scripts/` holds 20 colocated `*.test.ts` files that ran in NO
  // suite before this entry -- neither this gate nor CI targeted the directory.
  // Three of them test the gate machinery itself (run-tests-main,
  // run-tests-mcp-isolated, spawn-with-watchdog), so the runner deciding what
  // the pre-push gate executes had tests the pre-push gate did not execute.
  "./scripts",
  "./tests/adapters",
  "./tests/domain",
  "./tests/scripts",
  "./tests/unit",
  "./tests/mcp",
  "./tests/dev-tooling",
  "./tests/architecture",
  // mt#3934: `tests/utils` ran in NO suite either — not this gate, not any
  // `test:*` script, not CI. Two `generateDiffSummary` assertions inside it had
  // silently disagreed with the implementation since mt#3071 replaced the
  // positional diff with a prefix/suffix trim; nothing failed, because nothing
  // ran them. mt#1084 closed the `./scripts` half of this hole and deferred
  // this half here, because the directory could not be added while it was red.
  "./tests/utils",
  "./packages/domain",
  "./packages/shared/src",
];

/**
 * Roots the change-scoped test SELECTOR reads that this runner does NOT execute
 * (mt#4521).
 *
 * Until mt#4521 there was one constant serving two different questions:
 *
 * - **What should the runner EXECUTE?** — `ROOTS` above. Latency-bounded; mt#2716
 *   moved the unit suite out of pre-commit precisely to keep this gate fast.
 * - **What should the selector SEE?** — the import and data-read graphs in
 *   `scripts/find-related-tests.ts`. A file absent here cannot be a graph NODE, so
 *   no test can be selected through it in either direction.
 *
 * For `.minsky/hooks/**` the right answers differ, which is why they are now
 * separate constants. The tree holds ~6000 tests (~22s, mem#1206) — real money on a
 * gate deliberately slimmed for latency, so it stays OUT of execution scope. But it
 * also holds ~170 modules with dense cross-imports, and while it was absent from the
 * graph the sibling heuristic was the ONLY edge that could reach a hooks test:
 * changing `entity-linkify.ts` selected neither `bare-entity-ref-scan.test.ts` nor
 * `linkify-liveness.test.ts`, both of which import it directly. mt#4508 worked around
 * one instance of that with a directory-census edge; this closes the general case.
 *
 * **The pre-push runner's scope is deliberately unchanged**, so `bun run test:hooks`
 * remains the pre-push instruction for a hooks change (mem#1206). What changes is that
 * pre-COMMIT now selects the right hooks tests for a hooks edit, which is where the
 * registry-omission failures this exists to catch actually surface.
 *
 * Keep this list minimal. Every entry is walked on every selector invocation,
 * including changes with nothing to do with it — and over-inclusion is not free:
 * `docs/architecture/hooks/fast-related-test-gate.md` records that a depth-6 walk once
 * pulled 32 files / 80s against a 60s budget, and a gate that cannot finish blocks the
 * commit outright.
 */
export const GRAPH_ONLY_ROOTS = ["./.minsky/hooks"];

/**
 * Which constant should a new consumer import? (PR #3307 R1)
 *
 * - **Executing tests** — `ROOTS`, or better `discoverTestFiles()`, which defaults to
 *   it. This is the set the pre-push gate and CI actually run;
 *   `run-tests-main-sharded.ts` reaches it through `discoverTestFiles`.
 * - **Reasoning ABOUT files without running them** — `GRAPH_ROOTS`: import graphs,
 *   data-read graphs, coverage questions, "which tests could relate to this file".
 *
 * `ROOTS` stays the narrower set on purpose, so adding a selector-only root can never
 * silently enlarge what the gate executes. Nothing outside `find-related-tests.ts`
 * consumes `GRAPH_ROOTS` today; the split is exported rather than kept private so a
 * future consumer picks deliberately instead of defaulting to whichever it found first.
 */

/**
 * The file scope the change-scoped selector builds its graphs over: everything this
 * runner executes, plus the selector-only roots above (mt#4521).
 */
export const GRAPH_ROOTS = [...ROOTS, ...GRAPH_ONLY_ROOTS];

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
  return files.map((f) => toBunTestPath(f));
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
  // mt#3156: the per-test `--timeout` is bun's PER-TEST timer and never fires
  // when a test blocks the event loop synchronously. This wall-clock watchdog
  // bounds the WHOLE run, and escalates SIGTERM -> SIGKILL so a child that
  // ignores the first signal is still reaped rather than orphaned at 100% CPU.
  //
  // mt#3704: that division of labour is exactly why the per-test timer could be
  // raised from a flat 15s to a derived budget — this watchdog, not that timer,
  // is what catches a hang.
  const budgetMs = resolveWatchdogBudgetMs(WATCHDOG_BUDGETS_MS.MAIN);
  const result = await spawnWithWatchdog(
    [
      "bun",
      "test",
      "--preload",
      "./tests/setup.ts",
      `--timeout=${FULL_SUITE_PER_TEST_TIMEOUT_MS}`,
      ...extraArgs,
      ...toBunTestArgs(files),
    ],
    { budgetMs, inheritStdio: true }
  );
  if (result.timedOut) {
    console.error(`\n::error::${formatWatchdogTimeout("run-tests-main.ts", budgetMs, result)}`);
  }
  process.exit(result.exitCode);
}
