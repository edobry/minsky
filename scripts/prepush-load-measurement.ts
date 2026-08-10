/**
 * Pure measurement core for mt#3871 — does the change-scoped pre-push gate
 * (mt#3562) still vary with machine load?
 *
 * Everything here is a total function over strings and records, so the whole
 * analysis is testable without spawning bun, git, or a load generator. The
 * imperative half — mutating a file to shape a diff, spawning workers, running
 * the gate — lives in `scripts/measure-prepush-load-dependence.ts`.
 *
 * The parsers target bun 1.3.14's reporter output (build 0d9b296a). Bun's
 * `--changed` line is the authoritative selection report and has three distinct
 * shapes, all observed live on 2026-08-10:
 *
 *   --changed: no changed files, nothing to run
 *   --changed: 6 changed files, but no test files are affected
 *   --changed: 22 changed files, running 3/3 test files
 *
 * Reading it is what makes selection measurable at all: bun 1.3.14 exposes no
 * --list and no --dry-run, so there is no other way to ask "what would this
 * diff select?" without running the tests.
 */

/** Strip ANSI escapes, mirroring `run-tests-gated.ts` — bun colorizes whenever
 * the child inherits a FORCE_COLOR-set environment, which agent sessions set,
 * and every anchored regex below would silently stop matching (mt#3075). */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex -- deliberately matching the ESC (0x1B) CSI sequences bun's colorized reporter emits
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

/** Bun's `--changed` selection report, in its three observed shapes. */
export type SelectionReport =
  | { kind: "no-changed-files" }
  | { kind: "no-affected-tests"; changedFiles: number }
  | { kind: "selected"; changedFiles: number; selected: number; candidates: number };

/**
 * How many test files a selection report actually chose. The two non-selecting
 * shapes are both zero, but they are kept distinct above because they answer
 * different questions: "the diff is empty" versus "the diff is real and reaches
 * no test".
 */
export function selectedCount(report: SelectionReport | null): number {
  return report?.kind === "selected" ? report.selected : 0;
}

/**
 * Parse a capture group the regex above already guaranteed is `\d+`.
 *
 * Returns null rather than asserting non-null: a parser whose whole job is to
 * read a third-party tool's output format should degrade to "I could not read
 * this" when that format changes, not throw a type-level assertion that the
 * shape it expected was present.
 */
function parseDigits(group: string | undefined): number | null {
  if (group === undefined) return null;
  const parsed = Number.parseInt(group, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

export function parseSelectionLine(rawOutput: string): SelectionReport | null {
  const clean = stripAnsi(rawOutput);
  const running = clean.match(
    /^--changed: (\d+) changed files?, running (\d+)\/(\d+) test files?$/m
  );
  if (running) {
    const changedFiles = parseDigits(running[1]);
    const selected = parseDigits(running[2]);
    const candidates = parseDigits(running[3]);
    if (changedFiles !== null && selected !== null && candidates !== null) {
      return { kind: "selected", changedFiles, selected, candidates };
    }
    return null;
  }
  const unaffected = clean.match(
    /^--changed: (\d+) changed files?, but no test files are affected$/m
  );
  if (unaffected) {
    const changedFiles = parseDigits(unaffected[1]);
    return changedFiles === null ? null : { kind: "no-affected-tests", changedFiles };
  }
  if (/^--changed: no changed files, nothing to run$/m.test(clean)) {
    return { kind: "no-changed-files" };
  }
  return null;
}

/** `Ran 11063 tests across 775 files.` — singular forms included (mt#3014). */
export function parseCompletionSummary(rawOutput: string): { tests: number; files: number } | null {
  const match = stripAnsi(rawOutput).match(/Ran (\d+) tests? across (\d+) files?/);
  if (!match) return null;
  const tests = parseDigits(match[1]);
  const files = parseDigits(match[2]);
  return tests === null || files === null ? null : { tests, files };
}

export interface FailingTest {
  name: string;
  /** Per-test wall time bun prints in brackets; null when it printed none. */
  elapsedMs: number | null;
}

/**
 * Failing tests with their per-test elapsed time.
 *
 * The elapsed figure is the point, not a nicety. mem#821 (written from mt#3494,
 * this cluster's sibling) records that total suite wall time is a weak proxy for
 * the contention during the few seconds one test occupies, and that measuring the
 * quantity directly is what finally settled that task. For mt#3501's cluster the
 * direct quantity is exactly this number against a 500ms deadline: `[508.25ms]`
 * says the deadline was missed by 8ms, which a suite wall time never could.
 */
export function parseFailingTests(rawOutput: string): FailingTest[] {
  const failures: FailingTest[] = [];
  for (const line of stripAnsi(rawOutput).split("\n")) {
    const match = line.match(/^\s*\(fail\)\s+(.*?)(?:\s+\[([\d.]+)ms\])?\s*$/);
    if (!match) continue;
    const name = (match[1] ?? "").trim();
    if (name.length === 0) continue;
    failures.push({ name, elapsedMs: match[2] ? Number.parseFloat(match[2]) : null });
  }
  return failures;
}

/** One execution of the gate under one condition. */
export interface RunOutcome {
  shape: string;
  condition: "idle" | "loaded";
  passed: boolean;
  exitCode: number;
  wallMs: number;
  /** 1-minute load average sampled at run start and run end. */
  loadStart: number;
  loadEnd: number;
  selection: SelectionReport | null;
  summary: { tests: number; files: number } | null;
  failures: FailingTest[];
}

export interface ConditionSummary {
  runs: number;
  failedRuns: number;
  wallMs: { min: number; median: number; max: number };
  load: { min: number; max: number };
  /** Names of every test that failed at least once under this condition. */
  failingTestNames: string[];
  /** Largest per-test elapsed observed among failures — the direct quantity. */
  worstFailureElapsedMs: number | null;
}

export function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid];
  if (upper === undefined) return Number.NaN;
  if (sorted.length % 2 !== 0) return upper;
  const lower = sorted[mid - 1];
  return lower === undefined ? upper : (lower + upper) / 2;
}

export function summarizeCondition(runs: RunOutcome[]): ConditionSummary {
  const wall = runs.map((r) => r.wallMs);
  const loads = runs.flatMap((r) => [r.loadStart, r.loadEnd]);
  const names = new Set<string>();
  let worst: number | null = null;
  for (const run of runs) {
    for (const failure of run.failures) {
      names.add(failure.name);
      if (failure.elapsedMs !== null && (worst === null || failure.elapsedMs > worst)) {
        worst = failure.elapsedMs;
      }
    }
  }
  return {
    runs: runs.length,
    failedRuns: runs.filter((r) => !r.passed).length,
    wallMs: {
      min: wall.length ? Math.min(...wall) : Number.NaN,
      median: median(wall),
      max: wall.length ? Math.max(...wall) : Number.NaN,
    },
    load: {
      min: loads.length ? Math.min(...loads) : Number.NaN,
      max: loads.length ? Math.max(...loads) : Number.NaN,
    },
    failingTestNames: [...names].sort(),
    worstFailureElapsedMs: worst,
  };
}

/**
 * Whether an idle/loaded pair carries any information about where the failure
 * boundary sits.
 *
 * This is mem#821's constraint made mechanical: "to test a hypothesis about a
 * threshold, you need observations that straddle it. Two samples from one side
 * measure the noise." A pair where both conditions pass, or both fail, sits
 * entirely inside one regime — reporting it as evidence either way is the exact
 * error that cost mt#3494 a retracted spec correction. So the pair is classified
 * before it is interpreted, and `same-regime` can never become a "met" verdict.
 */
export type StraddleVerdict =
  | { kind: "straddles"; idleFailedRuns: number; loadedFailedRuns: number }
  | { kind: "same-regime"; regime: "all-pass" | "all-fail" }
  | { kind: "insufficient-data" };

export function straddleCheck(idle: RunOutcome[], loaded: RunOutcome[]): StraddleVerdict {
  if (idle.length === 0 || loaded.length === 0) return { kind: "insufficient-data" };
  const idleFailed = idle.filter((r) => !r.passed).length;
  const loadedFailed = loaded.filter((r) => !r.passed).length;
  const anyPass = idleFailed < idle.length || loadedFailed < loaded.length;
  const anyFail = idleFailed > 0 || loadedFailed > 0;
  if (!anyFail) return { kind: "same-regime", regime: "all-pass" };
  if (!anyPass) return { kind: "same-regime", regime: "all-fail" };
  return { kind: "straddles", idleFailedRuns: idleFailed, loadedFailedRuns: loadedFailed };
}

/** A shape's role in the experiment, which is what makes a verdict derivable. */
export interface ShapeResult {
  shape: string;
  /** Does this shape's diff select the known load-sensitive test population? */
  selectsLoadSensitive: boolean;
  straddle: StraddleVerdict;
}

export type Sc7Verdict = "met" | "met-conditionally" | "not-met" | "inconclusive";

export interface VerdictReport {
  verdict: Sc7Verdict;
  rationale: string;
}

/**
 * Derive the SC7 verdict from the shape results by a fixed rule rather than by
 * judgment applied once, at the end, by whoever is writing the report.
 *
 * The `inconclusive` branch is the one that matters and the one a hand-written
 * conclusion tends to skip: if the shape that SELECTS the load-sensitive tests
 * never failed under either condition, the experiment never reached the failing
 * regime. That is a statement about the load generator, not about the gate, and
 * calling it "met" would be reading an unreached boundary as an absent one.
 */
export function deriveVerdict(
  shapes: ShapeResult[],
  /**
   * The same gate run UNSCOPED (the pre-mt#3562 behaviour) under the same load.
   *
   * Without it, a sensitive shape that passes every run is indistinguishable from
   * a load condition too weak to break anything, and the only honest verdict is
   * `inconclusive`. A failing control establishes that the condition CAN break
   * these tests — mem#704's discriminating-power requirement, applied to the
   * experiment rather than to a test — which is what lets an all-pass scoped
   * result mean something.
   */
  positiveControl?: { runs: number; failedRuns: number }
): VerdictReport {
  if (shapes.length === 0) {
    return { verdict: "inconclusive", rationale: "No shapes were measured." };
  }
  const sensitive = shapes.filter((s) => s.selectsLoadSensitive);
  const insensitive = shapes.filter((s) => !s.selectsLoadSensitive);

  if (sensitive.length === 0) {
    return {
      verdict: "inconclusive",
      rationale:
        "No measured shape selects the load-sensitive population, so the experiment could not " +
        "reach the failing regime at all.",
    };
  }
  const sensitiveReachedFailure = sensitive.some(
    (s) =>
      s.straddle.kind === "straddles" ||
      (s.straddle.kind === "same-regime" && s.straddle.regime === "all-fail")
  );
  const controlFailed = (positiveControl?.failedRuns ?? 0) > 0;

  if (!sensitiveReachedFailure && !controlFailed) {
    return {
      verdict: "inconclusive",
      rationale:
        "The shape that selects the load-sensitive population never failed under either " +
        "condition, and no positive control established that the load condition can break " +
        "those tests at all. Per mem#821 this is evidence about the load condition, not about " +
        "the gate.",
    };
  }
  if (!sensitiveReachedFailure && controlFailed) {
    const anyShapeVaries = shapes.some((s) => s.straddle.kind === "straddles");
    if (!anyShapeVaries) {
      return {
        verdict: "met",
        rationale:
          `The unscoped positive control failed ${positiveControl?.failedRuns}/${positiveControl?.runs} ` +
          "runs under the same load, so the condition demonstrably breaks these tests — yet every " +
          "change-scoped shape passed under it, including the shape that selects the same " +
          "load-sensitive tests. Scoping, not a weak load condition, is what removed the failures.",
      };
    }
  }
  const insensitiveVaries = insensitive.some((s) => s.straddle.kind === "straddles");
  const sensitiveVaries = sensitive.some((s) => s.straddle.kind === "straddles");

  if (insensitiveVaries) {
    return {
      verdict: "not-met",
      rationale:
        "A diff that selects none of the load-sensitive tests still changed outcome with load, " +
        "so scoping did not remove the gate's load-dependence.",
    };
  }
  if (
    sensitiveVaries ||
    sensitive.some((s) => s.straddle.kind === "same-regime" && s.straddle.regime === "all-fail")
  ) {
    return {
      verdict: "met-conditionally",
      rationale:
        "Load-independent for diffs that select none of the load-sensitive tests; still " +
        "load-dependent for diffs that select them.",
    };
  }
  return {
    verdict: "met",
    rationale: "No measured shape changed outcome with load.",
  };
}

/**
 * One commit's answer to "would this diff have selected the load-sensitive tests?"
 *
 * The obvious method — mem#918's two-ref differential, comparing `--changed=HEAD~n`
 * against `--changed=HEAD~(n-1)` — was implemented first and discarded on the
 * evidence. `--changed=<ref>` compares the ref against the CURRENT head, so the
 * selected sets are nested and cumulative: on this repo they SATURATE at 3/3 by
 * depth 5, after which every one of the remaining 25 commits reports a delta of
 * zero because a later commit already selects the file. The differential's stated
 * lower bound (1/30) was therefore almost entirely masking rather than signal —
 * a number that is technically honest and carries no information.
 *
 * What replaces it is exact: replay the commit's own file set into the working
 * tree, and ask bun with `--changed=HEAD` so nothing but that file set is in the
 * diff. One probe per commit, no nesting, no masking.
 */
export interface CommitSelection {
  sha: string;
  /** Files from the commit that still exist and could be replayed. */
  filesReplayed: number;
  /** Files skipped because the commit deleted or renamed them away. */
  filesMissing: number;
  /** How many of the load-sensitive files this commit's diff selects. */
  selected: number;
}

export interface SelectionFraction {
  commitsExamined: number;
  commitsSelecting: number;
  fraction: number;
  /** Commits whose every file is gone from the tree — they can prove nothing. */
  commitsUnreplayable: number;
}

/**
 * `git log` arguments for the commit list SC6 is defined over.
 *
 * Two details are load-bearing and were both wrong in the first implementation
 * (PR #2760 R1):
 *
 * - **`--first-parent`.** Without it `git log` traverses BOTH parents of every
 *   merge, so the list is individual side-branch work commits rather than main's
 *   own history. Those are different populations with different sizes, and a push
 *   gates on a branch's cumulative diff — which is exactly what a first-parent
 *   merge commit represents.
 * - **An explicit ref.** Defaulting to HEAD silently measures whatever branch the
 *   script runs on. That happened to be equivalent to main the first time only
 *   because the branch had no commits yet, which is precisely the kind of accident
 *   that stops being true the moment anyone re-runs it.
 */
export function commitListArgs(ref: string, count: number): string[] {
  return ["log", "--first-parent", ref, "-n", String(count), "--format=%H"];
}

/**
 * Pick the ref naming the trunk, from the candidates that exist in this checkout.
 *
 * A session workspace is a clone, so `main` may exist only as `origin/main`. The
 * order mirrors `resolveChangedBase` in `scripts/run-tests-gated.ts` so the
 * measurement is defined over the same trunk the gate itself resolves against.
 */
export function resolveTrunkRef(
  exists: (ref: string) => boolean,
  candidates: string[] = ["main", "origin/main", "origin/master"]
): string | null {
  return candidates.find((candidate) => exists(candidate)) ?? null;
}

export function summarizeCommitSelection(results: CommitSelection[]): SelectionFraction {
  const replayable = results.filter((r) => r.filesReplayed > 0);
  const commitsSelecting = replayable.filter((r) => r.selected > 0).length;
  return {
    commitsExamined: replayable.length,
    commitsSelecting,
    fraction: replayable.length === 0 ? Number.NaN : commitsSelecting / replayable.length,
    commitsUnreplayable: results.length - replayable.length,
  };
}
