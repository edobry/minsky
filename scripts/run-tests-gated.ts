#!/usr/bin/env bun
/**
 * Truncation-safe, fail-closed unit-test gate for local git hooks (mt#2716).
 *
 * Runs the same two test steps CI runs (.github/workflows/ci.yml), in sequence:
 *   1. scripts/run-tests-main.ts — explicit file list that EXCLUDES src/mcp (the
 *      `bun test` 1.2.21 truncation trigger; see docs/testing-patterns.md and
 *      mt#2665). Its combined output is gated fail-CLOSED on the completion
 *      summary line + "<N> fail" count via `evaluateBunTestSummary`.
 *   2. scripts/run-tests-mcp-isolated.ts — each src/mcp file in its own process;
 *      SELF-gates on the per-file summary (non-zero exit on a missing summary),
 *      so here we only check its exit code.
 *
 * This is the local sibling of ci.yml's "Test" + "Test (src/mcp, isolated)"
 * steps — kept aligned so the pre-push hook and CI apply the SAME fail-closed
 * discipline: a silently-truncated run (exit 0, no completion summary) can never
 * pass. Wired into .husky/pre-push (mt#2716).
 *
 * It is deliberately NOT run in pre-commit: a ~4.3-min per-commit gate is the
 * well-documented "slow hook → developers --no-verify it → worse than no hook"
 * anti-pattern, so the full suite runs at push time (this script) + CI
 * (authoritative). Pre-commit keeps only fast static checks.
 *
 * Exit code: 0 only if BOTH steps pass; non-zero (with a diagnostic on stderr)
 * otherwise.
 */

/**
 * Fail-closed gate over a `bun test` run's combined stdout+stderr, mirroring
 * ci.yml's "Test" step. `bun test` 1.2.21 can silently truncate — exit 0 with no
 * completion summary — so exit code alone is not a trustworthy pass signal. A run
 * counts as passing ONLY when all hold:
 *   - the completion summary line ("Ran N tests across M file(s)") is present,
 *   - the "<N> fail" summary line is present, parseable, and reports 0, and
 *   - the process exit code is 0.
 * A missing/unparseable summary is treated as FAILURE (fail-closed) regardless of
 * exit code — that is exactly the silent-truncation signature. "files?" is
 * load-bearing: bun prints singular "1 file" for a single-file run. "tests?"
 * (mt#3014 finding) is equally load-bearing: bun independently pluralizes the
 * test count too -- a run with exactly one test prints "Ran 1 test across ..."
 * (singular, no trailing s), confirmed empirically against the pinned bun
 * 1.2.21; the original pattern required a literal "tests" and would have
 * fail-closed a genuinely-passing single-test run. Kept aligned with ci.yml's
 * grep logic.
 */
/**
 * Strip ANSI/VT100 escape sequences (color codes, cursor moves, etc.) from
 * `bun test` output before line-matching (mt#3078).
 *
 * `bun test` colorizes its summary lines (`\x1b[2m 0 fail\x1b[0m`) whenever
 * its own color heuristic decides to — NOT only when stdout is a real TTY:
 * it also honors an inherited `FORCE_COLOR` env var, which several agent
 * harness shells set globally (`FORCE_COLOR=3`, observed in this repo's own
 * Claude Code session env) and which this gate's spawned subprocess inherits
 * via `{ ...process.env, AGENT: "1" }` (see run-related-tests.ts). Without
 * stripping, the exact-line regexes below (`/^ *\d+ fail$/`) never match a
 * colorized summary line, so a genuinely clean run (0 fail, exit 0) is
 * fail-closed as "'<N> fail' line could not be found" — a false-negative
 * gate failure, not a real test failure. CI's plain-pipe grep never hits
 * this because GitHub Actions runners don't set FORCE_COLOR, so the bug was
 * invisible there; it surfaced only in a color-forcing local/agent shell.
 */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex -- deliberately matching the ESC control char to strip ANSI/VT100 sequences
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

export function evaluateBunTestSummary(
  rawOutput: string,
  exitCode: number
): { ok: boolean; reason: string } {
  const output = stripAnsi(rawOutput);
  if (!/Ran \d+ tests? across \d+ files?/.test(output)) {
    return {
      ok: false,
      reason:
        'no completion summary ("Ran N tests across M files") — the run may have silently ' +
        "truncated (see docs/testing-patterns.md); treating as failure (fail-closed) regardless " +
        `of exit code (${exitCode})`,
    };
  }
  // Last "<N> fail" line, mirroring ci.yml's `grep ... | tail -1`.
  const failLine = output
    .split("\n")
    .reverse()
    .find((line) => /^ *\d+ fail$/.test(line));
  if (!failLine) {
    return {
      ok: false,
      reason:
        'completion summary present but the "<N> fail" line could not be found — refusing to ' +
        "assume 0 failures (fail-closed)",
    };
  }
  const failMatch = failLine.match(/\d+/);
  if (!failMatch) {
    return {
      ok: false,
      reason: `"<N> fail" line found ("${failLine.trim()}") but its count could not be parsed — refusing to assume 0 failures (fail-closed)`,
    };
  }
  const failCount = Number.parseInt(failMatch[0], 10);
  if (failCount > 0) {
    return { ok: false, reason: `bun test reported ${failCount} failing test(s)` };
  }
  if (exitCode !== 0) {
    return {
      ok: false,
      reason: `bun test exited ${exitCode} despite a clean summary — treating as failure`,
    };
  }
  return { ok: true, reason: "" };
}

/**
 * Run one runner script as a child `bun` process, capturing its combined output
 * (for gating) while re-emitting it so the invoking hook still shows the test
 * output. AGENT=1 keeps bun's reporter in clean non-interactive mode.
 */
function runStep(script: string): { exitCode: number; combined: string } {
  const decoder = new TextDecoder();
  const proc = Bun.spawnSync(["bun", script], {
    env: { ...process.env, AGENT: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = decoder.decode(proc.stdout);
  const err = decoder.decode(proc.stderr);
  process.stdout.write(out);
  if (err) process.stderr.write(err);
  return { exitCode: proc.exitCode ?? 1, combined: `${out}\n${err}` };
}

if (import.meta.main) {
  console.log("→ Main suite (scripts/run-tests-main.ts, src/mcp excluded)...");
  const main = runStep("scripts/run-tests-main.ts");
  const gate = evaluateBunTestSummary(main.combined, main.exitCode);
  if (!gate.ok) {
    console.error(`\nrun-tests-gated.ts: main suite FAILED (fail-closed): ${gate.reason}`);
    process.exit(1);
  }

  console.log("\n→ src/mcp (scripts/run-tests-mcp-isolated.ts, per-file isolation)...");
  const mcp = runStep("scripts/run-tests-mcp-isolated.ts");
  if (mcp.exitCode !== 0) {
    console.error(`\nrun-tests-gated.ts: src/mcp isolated runner FAILED (exit ${mcp.exitCode}).`);
    process.exit(1);
  }

  console.log("\nrun-tests-gated.ts: all test steps passed.");
  process.exit(0);
}
