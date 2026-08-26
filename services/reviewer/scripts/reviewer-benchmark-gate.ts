#!/usr/bin/env bun
/**
 * Reviewer benchmark regression gate (mt#2991 Milestone B).
 *
 * Two independent jobs, run together because the second's OUTPUT MODE
 * depends on the first's result:
 *
 *   1. **Trust gate.** Read the judge-vs-human-gold kappa (mt#2746's
 *      calibration snapshot, written by `score-human-labels.ts --out`).
 *      Below the configured threshold (or with no snapshot at all —
 *      fail-closed, not fail-open), every metric this run reports is
 *      labeled "judge verdict distribution only — not ground truth". At or
 *      above threshold, the judge is trusted and metrics are reported as
 *      calibrated measurements.
 *   2. **Regression gate.** Run mt#2726's paired-eval-runner against the
 *      CURRENT prompt/model config over the fixed corpus, compute graduated
 *      metrics (precision/recall/f1/falsePositiveRate/verdictMcc), and
 *      compare against a committed baseline snapshot
 *      (`services/reviewer/eval/baseline-metrics.json`). Exit non-zero if
 *      any metric regresses beyond its configured threshold.
 *
 * ## Detection-floor caveat (mt#2991 amendment item 1)
 *
 * This gate's own recall/precision numbers are computed against the SAME
 * corpus `services/reviewer/eval/statistical-power.ts` measured a ~25
 * percentage-point detection floor for (85 positive rows / 65 PRs — see
 * `services/reviewer/eval/detection-floor.json`). A metric delta smaller
 * than that floor is inside sampling noise for THIS gate too, not only for
 * the model-tier comparisons mt#4554 ran. The default regression thresholds
 * below are set well above the floor precisely so a real prompt-principle
 * regression (the scenario this gate exists to catch) fires reliably while
 * noise-sized deltas do not — this is a coarse, "did something break"
 * check, not a fine-grained A/B instrument.
 *
 * ## Usage
 *
 *   bun services/reviewer/scripts/reviewer-benchmark-gate.ts --dry-run
 *   bun services/reviewer/scripts/reviewer-benchmark-gate.ts \
 *     --model openai:gpt-5 --sample 8 --attempts 1
 *
 * `--dry-run` prints the loaded baseline + trust-gate mode and exits 0
 * without any live model or GitHub call — use it to validate wiring.
 *
 * A live run (no `--dry-run`) requires OPENAI_API_KEY (or the equivalent
 * for the requested provider) and GITHUB_TOKEN/OCTOKIT_AUTH in the
 * environment, OR the equivalent values in Minsky's own configuration
 * (`ai.providers.<provider>.apiKey`, `github.token`) — resolved locally by
 * this script (see `resolveCredential` below) rather than by importing
 * `harness-config-auth.ts`'s in-flight extension (mt#4620, PR #3373,
 * approved-but-unmerged as of this writing) to avoid touching a file that
 * task owns.
 *
 * @see mt#2991 — this task
 * @see mt#2726 — the paired-eval runner this gate invokes as a subprocess
 * @see mt#2746 — the human gold set / calibration snapshot this gate trusts
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REVIEWER_DIR = resolve(SCRIPT_DIR, "..");
const REPO_ROOT = resolve(REVIEWER_DIR, "..", "..");

// ---------------------------------------------------------------------------
// Trust gate (pure, unit-tested with synthetic kappa data — AT2)
// ---------------------------------------------------------------------------

/** The judge-vs-human calibration snapshot's shape, per `score-human-labels.ts`. */
export interface KappaCalibrationSnapshot {
  computedAt: string;
  kappa: number | null;
  degenerate?: "single-category";
  n: number;
}

/** Trust-mode discriminant values — exported so callers (and this module's
 * own test file) reference one shared literal instead of re-typing the
 * string, per the repo's no-magic-string-duplication lint rule. */
export const TRUST_MODE_CALIBRATED = "calibrated" as const;
export const TRUST_MODE_DISTRIBUTION_ONLY = "distribution-only" as const;

export type TrustMode =
  | { mode: typeof TRUST_MODE_CALIBRATED; kappa: number; n: number; threshold: number }
  | { mode: typeof TRUST_MODE_DISTRIBUTION_ONLY; reason: string; threshold: number };

/** Default: 0.6 "substantial agreement" (Landis-Koch) — the spec's proposed
 * default, pending the operator's decision (mt#2991 Open Questions / the
 * kappa-threshold ask this task files). */
export const DEFAULT_KAPPA_THRESHOLD = 0.6;

/** A kappa computed from fewer than this many paired rows is not trusted
 * regardless of its value — per the spec's own n~=40 SE~=0.15 anchor and
 * `statistical-power.ts`'s sizing table, a kappa at very low n can clear
 * the threshold by sampling luck alone. */
export const MIN_TRUSTED_N = 30;

/**
 * Decide the trust mode from a calibration snapshot (or its absence).
 * Pure — every branch is reachable with synthetic input, which is what lets
 * AT2 ("with a synthetic gold slice engineered so measured kappa is below
 * threshold...") be verified without any real human labels.
 */
export function determineTrustMode(
  snapshot: KappaCalibrationSnapshot | null,
  threshold: number = DEFAULT_KAPPA_THRESHOLD,
  minN: number = MIN_TRUSTED_N
): TrustMode {
  if (!snapshot) {
    return {
      mode: TRUST_MODE_DISTRIBUTION_ONLY,
      reason: "no calibration snapshot found — judge has never been calibrated against human gold",
      threshold,
    };
  }
  if (snapshot.kappa === null) {
    return {
      mode: TRUST_MODE_DISTRIBUTION_ONLY,
      reason: `kappa is undefined (${snapshot.degenerate ?? "degenerate"}) — cannot trust`,
      threshold,
    };
  }
  if (snapshot.n < minN) {
    return {
      mode: TRUST_MODE_DISTRIBUTION_ONLY,
      reason:
        `n=${snapshot.n} is below the minimum trusted n=${minN} — kappa could clear ` +
        `threshold on sampling noise alone at this n (see statistical-power.ts)`,
      threshold,
    };
  }
  if (snapshot.kappa < threshold) {
    return {
      mode: TRUST_MODE_DISTRIBUTION_ONLY,
      reason: `kappa=${snapshot.kappa.toFixed(4)} (n=${snapshot.n}) is below threshold=${threshold}`,
      threshold,
    };
  }
  return { mode: TRUST_MODE_CALIBRATED, kappa: snapshot.kappa, n: snapshot.n, threshold };
}

export function formatTrustModeLine(mode: TrustMode): string {
  if (mode.mode === TRUST_MODE_CALIBRATED) {
    return (
      `CALIBRATED (kappa=${mode.kappa.toFixed(4)}, n=${mode.n}, threshold=${mode.threshold}) — ` +
      `judge verdicts on this run are trusted as a measurement.`
    );
  }
  return (
    `DISTRIBUTION-ONLY — NOT GROUND TRUTH (threshold=${mode.threshold}): ${mode.reason}. ` +
    `Metrics below describe what the judge SAID, not what is TRUE.`
  );
}

// ---------------------------------------------------------------------------
// Regression comparison (pure, unit-tested with synthetic metrics)
// ---------------------------------------------------------------------------

export interface GraduatedMetrics {
  precision: number;
  recall: number;
  f1: number;
  falsePositiveRate: number;
  verdictMcc: number;
}

/** For each metric, the max allowed regression in absolute terms (e.g. 0.20
 * = 20 percentage points) before the gate fails. Set well above the ~25pp
 * detection floor (see module docblock) so this is a coarse break-detector,
 * not a fine A/B instrument. `falsePositiveRate` regresses UPWARD (more
 * false positives is worse); every other metric regresses DOWNWARD. */
export const DEFAULT_REGRESSION_THRESHOLDS: GraduatedMetrics = {
  precision: 0.3,
  recall: 0.3,
  f1: 0.3,
  falsePositiveRate: 0.3,
  verdictMcc: 0.3,
};

export interface MetricComparison {
  metric: keyof GraduatedMetrics;
  baseline: number;
  current: number;
  delta: number;
  threshold: number;
  regressed: boolean;
}

const HIGHER_IS_WORSE: ReadonlySet<keyof GraduatedMetrics> = new Set(["falsePositiveRate"]);

/**
 * Compare a current run's graduated metrics against a committed baseline.
 * Pure — takes plain metric objects, never touches disk or the network, so
 * AT3's "a deliberately removed prompt principle produces a measurable
 * delta AND a non-zero exit" is verifiable against a hand-built regressed
 * metrics object without a live run.
 */
export function compareMetrics(
  baseline: GraduatedMetrics,
  current: GraduatedMetrics,
  thresholds: GraduatedMetrics = DEFAULT_REGRESSION_THRESHOLDS
): MetricComparison[] {
  const metrics: (keyof GraduatedMetrics)[] = [
    "precision",
    "recall",
    "f1",
    "falsePositiveRate",
    "verdictMcc",
  ];
  return metrics.map((metric) => {
    const b = baseline[metric];
    const c = current[metric];
    const threshold = thresholds[metric];
    const higherIsWorse = HIGHER_IS_WORSE.has(metric);
    const delta = higherIsWorse ? c - b : b - c;
    return { metric, baseline: b, current: c, delta, threshold, regressed: delta > threshold };
  });
}

export function anyRegressed(comparisons: MetricComparison[]): boolean {
  return comparisons.some((c) => c.regressed);
}

// ---------------------------------------------------------------------------
// Credential resolution (self-contained — see module docblock on why this
// does not import harness-config-auth.ts's in-flight mt#4620 extension)
// ---------------------------------------------------------------------------

async function resolveCredential(
  envVarName: string,
  configPath: string[]
): Promise<string | undefined> {
  const fromEnv = process.env[envVarName];
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv;
  try {
    const { setupConfiguration } = await import("@minsky/domain/config-setup");
    const { getConfiguration, isConfigurationInitialized } = await import(
      "@minsky/domain/configuration/index"
    );
    if (!isConfigurationInitialized()) await setupConfiguration();
    let value: unknown = getConfiguration();
    for (const segment of configPath) {
      value = (value as Record<string, unknown> | undefined)?.[segment];
    }
    return typeof value === "string" && value.trim().length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface ParsedArgs {
  model: string;
  sample: number;
  attempts: number;
  dryRun: boolean;
  baselinePath: string;
  calibrationPath: string;
  corpusPath: string;
  threshold: number;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    model: "openai:gpt-5",
    sample: 8,
    attempts: 1,
    dryRun: false,
    baselinePath: resolve(REVIEWER_DIR, "eval", "baseline-metrics.json"),
    calibrationPath: resolve(REVIEWER_DIR, "eval", "corpus", "kappa-calibration.json"),
    corpusPath: resolve(REVIEWER_DIR, "eval", "corpus", "ground-truth-v1.jsonl"),
    threshold: DEFAULT_KAPPA_THRESHOLD,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--model") args.model = argv[++i] ?? args.model;
    else if (arg === "--sample") args.sample = Number(argv[++i] ?? args.sample);
    else if (arg === "--attempts") args.attempts = Number(argv[++i] ?? args.attempts);
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--baseline") args.baselinePath = resolve(argv[++i] ?? args.baselinePath);
    else if (arg === "--calibration")
      args.calibrationPath = resolve(argv[++i] ?? args.calibrationPath);
    else if (arg === "--corpus") args.corpusPath = resolve(argv[++i] ?? args.corpusPath);
    else if (arg === "--kappa-threshold") args.threshold = Number(argv[++i] ?? args.threshold);
  }
  return args;
}

function loadBaseline(path: string): { config: string; metrics: GraduatedMetrics } {
  if (!existsSync(path)) {
    throw new Error(
      `${path}: no baseline snapshot. Run this gate once with --write-baseline against a ` +
        `known-good config to create one.`
    );
  }
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
    modelConfig: string;
    metrics: GraduatedMetrics;
  };
  return { config: parsed.modelConfig, metrics: parsed.metrics };
}

function loadCalibration(path: string): KappaCalibrationSnapshot | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as KappaCalibrationSnapshot;
}

/** Run mt#2726's paired-eval-runner as a subprocess for one config over the
 * fixed corpus, returning its per-config graduated metrics. */
async function runPairedEval(
  args: ParsedArgs
): Promise<{ config: string; metrics: GraduatedMetrics }> {
  const openaiKey = await resolveCredential("OPENAI_API_KEY", [
    "ai",
    "providers",
    "openai",
    "apiKey",
  ]);
  const githubToken = await resolveCredential("GITHUB_TOKEN", ["github", "token"]);
  if (!openaiKey && args.model.startsWith("openai:")) {
    throw new Error(
      "No OpenAI credential resolved (env OPENAI_API_KEY or config ai.providers.openai.apiKey)."
    );
  }
  if (!githubToken) {
    throw new Error(
      "No GitHub credential resolved (env GITHUB_TOKEN/OCTOKIT_AUTH or config github.token)."
    );
  }

  const outPath = resolve(REVIEWER_DIR, "eval", "results", `gate-run-${Date.now()}.json`);
  const runnerPath = resolve(REVIEWER_DIR, "scripts", "paired-eval-runner.ts");
  const result = Bun.spawnSync(
    [
      "bun",
      runnerPath,
      "--model",
      args.model,
      "--sample",
      String(args.sample),
      "--attempts",
      String(args.attempts),
      "--corpus",
      args.corpusPath,
      "--out",
      outPath,
    ],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, OPENAI_API_KEY: openaiKey ?? "", GITHUB_TOKEN: githubToken },
      timeout: 10 * 60 * 1000,
    }
  );
  const stdout = result.stdout.toString("utf-8");
  const stderr = result.stderr.toString("utf-8");
  if (result.exitCode !== 0) {
    throw new Error(
      `paired-eval-runner.ts exited ${result.exitCode}. stdout:\n${stdout}\nstderr:\n${stderr}`
    );
  }
  console.log(stdout);

  const artifact = JSON.parse(readFileSync(outPath, "utf-8")) as {
    configs: (GraduatedMetrics & { modelConfig: string })[];
  };
  const config = artifact.configs[0];
  if (!config) {
    throw new Error(`${outPath}: paired-eval-runner produced no config results`);
  }
  return {
    config: config.modelConfig,
    metrics: {
      precision: config.precision,
      recall: config.recall,
      f1: config.f1,
      falsePositiveRate: config.falsePositiveRate,
      verdictMcc: config.verdictMcc,
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const writeBaseline = process.argv.includes("--write-baseline");

  console.log("=== Reviewer benchmark gate (mt#2991) ===");
  console.log(`Model config: ${args.model}  sample=${args.sample} attempts=${args.attempts}`);

  const calibration = loadCalibration(args.calibrationPath);
  const trustMode = determineTrustMode(calibration, args.threshold);
  console.log(`\nTrust gate: ${formatTrustModeLine(trustMode)}`);

  if (args.dryRun) {
    let baselineInfo = "none";
    if (existsSync(args.baselinePath)) {
      const baseline = loadBaseline(args.baselinePath);
      baselineInfo = `${baseline.config} -> ${JSON.stringify(baseline.metrics)}`;
    }
    console.log(`\nDRY RUN — no live calls made.`);
    console.log(`Baseline (${args.baselinePath}): ${baselineInfo}`);
    console.log(
      `Calibration (${args.calibrationPath}): ${calibration ? JSON.stringify(calibration) : "none"}`
    );
    return;
  }

  const runResult = await runPairedEval(args);
  console.log(`\nCurrent run (${runResult.config}):`);
  console.log(JSON.stringify(runResult.metrics, null, 2));

  if (writeBaseline) {
    const snapshot = {
      writtenAt: new Date().toISOString(),
      modelConfig: runResult.config,
      sample: args.sample,
      attempts: args.attempts,
      corpusPath: args.corpusPath,
      metrics: runResult.metrics,
    };
    writeFileSync(args.baselinePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");
    console.log(`\nBaseline written: ${args.baselinePath}`);
    return;
  }

  const baseline = loadBaseline(args.baselinePath);
  const comparisons = compareMetrics(baseline.metrics, runResult.metrics);

  console.log(`\nComparison against baseline (${baseline.config}):`);
  for (const c of comparisons) {
    const flag = c.regressed ? " REGRESSED" : "";
    console.log(
      `  ${c.metric.padEnd(18)} baseline=${c.baseline.toFixed(4)} current=${c.current.toFixed(4)} ` +
        `delta=${c.delta.toFixed(4)} threshold=${c.threshold.toFixed(4)}${flag}`
    );
  }

  if (anyRegressed(comparisons)) {
    console.error("\nFAIL: at least one graduated metric regressed beyond its threshold.");
    process.exit(1);
  }
  console.log("\nPASS: no graduated metric regressed beyond its threshold.");
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
