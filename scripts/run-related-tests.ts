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
 *   - Commit latency is bounded by a per-partition WALL-CLOCK watchdog
 *     (mt#3765), not by a related-test COUNT. The former count cap skipped
 *     over-cap sets entirely, which inverted the risk gradient — a larger
 *     staged change was checked LESS than a smaller one. A partition that
 *     overruns its budget is reported as a TIMEOUT and deferred to the
 *     pre-push/CI full-suite gate; it does not block the commit, and it is
 *     never rendered as a truncation (a different, silent failure).
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
 *   - Any related test under `services/<svc>/**` runs in a separate `bun
 *     test` invocation with cwd set to that service's directory -- the way
 *     CI and the service's own `test` script run it (mt#3776). bunfig.toml's
 *     `pathIgnorePatterns` excludes `services/**` from ROOT-cwd runs even
 *     when the files are named explicitly on the command line, so before
 *     this partition existed an all-services related set was pruned to
 *     nothing: no tests ran, no completion summary printed, and the
 *     fail-closed gate blocked the commit (same shape as the mt#3738
 *     cockpit-web incident, one exclusion pattern over). Running from the
 *     service directory sidesteps the root bunfig entirely (no bunfig.toml
 *     there) and resolves the service's own dependencies.
 *
 * Wired into pre-commit via src/hooks/pre-commit.ts's `runFastRelatedTests`
 * step (spawns this script and gates the commit on its exit code).
 */
import { join } from "node:path";
import { evaluateBunTestSummary } from "./run-tests-gated";
import { findRelatedTestFiles, type FsLike } from "./find-related-tests";
import {
  spawnWithWatchdog,
  resolveWatchdogBudgetMs,
  WATCHDOG_BUDGETS_MS,
} from "./spawn-with-watchdog";

/** One partition's `bun test` outcome, plus its watchdog disposition (mt#3765). */
export interface BunTestRunResult {
  exitCode: number;
  combined: string;
  /** True when the wall-clock watchdog terminated the partition. */
  timedOut: boolean;
  elapsedMs: number;
  budgetMs: number;
  /** Operator-facing diagnostic, present only when `timedOut`. */
  timeoutMessage?: string;
}

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

/**
 * The ignore-pattern set the cockpit-web branch runs under (mt#3738).
 *
 * `bunfig.toml` lists `src/cockpit/web/**` so those DOM tests stay out of the
 * main (non-DOM) suite. That exclusion applies to files named explicitly on the
 * command line too, so the branch below was handing `bun test` a list of paths
 * that bunfig then pruned to nothing: no tests ran, no `Ran N tests` summary was
 * printed, and the fail-closed gate read the silence as a failure. Every commit
 * touching a cockpit-web test was blocked, and the DOM-preload branch had never
 * actually executed a test.
 *
 * `--path-ignore-patterns` REPLACES the bunfig value rather than adding to it,
 * so naming only `services/**` here restores `src/cockpit/web/**`. This is the
 * same override `package.json`'s `test:components` script already uses; keep the
 * two in step.
 */
const COCKPIT_WEB_IGNORE_PATTERNS = "services/**";

async function runBunTest(
  files: string[],
  preload: string = "./tests/setup.ts",
  pathIgnorePatterns?: string,
  cwd?: string,
  /**
   * Caller-supplied wall-clock budget for THIS partition. The gate passes
   * `min(per-partition budget, time left in the total budget)` so the sum over
   * partitions stays bounded — see RELATED_TESTS_TOTAL.
   */
  budgetMsOverride?: number
): Promise<BunTestRunResult> {
  // Note (mt#3079/mt#3075): a colorized child process no longer needs to be
  // avoided here -- evaluateBunTestSummary (scripts/run-tests-gated.ts) strips
  // ANSI escape codes before matching, so this gate is agnostic to whether the
  // inherited environment forces color on the spawned `bun test` process.
  const ignoreArgs = pathIgnorePatterns
    ? [`--path-ignore-patterns=${pathIgnorePatterns}`]
    : ([] as string[]);
  // mt#3765: bounded by spawnWithWatchdog, not Bun.spawnSync's `timeout`
  // option. That option does not enforce — mt#3156 measured a child that
  // ignores SIGTERM running to completion under `timeout: 2000` and being
  // reported as a PASS (elapsed=25011ms, exitCode=0, success=true). This gate
  // was the last test-runner surface mt#3156 never migrated.
  const budgetMs =
    budgetMsOverride ?? resolveWatchdogBudgetMs(WATCHDOG_BUDGETS_MS.RELATED_TESTS_PARTITION);
  const result = await spawnWithWatchdog(
    // mt#3704: deliberately NOT FULL_SUITE_PER_TEST_TIMEOUT_MS. This is the
    // pre-commit related-test gate, whose partition budget is 60s
    // (RELATED_TESTS_PARTITION) — a 100s per-test timer inside it would invert
    // the outer > inner ordering the budget table depends on, and this gate
    // runs a handful of related files rather than competing with 800+.
    ["bun", "test", "--preload", preload, "--timeout=15000", ...ignoreArgs, ...files],
    {
      budgetMs,
      env: { AGENT: "1" },
      // mt#3776: service partitions run from the service directory so the
      // root bunfig's pathIgnorePatterns (which prunes services/** even from
      // explicitly-named paths) never applies. Undefined = inherit (root).
      ...(cwd ? { cwd } : {}),
    }
  );
  // No re-emit here: spawnWithWatchdog already writes captured stdout/stderr
  // through to this process (spawn-with-watchdog.ts:213-214) precisely so
  // callers that gate on the text still show it. Writing it again printed the
  // whole partition's output twice.
  return {
    exitCode: result.exitCode,
    combined: `${result.stdout}\n${result.stderr}`,
    timedOut: result.timedOut,
    elapsedMs: result.elapsedMs,
    budgetMs,
    // Deliberately NOT formatWatchdogTimeout(): that helper frames a timeout as
    // "a HANG, not a test failure" and tells the reader to raise the budget,
    // which is right for the run-MUST-complete gates it was written for
    // (mt#3156) and wrong here. This partition is allowed not to finish, and
    // the common cause is a legitimately slow file, not a hang — telling the
    // operator to raise a pre-commit budget past 84s would be bad advice.
    timeoutMessage: result.timedOut
      ? `the related-test partition hit its ${Math.round(budgetMs / 1000)}s pre-commit ` +
        `wall-clock budget (ran ${Math.round(result.elapsedMs / 1000)}s` +
        `${result.requiredSigkill ? ", required SIGKILL" : ""}) and was stopped.`
      : undefined,
  };
}

/**
 * Run the fast related-test gate against `changedFiles` (repo-relative
 * paths). Returns `{ ok, reason, relatedCount, elapsedMs }` -- exported for
 * unit testing the orchestration logic without spawning real `bun test`
 * processes (tests inject `runner`).
 */
/**
 * Render the gate's SELECTION so a later reader can act on it (mt#4303).
 *
 * The PASS path has always joined `related` into its reason; the FAILURE and
 * TIMEOUT paths reported only `related.length` — a number. That asymmetry put
 * the file list on the one path where nobody needs it and withheld it on the
 * two where someone does, which is why three consecutive mt#3501
 * investigations (its sixth, seventh and eighth instances) each independently
 * recorded that the N-file list "was again not printed" and could not bisect.
 * The list was never missing because an investigator forgot to look; it was
 * never produced.
 *
 * Space-separated rather than comma-separated (the pass path's form) so the
 * tail can be pasted after a `bun test` invocation directly. Note the gate may
 * PARTITION the set — `src/mcp` files run isolated, `src/cockpit/web` gets the
 * dom-setup preload, `services/*` runs from the service directory — so a single
 * pasted command reproduces the selection, not necessarily every partition's
 * exact flags.
 *
 * Rendered through `toBunTestPath`, the same anchoring the runner itself uses
 * (PR #3150 R1). Space-separation alone does NOT make the list pasteable: bun
 * reads a bare dot-directory argument such as `.minsky/hooks/guard.test.ts` as
 * a NAME filter rather than a path, so it matches nothing and the run emits no
 * completion summary — a command that looks correct and silently does nothing,
 * which is the failure `toBunTestPath` exists to prevent. Emitting a list the
 * reader cannot actually paste would reintroduce it at the diagnostic layer.
 *
 * The PASS path deliberately keeps its own unanchored, comma-joined rendering:
 * leaving it untouched is one of this task's success criteria, and it reads as
 * a report rather than as arguments.
 */
function describeSelection(related: string[]): string {
  const args = related.map(toBunTestPath).join(" ");
  return `${related.length} related test file(s) selected: ${args}`;
}

export async function runFastRelatedTestGate(
  changedFiles: string[],
  repoRoot: string,
  deps: { runBunTest?: typeof runBunTest; fs?: FsLike } = {}
): Promise<{ ok: boolean; reason: string; relatedCount: number; elapsedMs: number }> {
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

  // mt#3765: the count-based cap-skip is GONE. It inverted the risk gradient —
  // a set over the cap was skipped entirely and passed, so a LARGER staged
  // change was checked LESS than a smaller one (observed on mt#3656: a 9-file
  // commit passed, its 2-file follow-up was blocked). Commit latency is now
  // bounded by the per-partition wall-clock watchdog instead, which bounds
  // every set the same way regardless of size.

  /**
   * Terminal decision for one partition, or null to continue to the next.
   *
   * The TIMEOUT branch is the one deliberate policy change in mt#3765, and it
   * is deliberately NOT fail-closed. Fail-closed exists for the mt#2632 Bun
   * defect, where a run truncates SILENTLY and its completeness is unknowable.
   * A watchdog kill is not silent: we know the budget, the elapsed time, and
   * which partition stopped. Treating a known, reported timeout as a commit
   * blocker made this gate unpassable for any change whose related set
   * contains a slow file — with no in-tool override (session_commit cannot set
   * MINSKY_SKIP_RELATED_TESTS, and `git commit` is denied on both Bash and
   * session_exec), which is what stranded mt#3656 and mt#3514.
   *
   * Deferring an unfinished local smoke to `.husky/pre-push` + CI is exactly
   * the under-inclusion trade find-related-tests.ts already documents as
   * accepted. A missing summary WITHOUT a timeout still fails closed — that is
   * the real truncation signal and it is untouched.
   */
  // Total wall-clock across ALL partitions (PR #2733 R1). A per-partition
  // budget alone leaves the gate's total unbounded in the NUMBER of
  // partitions, and the outer wrapper in related-tests-check.ts treats its own
  // kill as a hard FAILURE — so an unbounded total would reintroduce the
  // unpassable state on the one path where a timeout is not a deferral.
  const totalBudgetMs = resolveWatchdogBudgetMs(WATCHDOG_BUDGETS_MS.RELATED_TESTS_TOTAL);
  const deadlineAt = startMs + totalBudgetMs;
  const remainingMs = () => deadlineAt - Date.now();

  const deferredForTimeout = (
    detail: string
  ): { ok: boolean; reason: string; relatedCount: number; elapsedMs: number } => ({
    ok: true,
    reason:
      `related tests TIMED OUT, not failed -- ${detail} ` +
      `Deferred to the authoritative full-suite gate (.husky/pre-push + CI); ` +
      `the commit is NOT blocked. ${describeSelection(related)}`,
    relatedCount: related.length,
    elapsedMs: Date.now() - startMs,
  });

  const terminalFor = (
    result: BunTestRunResult,
    failLabel: string
  ): { ok: boolean; reason: string; relatedCount: number; elapsedMs: number } | null => {
    if (result.timedOut) {
      return deferredForTimeout(result.timeoutMessage ?? "the partition was stopped.");
    }
    const gate = evaluateBunTestSummary(result.combined, result.exitCode);
    if (!gate.ok) {
      return {
        ok: false,
        reason: `${failLabel}: ${gate.reason} -- ${describeSelection(related)}`,
        relatedCount: related.length,
        elapsedMs: Date.now() - startMs,
      };
    }
    return null;
  };

  /**
   * Run one partition inside the TOTAL budget, or defer if the budget is spent.
   * Returns a terminal gate result, or null to continue to the next partition.
   */
  const runPartition = async (
    files: string[],
    failLabel: string,
    preload?: string,
    ignore?: string,
    cwd?: string
  ) => {
    const left = remainingMs();
    if (left <= 0) {
      return deferredForTimeout(
        `the gate hit its ${Math.round(totalBudgetMs / 1000)}s TOTAL pre-commit budget before ` +
          `every partition had run.`
      );
    }
    const partitionBudget = Math.min(
      resolveWatchdogBudgetMs(WATCHDOG_BUDGETS_MS.RELATED_TESTS_PARTITION),
      left
    );
    const result = await doRun(files, preload, ignore, cwd, partitionBudget);
    return terminalFor(result, failLabel);
  };

  const mcpFiles = related.filter((f) => f.startsWith("src/mcp/"));
  const cockpitDomFiles = related.filter((f) => f.startsWith("src/cockpit/web/"));
  // mt#3776: services/<svc>/** tests must NOT go through the root-cwd
  // invocation -- bunfig's pathIgnorePatterns prunes them even when named
  // explicitly, silently for a mixed set and fail-closed for an all-services
  // set. Group per service; each group runs from its service directory below.
  // A path directly under services/ with no service segment (no third path
  // part) has no service directory to run from; it stays in the regular
  // partition (unchanged prior behavior for a case that shouldn't exist).
  const serviceGroups = new Map<string, string[]>();
  const serviceFiles: string[] = [];
  for (const f of related) {
    const parts = f.split("/");
    if (parts[0] === "services" && parts.length >= 3 && parts[1]) {
      serviceFiles.push(f);
      const group = serviceGroups.get(parts[1]) ?? [];
      group.push(f);
      serviceGroups.set(parts[1], group);
    }
  }
  const serviceFileSet = new Set(serviceFiles);
  const regularFiles = related.filter(
    (f) => !f.startsWith("src/mcp/") && !f.startsWith("src/cockpit/web/") && !serviceFileSet.has(f)
  );

  if (regularFiles.length > 0) {
    const terminal = await runPartition(
      regularFiles.map(toBunTestPath),
      "related tests FAILED (fail-closed)"
    );
    if (terminal) return terminal;
  }

  // mt#2967: cockpit-web tests need a DOM environment (happy-dom) via
  // tests/dom-setup.ts, mirroring bunfig.toml's exclusion of this directory
  // from the default (non-DOM) preload -- see this file's module doc.
  if (cockpitDomFiles.length > 0) {
    const terminal = await runPartition(
      cockpitDomFiles.map(toBunTestPath),
      "related cockpit-web tests FAILED (fail-closed, DOM preload)",
      "./tests/dom-setup.ts",
      COCKPIT_WEB_IGNORE_PATTERNS
    );
    if (terminal) return terminal;
  }

  // mt#3776: each service's tests run from that service's directory with the
  // root setup preload addressed relative to it -- the exact invocation the
  // service's own `test` script and CI's per-service step use. Paths are
  // service-relative and ./-anchored so bun treats them as paths, not name
  // filters (same quirk toBunTestPath handles for root-cwd runs).
  for (const [svc, files] of serviceGroups) {
    const serviceDir = join(repoRoot, "services", svc);
    const relativePaths = files.map((f) => `./${f.slice(`services/${svc}/`.length)}`);
    const terminal = await runPartition(
      relativePaths,
      `related services/${svc} tests FAILED (fail-closed, service-directory run)`,
      "../../tests/setup.ts",
      undefined,
      serviceDir
    );
    if (terminal) return terminal;
  }

  // mt#2665: any related src/mcp test runs isolated, one file per process.
  for (const file of mcpFiles) {
    const terminal = await runPartition(
      [toBunTestPath(file)],
      `related test '${file}' FAILED (fail-closed, isolated run)`
    );
    if (terminal) return terminal;
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

  const result = await runFastRelatedTestGate(staged, repoRoot);
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
