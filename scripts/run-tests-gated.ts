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
 * Strip ANSI escape sequences (bun's colorized reporter output) before the
 * line-anchored parsing below. Bun colorizes its summary lines (e.g.
 * `\x1b[0m\x1b[2m 0 fail\x1b[0m`) whenever the child process inherits a
 * `FORCE_COLOR`-set environment — which `Bun.spawnSync({ env: { ...process.env } })`
 * does unconditionally, regardless of whether the child's stdout is a real
 * TTY. Claude Code agent sessions set `FORCE_COLOR=3` in their ambient shell
 * env, so every commit/push from such a session inherited colorized output
 * here. The anchored per-line regexes below (`^ *\d+ fail$`, etc.) never
 * matched a colorized line — the leading/trailing escape codes defeat `^`/`$`
 * — which fail-closed EVERY run in that environment regardless of actual
 * pass/fail (mt#3075, found while committing an unrelated change). Stripping
 * first makes the parser agnostic to whether the child process was
 * colorized; a no-op on already-plain output (CI, non-color terminals).
 */
import {
  spawnWithWatchdog,
  resolveWatchdogBudgetMs,
  formatWatchdogTimeout,
  WATCHDOG_BUDGETS_MS,
} from "./spawn-with-watchdog";

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex -- deliberately matching the ESC (0x1B) CSI sequences bun's colorized reporter emits
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

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
 *
 * ANSI-stripped via `stripAnsi` before line-matching (mt#3075 / mt#3078 —
 * fixed independently on two branches; this is the reconciled single copy).
 */
export function evaluateBunTestSummary(
  rawOutput: string,
  exitCode: number
): { ok: boolean; reason: string } {
  const clean = stripAnsi(rawOutput);
  if (!/Ran \d+ tests? across \d+ files?/.test(clean)) {
    return {
      ok: false,
      reason:
        'no completion summary ("Ran N tests across M files") — the run may have silently ' +
        "truncated (see docs/testing-patterns.md); treating as failure (fail-closed) regardless " +
        `of exit code (${exitCode})`,
    };
  }
  // Last "<N> fail" line, mirroring ci.yml's `grep ... | tail -1`.
  const failLine = clean
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
async function runStep(
  script: string,
  args: string[] = []
): Promise<{ exitCode: number; combined: string }> {
  // mt#3156: async spawn under a wall-clock watchdog. `Bun.spawnSync` blocks the
  // JS thread, so no timer could fire to escalate SIGTERM -> SIGKILL — and its
  // own `timeout` option does not enforce (a SIGTERM-ignoring child runs to
  // completion and is reported `exitCode: 0, success: true`). See
  // scripts/spawn-with-watchdog.ts for the measurements.
  const budgetMs = resolveWatchdogBudgetMs(WATCHDOG_BUDGETS_MS.GATED_STEP);
  const result = await spawnWithWatchdog(["bun", script, ...args], {
    budgetMs,
    // This object is MERGED OVER `process.env`, not a replacement — spawnWithWatchdog
    // spreads it (`{ ...process.env, ...options.env }`), as its own `env?` option
    // docstring states. So a caller's env reaches the child: `test:debug`'s
    // DEBUG_TESTS=1 arrives alongside AGENT=1. Noted here because the literal
    // `{ AGENT: "1" }` reads like a replacement at this call site and has
    // already been misread once (PR #2552 R1).
    env: { AGENT: "1" },
  });
  if (result.timedOut) {
    console.error(`\n::error::${formatWatchdogTimeout(script, budgetMs, result)}`);
  }
  return { exitCode: result.exitCode, combined: `${result.stdout}\n${result.stderr}` };
}

// ---------------------------------------------------------------------------
// Change-scoped selection (mt#3562)
// ---------------------------------------------------------------------------

/** Prefix identifying the isolated-runner's domain within a changed-file list. */
export const MCP_PATH_PREFIX = "src/mcp/";

/**
 * Production git runner. Injectable at every call site below so the selection
 * logic is testable without spawning git or depending on the repo's own state.
 */
export function defaultRunGit(args: string[]): string {
  // Bun.spawnSync per `bun_over_node.mdc` (node:child_process is lint-restricted).
  // argv form, not a shell string, so no argument ever goes through shell parsing.
  const result = Bun.spawnSync(["git", ...args], {
    stdout: "pipe",
    stderr: "ignore",
  });
  // Callers treat a throw as "unknown" and fall back to the full suite, so a
  // non-zero git exit must throw rather than return empty output — an empty
  // string would read as "nothing changed", the unsafe direction.
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} exited ${result.exitCode}`);
  }
  return result.stdout.toString();
}

/**
 * Resolve the merge base with the upstream default branch — the ref a push
 * should gate against.
 *
 * A push must gate on everything the BRANCH adds, not only what is currently
 * uncommitted. bun's bare `--changed` default is staged+unstaged+untracked,
 * which for a clean tree at push time selects nothing at all.
 *
 * Returns null when the base cannot be established (no upstream ref, a shallow
 * clone, git unavailable). Callers treat null as "run the full suite" — the
 * fail-closed direction, since an unscoped run is slow but correct while a
 * wrongly-scoped one is fast and blind.
 */
export function resolveChangedBase(
  runGit: (args: string[]) => string = defaultRunGit
): string | null {
  for (const ref of ["origin/main", "origin/master"]) {
    try {
      const base = runGit(["merge-base", "HEAD", ref]).trim();
      if (base.length > 0) return base;
    } catch {
      // Try the next candidate; a missing remote ref is expected, not fatal.
    }
  }
  return null;
}

/**
 * Changed files relative to `base`, unioned with the working tree.
 *
 * Mirrors what bun's `--changed=<ref>` itself considers (verified 2026-08-08:
 * `--changed=HEAD` on a clean tree still reported the untracked files), so the
 * `src/mcp` routing decision below is made over the SAME set bun selects from.
 * Returns null on any git failure — again meaning "assume everything changed".
 */
export function changedFilesSince(
  base: string,
  runGit: (args: string[]) => string = defaultRunGit
): string[] | null {
  try {
    const committed = runGit(["diff", "--name-only", base]);
    const untracked = runGit(["ls-files", "--others", "--exclude-standard"]);
    return `${committed}\n${untracked}`
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch {
    return null;
  }
}

/**
 * What this invocation should run. `base === null` means the main suite runs
 * UNSCOPED — the full suite.
 */
export interface RunPlan {
  base: string | null;
  runMcp: boolean;
  reason: string;
}

/**
 * Decide the run from the three inputs, as one function rather than as
 * conditions spread across the entry point.
 *
 * PR #2729 R1 found the reason this is worth extracting: the scoping decision
 * and the src/mcp decision were separate inline expressions, and they DISAGREED.
 * An unreadable changed-file list forced the isolated runner to run (correctly)
 * while the main suite stayed scoped (incorrectly) — so the documented
 * "everything fails toward the full suite" guarantee held for one half of the
 * gate and not the other. Making it one function means the two cannot drift
 * again, and makes every branch unit-testable without spawning git or bun.
 *
 * Every uncertainty resolves to the full suite: an unscoped run is slow but
 * correct, a wrongly-scoped one is fast and blind.
 */
export function planRun(input: {
  forceFull: boolean;
  base: string | null;
  changedFiles: string[] | null;
}): RunPlan {
  if (input.forceFull) {
    return {
      base: null,
      runMcp: true,
      reason: "MINSKY_PREPUSH_FULL_SUITE=1 — running the full suite.",
    };
  }
  if (input.base === null) {
    return {
      base: null,
      runMcp: true,
      reason:
        "Could not resolve a merge base with the upstream default branch — running the FULL suite (fail-closed).",
    };
  }
  if (input.changedFiles === null) {
    return {
      base: null,
      runMcp: true,
      reason: "Could not read the changed-file list — running the FULL suite (fail-closed).",
    };
  }
  return {
    base: input.base,
    runMcp: touchesMcp(input.changedFiles),
    reason: `Change-scoped against merge base ${input.base.slice(0, 9)}.`,
  };
}

/** Does this changed-file set reach the isolated runner's domain? */
export function touchesMcp(changedFiles: string[]): boolean {
  return changedFiles.some((f) => f.startsWith(MCP_PATH_PREFIX));
}

/**
 * bun's own wording when a selection legitimately matches nothing. Distinct
 * from a truncated run, which emits no summary at all — `evaluateBunTestSummary`
 * separates those two, and this only controls how loudly we SAY which happened.
 */
export function selectedNothing(output: string): boolean {
  return /--changed: \d+ changed files, but no test files are affected/.test(stripAnsi(output));
}

if (import.meta.main) {
  // mt#3562: scope the selection to the branch's diff. Set
  // MINSKY_PREPUSH_FULL_SUITE=1 to force the pre-change behavior.
  const forceFull = process.env.MINSKY_PREPUSH_FULL_SUITE === "1";
  const resolvedBase = forceFull ? null : resolveChangedBase();
  const plan = planRun({
    forceFull,
    base: resolvedBase,
    changedFiles: resolvedBase === null ? null : changedFilesSince(resolvedBase),
  });

  console.log(`→ ${plan.reason}`);

  const mainArgs = plan.base === null ? [] : [`--changed=${plan.base}`];
  console.log("→ Main suite (scripts/run-tests-main.ts, src/mcp excluded)...");
  const main = await runStep("scripts/run-tests-main.ts", mainArgs);
  const gate = evaluateBunTestSummary(main.combined, main.exitCode);
  if (!gate.ok) {
    console.error(`\nrun-tests-gated.ts: main suite FAILED (fail-closed): ${gate.reason}`);
    process.exit(1);
  }
  if (selectedNothing(main.combined)) {
    console.log(
      "   No affected tests in the main suite for this diff — passing explicitly, not silently."
    );
  }

  // The isolated runner has no `--changed` equivalent (it drives one bun
  // process per file), so it runs whole or not at all — see `planRun`.
  if (plan.runMcp) {
    console.log("\n→ src/mcp (scripts/run-tests-mcp-isolated.ts, per-file isolation)...");
    const mcp = await runStep("scripts/run-tests-mcp-isolated.ts");
    if (mcp.exitCode !== 0) {
      console.error(`\nrun-tests-gated.ts: src/mcp isolated runner FAILED (exit ${mcp.exitCode}).`);
      process.exit(1);
    }
  } else {
    console.log("\n→ src/mcp skipped — this diff touches no src/mcp file.");
  }

  console.log("\nrun-tests-gated.ts: all test steps passed.");
  process.exit(0);
}
