#!/usr/bin/env bun
/**
 * Fast, changed-file-scoped local test gate (mt#2932).
 *
 * The complement to mt#2716: that task moved the FULL unit suite out of
 * pre-commit (a ~4.3-min per-commit gate is the documented "slow hook ->
 * developers --no-verify it -> worse than no hook" anti-pattern) into
 * `.husky/pre-push` + CI via scripts/run-tests-gated.ts. That left commit
 * time with NO automated test signal at all. This script is the fast middle
 * ground the mt#2716 spec's research pass named (jest --findRelatedTests,
 * vitest related, lint-staged): map staged files to the tests related to
 * them (scripts/find-related-tests.ts) and run ONLY those, well under the
 * 60-90s bypass-risk threshold.
 *
 * Fail-closed gating REUSES `evaluateBunTestSummary` from
 * scripts/run-tests-gated.ts (the mt#2716 gate) rather than reimplementing
 * it -- a silently truncated related-test run (exit 0, no completion
 * summary) fails this gate exactly like it fails the full-suite one.
 *
 * Design choices (documented rather than silently applied):
 *   - Zero related tests for the staged change => exit 0 (nothing to run;
 *     this is a fast *signal*, not exhaustive coverage -- the full suite at
 *     push time + CI remains authoritative).
 *   - More than RELATED_TEST_CAP related tests => exit 0 with a warning
 *     instead of running them. A widely-imported low-level module (e.g. a
 *     shared logger) can otherwise pull a large fraction of the suite into
 *     the reverse-dependency-graph walk, defeating the "fast" purpose of
 *     this gate; rely on the pre-push/CI full-suite gate for that case.
 *   - Any related test under `src/mcp/**` runs in its own isolated `bun
 *     test` process, mirroring scripts/run-tests-mcp-isolated.ts -- per
 *     mt#2665, src/mcp test files are known to silently truncate when run
 *     in combination with other files.
 *   - Any related test under `src/cockpit/web/**` runs with the
 *     `tests/dom-setup.ts` preload instead of `tests/setup.ts` -- mirrors
 *     bunfig.toml's `pathIgnorePatterns` exclusion of that directory from
 *     the main (non-DOM) suite (see its comment for the happy-dom rationale).
 *     Without this, a change to a widely-imported cockpit source file (e.g.
 *     a shared widget or route payload type) pulls its DOM-dependent test
 *     files into the related set and they fail fast with "document is not
 *     defined" -- first surfaced by mt#2967's session-detail.ts /
 *     RunDetail.tsx changes.
 *
 * Wired into pre-commit via src/hooks/pre-commit.ts's `runFastRelatedTests`
 * step (spawns this script and gates the commit on its exit code).
 */
import { evaluateBunTestSummary } from "./run-tests-gated";
import { findRelatedTestFiles, type FsLike } from "./find-related-tests";

/** Above this many related test files, skip the local run (see doc comment). */
export const RELATED_TEST_CAP = 40;

/**
 * Bun treats a CLI argument as a test-file PATH only when it starts with
 * "./" or "/" — a bare repo-relative path whose first segment is a
 * dot-directory (e.g. ".minsky/hooks/foo.test.ts") is treated as a NAME
 * filter instead, matches no test file, and the run emits no completion
 * summary — which the fail-closed gate then counts as a failure. First
 * live hit: the mt#2446 commit (2026-07-21), whose related tests live
 * under .minsky/hooks/. Prefix explicitly so every related path is
 * passed as a path.
 */
export function toBunTestPath(file: string): string {
  // NOTE: a bare leading dot (".minsky/hooks/foo.test.ts") is NOT anchored —
  // that is the original bug — so only "/", "./", and "../" pass through.
  return file.startsWith("/") || file.startsWith("./") || file.startsWith("../")
    ? file
    : `./${file}`;
}

function getStagedFiles(): string[] {
  const proc = Bun.spawnSync(["git", "diff", "--cached", "--name-only", "--diff-filter=ACM"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return new TextDecoder().decode(proc.stdout).trim().split("\n").filter(Boolean);
}

function runBunTest(
  files: string[],
  preload: string = "./tests/setup.ts"
): { exitCode: number; combined: string } {
  const decoder = new TextDecoder();
  // mt#3079: FORCE_COLOR is explicitly cleared -- an inherited FORCE_COLOR from
  // the parent (agent/session) environment overrides bun's own non-TTY
  // color-suppression heuristic, wrapping the "<N> fail" summary line in ANSI
  // escape codes that broke evaluateBunTestSummary's anchored regex and made
  // this gate fail-closed on fully-green runs. Belt-and-suspenders alongside
  // that function's own `stripAnsi` step.
  const proc = Bun.spawnSync(["bun", "test", "--preload", preload, "--timeout=15000", ...files], {
    env: { ...process.env, AGENT: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60000,
  });
  const out = decoder.decode(proc.stdout);
  const err = decoder.decode(proc.stderr);
  process.stdout.write(out);
  if (err) process.stderr.write(err);
  return { exitCode: proc.exitCode ?? 1, combined: `${out}\n${err}` };
}

/**
 * Run the fast related-test gate against `changedFiles` (repo-relative
 * paths). Returns `{ ok, reason, relatedCount, elapsedMs }` -- exported for
 * unit testing the orchestration logic without spawning real `bun test`
 * processes (tests inject `runner`).
 */
export function runFastRelatedTestGate(
  changedFiles: string[],
  repoRoot: string,
  deps: { runBunTest?: typeof runBunTest; fs?: FsLike } = {}
): { ok: boolean; reason: string; relatedCount: number; elapsedMs: number } {
  const startMs = Date.now();
  const doRun = deps.runBunTest ?? runBunTest;

  const related = findRelatedTestFiles(changedFiles, repoRoot, { fs: deps.fs });

  if (related.length === 0) {
    return {
      ok: true,
      reason: "no related test files for the staged change -- nothing to run locally",
      relatedCount: 0,
      elapsedMs: Date.now() - startMs,
    };
  }

  if (related.length > RELATED_TEST_CAP) {
    return {
      ok: true,
      reason:
        `${related.length} related test file(s) exceeds the fast-gate cap ` +
        `(${RELATED_TEST_CAP}) -- skipping the local run to protect commit latency; ` +
        "the full suite still runs at push time (.husky/pre-push) and in CI.",
      relatedCount: related.length,
      elapsedMs: Date.now() - startMs,
    };
  }

  const mcpFiles = related.filter((f) => f.startsWith("src/mcp/"));
  const cockpitDomFiles = related.filter((f) => f.startsWith("src/cockpit/web/"));
  const regularFiles = related.filter(
    (f) => !f.startsWith("src/mcp/") && !f.startsWith("src/cockpit/web/")
  );

  if (regularFiles.length > 0) {
    const result = doRun(regularFiles.map(toBunTestPath));
    const gate = evaluateBunTestSummary(result.combined, result.exitCode);
    if (!gate.ok) {
      return {
        ok: false,
        reason: `related tests FAILED (fail-closed): ${gate.reason}`,
        relatedCount: related.length,
        elapsedMs: Date.now() - startMs,
      };
    }
  }

  // mt#2967: cockpit-web tests need a DOM environment (happy-dom) via
  // tests/dom-setup.ts, mirroring bunfig.toml's exclusion of this directory
  // from the default (non-DOM) preload -- see this file's module doc.
  if (cockpitDomFiles.length > 0) {
    const result = doRun(cockpitDomFiles.map(toBunTestPath), "./tests/dom-setup.ts");
    const gate = evaluateBunTestSummary(result.combined, result.exitCode);
    if (!gate.ok) {
      return {
        ok: false,
        reason: `related cockpit-web tests FAILED (fail-closed, DOM preload): ${gate.reason}`,
        relatedCount: related.length,
        elapsedMs: Date.now() - startMs,
      };
    }
  }

  // mt#2665: any related src/mcp test runs isolated, one file per process.
  for (const file of mcpFiles) {
    const result = doRun([toBunTestPath(file)]);
    const gate = evaluateBunTestSummary(result.combined, result.exitCode);
    if (!gate.ok) {
      return {
        ok: false,
        reason: `related test '${file}' FAILED (fail-closed, isolated run): ${gate.reason}`,
        relatedCount: related.length,
        elapsedMs: Date.now() - startMs,
      };
    }
  }

  return {
    ok: true,
    reason: `${related.length} related test file(s) passed: ${related.join(", ")}`,
    relatedCount: related.length,
    elapsedMs: Date.now() - startMs,
  };
}

if (import.meta.main) {
  const repoRoot = process.cwd();
  const argv = process.argv.slice(2);
  const staged = argv.length > 0 ? argv : getStagedFiles();

  if (staged.length === 0) {
    console.log("run-related-tests.ts: no staged files -- nothing to check.");
    process.exit(0);
  }

  const result = runFastRelatedTestGate(staged, repoRoot);
  console.log(`run-related-tests.ts: ${result.reason} [${result.elapsedMs}ms]`);

  if (!result.ok) {
    console.error(
      "\nrun-related-tests.ts: fast related-test gate FAILED. Reproduce locally with the exact " +
        "same input:\n" +
        `  bun scripts/run-related-tests.ts ${staged.join(" ")}`
    );
    process.exit(1);
  }
  process.exit(0);
}
