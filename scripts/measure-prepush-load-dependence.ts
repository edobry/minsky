#!/usr/bin/env bun
/**
 * mt#3871 — measure whether mt#3562's change-scoping actually removed the
 * pre-push gate's load-dependence (mt#3562 SC7, which shipped UNVERIFIED).
 *
 * Two modes:
 *
 *   (default)                  the load matrix. For each diff shape, run the REAL
 *                              gate (`bun scripts/run-tests-gated.ts`) R times idle
 *                              and R times under generated CPU load, recording wall
 *                              time, pass/fail, the achieved load average, and every
 *                              failing test's own elapsed time.
 *   --mode=selection-fraction  over the last N commits on the branch, how many
 *                              actually select the load-sensitive test population.
 *
 * The analysis lives in `scripts/prepush-load-measurement.ts` as pure functions;
 * this file is the imperative shell that shapes diffs, generates load, and spawns
 * the gate.
 *
 * Exit code follows the measurement convention used elsewhere in this directory:
 * 0 means the measurement was TAKEN (whatever it says), non-zero means it could
 * not be taken. A "not-met" verdict is a successful measurement.
 *
 * Safety: shaping a diff means appending a marker line to a real file and removing
 * it again. Originals are held in memory, restored in a `finally`, and restored
 * again on SIGINT/SIGTERM; the run refuses to start if a target file already
 * contains a marker from an interrupted previous run.
 */

import { cpus, loadavg } from "os";
import { existsSync, readFileSync, writeFileSync } from "fs";

import {
  deriveVerdict,
  parseCompletionSummary,
  parseFailingTests,
  parseSelectionLine,
  selectedCount,
  straddleCheck,
  summarizeCommitSelection,
  summarizeCondition,
  type CommitSelection,
  type RunOutcome,
  type SelectionReport,
  type ShapeResult,
} from "./prepush-load-measurement";

/**
 * The load-sensitive population as of 2026-08-10, enumerated from recorded
 * incidents rather than from a classifier. mt#3494's `collapseToMaximalClusters`
 * bound was the fourth member and is DONE (2026-08-03), so the live population is
 * entirely within src/cockpit.
 */
export const LOAD_SENSITIVE_TEST_FILES = [
  "src/cockpit/transcript-sweep-backstop.test.ts",
  "src/cockpit/health-contract.test.ts",
  "src/cockpit/routes/sweeps.test.ts",
];

/** A regex bun will match against no test name, so files LOAD but nothing runs. */
const NEVER_MATCHING_TEST_NAME = "zzz_mt3871_never_matches_zzz";

const MARKER = "mt#3871 measurement marker";

/**
 * The 1-minute load average, which is the achieved-condition number every run
 * records. mem#821 is the reason it is recorded per run rather than assumed from
 * having spawned workers: "loaded" is a claim about the machine, and the whole
 * measurement turns on whether the claim held during the seconds a given test ran.
 */
function oneMinuteLoad(): number {
  return loadavg()[0] ?? 0;
}

interface Shape {
  id: string;
  label: string;
  /** File whose modification shapes the diff. */
  target: string;
  selectsLoadSensitive: boolean;
}

const SHAPES: Shape[] = [
  {
    id: "A",
    label: "selects tests, none of them load-sensitive",
    // A test file, so the selection is deterministic by construction rather than
    // dependent on how bun's module graph happens to resolve a source change.
    target: "tests/scripts/prepush-load-measurement.test.ts",
    selectsLoadSensitive: false,
  },
  {
    id: "B",
    label: "selects the load-sensitive population",
    target: "src/cockpit/transcript-sweep-backstop.test.ts",
    selectsLoadSensitive: true,
  },
  {
    id: "C",
    label: "docs-only, expected zero selection",
    target: "docs/testing-patterns.md",
    selectsLoadSensitive: false,
  },
];

function markerFor(path: string): string {
  return path.endsWith(".md") ? `\n<!-- ${MARKER} -->\n` : `\n// ${MARKER}\n`;
}

interface Options {
  mode: "load-matrix" | "selection-fraction";
  load: LoadMode;
  runs: number;
  workers: number;
  commits: number;
  controlRuns: number;
  jsonPath: string;
}

function parseLoadMode(raw: string | undefined): LoadMode {
  return raw === "cpu" || raw === "suite" || raw === "both" ? raw : "both";
}

export function parseArgs(argv: string[]): Options {
  const get = (name: string): string | undefined =>
    argv
      .find((a) => a.startsWith(`--${name}=`))
      ?.split("=")
      .slice(1)
      .join("=");
  const mode = get("mode") === "selection-fraction" ? "selection-fraction" : "load-matrix";
  return {
    mode,
    load: parseLoadMode(get("load")),
    runs: Number.parseInt(get("runs") ?? "5", 10),
    // Oversubscribed on purpose: the failures this measures were observed at a
    // load average well above core count, so one worker per core is not the
    // regime of interest.
    workers: Number.parseInt(get("workers") ?? String(cpus().length * 2), 10),
    commits: Number.parseInt(get("commits") ?? "30", 10),
    controlRuns: Number.parseInt(get("control-runs") ?? "2", 10),
    jsonPath: get("json") ?? "scripts/prepush-load-dependence-results.json",
  };
}

// ---------------------------------------------------------------------------
// Diff shaping
// ---------------------------------------------------------------------------

const originals = new Map<string, string>();

function shapeDiff(path: string, appended: string = markerFor(path)): void {
  const content = readFileSync(path, "utf8");
  if (content.includes(MARKER)) {
    throw new Error(
      `${path} already contains a measurement marker — an earlier run was interrupted. ` +
        "Restore the file (git restore) before measuring; refusing to nest markers."
    );
  }
  originals.set(path, content);
  writeFileSync(path, content + appended);
}

/**
 * Extensions safe to shape by appending a byte.
 *
 * Commit replay (SC6) has to make an arbitrary historical file set differ from
 * HEAD, and the cheapest way is to append to each file. A trailing newline is
 * inert in every format listed here; it is NOT inert in a binary, and reading a
 * binary as utf8 and writing it back would corrupt it even before the append. So
 * non-text files are skipped and counted rather than replayed.
 */
const REPLAYABLE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".mdc",
  ".yml",
  ".yaml",
  ".css",
  ".html",
  ".sh",
  ".txt",
  ".toml",
];

function isReplayable(path: string): boolean {
  return REPLAYABLE_EXTENSIONS.some((extension) => path.endsWith(extension));
}

function git(args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "ignore" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} exited ${result.exitCode}`);
  return result.stdout.toString();
}

function nonEmptyLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function restoreAll(): void {
  for (const [path, content] of originals) {
    try {
      writeFileSync(path, content);
    } catch (error) {
      console.error(`FAILED to restore ${path}: ${String(error)}`);
    }
  }
  originals.clear();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    restoreAll();
    process.exit(130);
  });
}

// ---------------------------------------------------------------------------
// Load generation
// ---------------------------------------------------------------------------

interface LoadHandle {
  stop: () => Promise<void>;
  /** False once a load source has exited — the condition lapsed mid-measurement. */
  stillRunning: () => boolean;
}

/**
 * Two load sources, because CPU spin alone provably does not reach the regime
 * the failures live in.
 *
 * Measured 2026-08-10 on this repo: 32 busy-loop workers on 16 cores moved the
 * 1-minute average only from 15.8 to 22.5, and a change-scoped shape-B run
 * completes in about a second — long before a one-MINUTE average responds to
 * anything. Shape B passed 10/10 under that condition, which says the load
 * generator was weak, not that the gate is load-independent.
 *
 * `suite` is the condition mt#3501's own acceptance test names: "Run
 * `bun test src/cockpit/transcript-sweep-backstop.test.ts` concurrently with a
 * full suite run on the same machine." It is the documented reproducer, and it
 * contends for memory and IO as well as CPU — which spin does not.
 */
export type LoadMode = "cpu" | "suite" | "both";

function startLoad(workers: number, mode: LoadMode): LoadHandle {
  const procs: ReturnType<typeof Bun.spawn>[] = [];
  if (mode === "cpu" || mode === "both") {
    for (let i = 0; i < workers; i++) {
      procs.push(
        Bun.spawn(
          [
            "bun",
            "-e",
            // Accumulate into a value the loop reads back, so the work cannot be
            // optimized away into an empty spin.
            "let x = 0; for (;;) { x += Math.sqrt(Math.random()); if (!Number.isFinite(x)) x = 0; }",
          ],
          { stdout: "ignore", stderr: "ignore" }
        )
      );
    }
  }
  let suite: ReturnType<typeof Bun.spawn> | null = null;
  if (mode === "suite" || mode === "both") {
    suite = Bun.spawn(["bun", "scripts/run-tests-main.ts"], {
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env, AGENT: "1" },
    });
    procs.push(suite);
  }
  return {
    stillRunning: () => suite === null || suite.exitCode === null,
    stop: async () => {
      for (const proc of procs) proc.kill();
      await Promise.all(procs.map((proc) => proc.exited));
    },
  };
}

/**
 * Let the load establish itself before measuring.
 *
 * For the suite source this waits a fixed interval rather than on the load
 * average: the suite spends its first seconds discovering files, so starting to
 * measure the moment the process exists would sample the quiet part of it.
 */
async function waitForLoadToRamp(
  baseline: number,
  mode: LoadMode,
  budgetMs: number
): Promise<number> {
  if (mode === "suite" || mode === "both") await Bun.sleep(30_000);
  const deadline = Date.now() + budgetMs;
  let observed = oneMinuteLoad();
  while (Date.now() < deadline && observed < baseline + 1) {
    await Bun.sleep(2000);
    observed = oneMinuteLoad();
  }
  return observed;
}

// ---------------------------------------------------------------------------
// Running the gate
// ---------------------------------------------------------------------------

async function spawnCapturing(
  command: string[],
  extraEnv: Record<string, string> = {}
): Promise<{ exitCode: number; combined: string }> {
  const proc = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, AGENT: "1", ...extraEnv },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, combined: `${stdout}\n${stderr}` };
}

async function runGateOnce(
  shape: Shape,
  condition: "idle" | "loaded",
  extraEnv: Record<string, string> = {}
): Promise<RunOutcome> {
  const loadStart = oneMinuteLoad();
  const startedAt = performance.now();
  const { exitCode, combined } = await spawnCapturing(
    ["bun", "scripts/run-tests-gated.ts"],
    extraEnv
  );
  const wallMs = performance.now() - startedAt;
  return {
    shape: shape.id,
    condition,
    passed: exitCode === 0,
    exitCode,
    wallMs,
    loadStart,
    loadEnd: oneMinuteLoad(),
    selection: parseSelectionLine(combined),
    summary: parseCompletionSummary(combined),
    failures: parseFailingTests(combined),
  };
}

async function measureLoadMatrix(options: Options): Promise<number> {
  const runs: RunOutcome[] = [];
  const control: RunOutcome[] = [];
  let loadLapsed = false;
  const baseline = oneMinuteLoad();
  console.log(
    `mt#3871 load matrix — ${options.runs} runs per condition, ` +
      `${options.workers} load workers on ${cpus().length} cores, baseline load ${baseline.toFixed(2)}.`
  );

  for (const condition of ["idle", "loaded"] as const) {
    let load: LoadHandle | null = null;
    if (condition === "loaded") {
      load = startLoad(options.workers, options.load);
      const achieved = await waitForLoadToRamp(baseline, options.load, 60_000);
      console.log(
        `  load generator up (mode ${options.load}) — 1-min average now ${achieved.toFixed(2)}`
      );
    }
    try {
      for (const shape of SHAPES) {
        shapeDiff(shape.target);
        try {
          for (let i = 0; i < options.runs; i++) {
            const outcome = await runGateOnce(shape, condition);
            runs.push(outcome);
            console.log(
              `  ${condition} shape ${shape.id} run ${i + 1}/${options.runs}: ` +
                `${outcome.passed ? "pass" : `FAIL(${outcome.failures.length})`} ` +
                `${(outcome.wallMs / 1000).toFixed(2)}s load ${outcome.loadStart.toFixed(1)}→${outcome.loadEnd.toFixed(1)} ` +
                `selected ${selectedCount(outcome.selection)}`
            );
          }
        } finally {
          restoreAll();
        }
      }
      if (condition === "loaded" && options.controlRuns > 0) {
        // The positive control: the SAME diff, the SAME load, but the gate forced
        // back to its pre-mt#3562 unscoped behaviour. Without a control that
        // FAILS, an all-pass scoped result cannot be distinguished from a load
        // condition too weak to break anything.
        const sensitive = SHAPES.find((s) => s.selectsLoadSensitive);
        if (sensitive) {
          shapeDiff(sensitive.target);
          try {
            for (let i = 0; i < options.controlRuns; i++) {
              const outcome = await runGateOnce(sensitive, "loaded", {
                MINSKY_PREPUSH_FULL_SUITE: "1",
              });
              control.push(outcome);
              console.log(
                `  CONTROL (unscoped) run ${i + 1}/${options.controlRuns}: ` +
                  `${outcome.passed ? "pass" : `FAIL(${outcome.failures.length})`} ` +
                  `${(outcome.wallMs / 1000).toFixed(1)}s load ${outcome.loadStart.toFixed(1)}→${outcome.loadEnd.toFixed(1)} ` +
                  `${outcome.summary ? `${outcome.summary.tests} tests` : "no summary"}`
              );
            }
          } finally {
            restoreAll();
          }
        }
      }
    } finally {
      if (condition === "loaded" && load !== null && !load.stillRunning()) {
        // The suite load source finished before the loaded arm did, so some runs
        // were taken under a weaker condition than the label claims. Say so
        // rather than letting the label stand for whatever actually happened.
        loadLapsed = true;
        console.log("  WARNING: the suite load source exited before the loaded arm finished.");
      }
      await load?.stop();
    }
  }

  const straddleByShape = new Map<string, ShapeResult["straddle"]>();
  for (const shape of SHAPES) {
    straddleByShape.set(
      shape.id,
      straddleCheck(
        runs.filter((r) => r.shape === shape.id && r.condition === "idle"),
        runs.filter((r) => r.shape === shape.id && r.condition === "loaded")
      )
    );
  }
  const shapeResults: ShapeResult[] = SHAPES.map((shape) => ({
    shape: shape.id,
    selectsLoadSensitive: shape.selectsLoadSensitive,
    straddle: straddleByShape.get(shape.id) ?? { kind: "insufficient-data" },
  }));
  const controlSummary = {
    runs: control.length,
    failedRuns: control.filter((r) => !r.passed).length,
  };
  const verdict = deriveVerdict(shapeResults, control.length > 0 ? controlSummary : undefined);

  const report = {
    task: "mt#3871",
    cores: cpus().length,
    loadMode: options.load,
    workers: options.workers,
    runsPerCondition: options.runs,
    baselineLoad: baseline,
    loadLapsed,
    loadSensitiveTestFiles: LOAD_SENSITIVE_TEST_FILES,
    shapes: SHAPES.map((shape) => ({
      ...shape,
      idle: summarizeCondition(runs.filter((r) => r.shape === shape.id && r.condition === "idle")),
      loaded: summarizeCondition(
        runs.filter((r) => r.shape === shape.id && r.condition === "loaded")
      ),
      straddle: straddleByShape.get(shape.id) ?? { kind: "insufficient-data" },
    })),
    positiveControl: {
      ...controlSummary,
      description: "same diff, same load, MINSKY_PREPUSH_FULL_SUITE=1 (pre-mt#3562 behaviour)",
      summary: summarizeCondition(control),
      runs_detail: control,
    },
    verdict,
    runs,
  };
  writeFileSync(options.jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nSC7 verdict: ${verdict.verdict} — ${verdict.rationale}`);
  console.log(`Full results written to ${options.jsonPath}`);
  return 0;
}

// ---------------------------------------------------------------------------
// Selection fraction (SC6)
// ---------------------------------------------------------------------------

async function probeSelection(ref: string): Promise<SelectionReport | null> {
  const { combined } = await spawnCapturing([
    "bun",
    "test",
    `--changed=${ref}`,
    ...LOAD_SENSITIVE_TEST_FILES,
    "-t",
    NEVER_MATCHING_TEST_NAME,
  ]);
  return parseSelectionLine(combined);
}

async function measureSelectionFraction(options: Options): Promise<number> {
  console.log(
    `mt#3871 selection fraction — probing HEAD~0..HEAD~${options.commits} against ` +
      `${LOAD_SENSITIVE_TEST_FILES.length} load-sensitive files.`
  );
  const shas = nonEmptyLines(git(["log", "--format=%H", "-n", String(options.commits)]));
  const results: CommitSelection[] = [];

  for (const sha of shas) {
    // First-parent diff, so a merge commit is measured by what it BROUGHT IN —
    // which is the diff a push would have gated on.
    const changed = nonEmptyLines(git(["diff", "--name-only", `${sha}~1`, sha]));
    const replayable = changed.filter((path) => isReplayable(path) && existsSync(path));
    if (replayable.length === 0) {
      results.push({
        sha,
        filesReplayed: 0,
        filesMissing: changed.length,
        selected: 0,
      });
      console.log(`  ${sha.slice(0, 9)}: unreplayable (0 of ${changed.length} files present)`);
      continue;
    }
    let selected = 0;
    try {
      for (const path of replayable) shapeDiff(path, "\n");
      const report = await probeSelection("HEAD");
      if (report === null) {
        console.error(
          `Could not read a --changed selection line for ${sha} — measurement not taken.`
        );
        return 1;
      }
      selected = selectedCount(report);
    } finally {
      restoreAll();
    }
    results.push({
      sha,
      filesReplayed: replayable.length,
      filesMissing: changed.length - replayable.length,
      selected,
    });
    console.log(
      `  ${sha.slice(0, 9)}: ${selected}/${LOAD_SENSITIVE_TEST_FILES.length} ` +
        `(${replayable.length} of ${changed.length} files replayed)`
    );
  }

  const fraction = summarizeCommitSelection(results);
  const outPath = options.jsonPath.replace(/\.json$/, "-selection.json");
  writeFileSync(
    outPath,
    `${JSON.stringify(
      { task: "mt#3871", loadSensitiveTestFiles: LOAD_SENSITIVE_TEST_FILES, results, fraction },
      null,
      2
    )}\n`
  );
  console.log(
    `\n${fraction.commitsSelecting}/${fraction.commitsExamined} replayable commits ` +
      `(${(fraction.fraction * 100).toFixed(1)}%) select at least one load-sensitive test file. ` +
      `${fraction.commitsUnreplayable} commit(s) could not be replayed.`
  );
  console.log(`Full results written to ${outPath}`);
  return 0;
}

if (import.meta.main) {
  const options = parseArgs(process.argv.slice(2));
  let exitCode = 1;
  try {
    exitCode =
      options.mode === "selection-fraction"
        ? await measureSelectionFraction(options)
        : await measureLoadMatrix(options);
  } catch (error) {
    console.error(`mt#3871 measurement could not be taken: ${String(error)}`);
    exitCode = 1;
  } finally {
    restoreAll();
  }
  process.exit(exitCode);
}
