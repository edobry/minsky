#!/usr/bin/env bun
/**
 * Paired-evaluation runner (mt#2726 Milestone A, wave 3).
 *
 * Replays an arbitrary list of model/provider configs against the committed
 * ground-truth corpus (`../eval/corpus/ground-truth-v1.jsonl`, see
 * `../src/eval-corpus.ts`) and reports precision/recall/F1/severity-stratified
 * recall/FP-rate/verdict-MCC/pass@k/pass^k for every config **in one run over
 * the identical corpus**, writing a single comparative JSON artifact.
 *
 * Generalizes `measure-calibration.ts`: reuses its `fetchIterationContext`
 * (PR-context reconstruction) and the `IterationContext` shape rather than
 * reimplementing them. Its `runAttempts` is OpenAI-client-specific
 * (`callOpenAIWithClient`); this runner instead calls `providers.ts`'s
 * `callReviewer()` directly (the multi-provider dispatcher) so the same
 * multi-attempt-loop PATTERN generalizes across openai/google/anthropic
 * configs in one pass, per the mt#2726 spec's explicit multi-config
 * requirement.
 *
 * Usage:
 *   bun services/reviewer/scripts/paired-eval-runner.ts --dry-run
 *   bun services/reviewer/scripts/paired-eval-runner.ts \
 *     --model openai:gpt-5 --model openai:gpt-5-mini --sample 8 --attempts 3
 *
 * Flags:
 *   --corpus <path>    Corpus JSONL path. Default: the committed v1 corpus.
 *   --model <p:m>      Repeatable. "<provider>:<model>", e.g. "openai:gpt-5".
 *                      Default: [openai:gpt-5, openai:gpt-5-mini] — the
 *                      exact mt#2718 comparison this benchmark exists to
 *                      answer (spec Acceptance Test #4).
 *   --sample N         Number of corpus PRs to replay. Default 8.
 *   --attempts K       Attempts per PR per config. Default 1.
 *   --out <path>       Output artifact path. Default: a non-clobbering,
 *                      corpus-version + sample + attempts + timestamp-keyed
 *                      path under ../eval/results/.
 *   --dry-run          Load the corpus, print the PR grouping + sample +
 *                      config summary, and exit — no network calls at all
 *                      (neither GitHub nor the model). Unlike
 *                      measure-calibration.ts's dry-run (which also
 *                      exercises the GitHub fetch to print prompt-size
 *                      diagnostics), this runner's dry-run intentionally
 *                      stops before ANY network call: its job is to
 *                      validate corpus + config wiring, not per-PR context
 *                      fetch — the live path is what exercises
 *                      fetchIterationContext.
 *
 * Live runs require OPENAI_API_KEY (gating check below — at minimum one
 * configured provider must be reachable) plus OCTOKIT_AUTH or GITHUB_TOKEN
 * (for fetchIterationContext's PR-context reconstruction). Neither is
 * required for --dry-run.
 */

import { Octokit } from "@octokit/rest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseCorpusJsonlWithStats, type CorpusRow } from "../src/eval-corpus";
import {
  f1,
  falsePositiveRate,
  passAtK,
  passCaretK,
  precision,
  recall,
  severityStratifiedRecall,
  verdictMcc,
  type FindingVerdict,
} from "../src/eval-metrics";
import { parseFindingsFromBody, type FlatFinding } from "../src/replay-summary";
import { callReviewer, type ReviewOutput } from "../src/providers";
import { buildCriticConstitution, buildReviewPrompt } from "../src/prompt";
import type { ReviewerConfig } from "../src/config";
import { fetchIterationContext, type IterationContext } from "./measure-calibration";
import { resolveGitHubToken } from "./harness-auth";

// ---------------------------------------------------------------------------
// Paths + constants
// ---------------------------------------------------------------------------

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CORPUS_PATH = join(SCRIPT_DIR, "..", "eval", "corpus", "ground-truth-v1.jsonl");
const RESULTS_DIR = join(SCRIPT_DIR, "..", "eval", "results");

const DEFAULT_SAMPLE = 8;
const DEFAULT_ATTEMPTS = 1;

/** Per-call timeout budget for the eval harness — independent of production's
 * REVIEWER_MODEL_TIMEOUT_MS (mt#1086); generous since eval runs are offline. */
const EVAL_MODEL_TIMEOUT_MS = 300_000;

type Provider = ReviewerConfig["provider"];

interface ModelConfigArg {
  provider: Provider;
  model: string;
}

/** The exact gpt-5-vs-gpt-5-mini comparison mt#2718 needs (spec Acceptance
 * Test #4) — the default so a bare `--dry-run` invocation (no --model flags)
 * still prints a meaningful config summary. */
const DEFAULT_MODELS: readonly ModelConfigArg[] = [
  { provider: "openai", model: "gpt-5" },
  { provider: "openai", model: "gpt-5-mini" },
];

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  corpusPath: string;
  models: ModelConfigArg[];
  sample: number;
  attempts: number;
  outPath: string | undefined;
  dryRun: boolean;
}

function parseModelArg(raw: string): ModelConfigArg {
  const sep = raw.indexOf(":");
  if (sep <= 0 || sep === raw.length - 1) {
    console.error(`ERROR: --model must be "<provider>:<model>", got "${raw}"`);
    process.exit(2);
  }
  const provider = raw.slice(0, sep);
  const model = raw.slice(sep + 1);
  if (provider !== "openai" && provider !== "google" && provider !== "anthropic") {
    console.error(
      `ERROR: --model provider must be one of openai|google|anthropic, got "${provider}"`
    );
    process.exit(2);
  }
  return { provider, model };
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const models: ModelConfigArg[] = [];
  let corpusPath = DEFAULT_CORPUS_PATH;
  let sample = DEFAULT_SAMPLE;
  let attempts = DEFAULT_ATTEMPTS;
  let outPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;

    if (arg === "--corpus") {
      const value = args[++i];
      if (value !== undefined) corpusPath = value;
    } else if (arg === "--model") {
      const value = args[++i];
      if (value !== undefined) models.push(parseModelArg(value));
    } else if (arg === "--sample") {
      const value = args[++i];
      const parsed = value !== undefined ? parseInt(value, 10) : NaN;
      if (Number.isFinite(parsed) && parsed > 0) sample = parsed;
    } else if (arg === "--attempts") {
      const value = args[++i];
      const parsed = value !== undefined ? parseInt(value, 10) : NaN;
      if (Number.isFinite(parsed) && parsed > 0) attempts = parsed;
    } else if (arg === "--out") {
      const value = args[++i];
      if (value !== undefined) outPath = value;
    }
  }

  return {
    corpusPath,
    models: models.length > 0 ? models : [...DEFAULT_MODELS],
    sample,
    attempts,
    outPath,
    dryRun,
  };
}

// ---------------------------------------------------------------------------
// Corpus grouping + sampling (pure)
// ---------------------------------------------------------------------------

/** Group corpus rows by source PR — each PR's rows are its labeled ground
 * truth (possibly spanning multiple review rounds). Exported for tests. */
export function groupCorpusRowsByPr(rows: readonly CorpusRow[]): Map<number, CorpusRow[]> {
  const grouped = new Map<number, CorpusRow[]>();
  for (const row of rows) {
    const existing = grouped.get(row.prNumber);
    if (existing) {
      existing.push(row);
    } else {
      grouped.set(row.prNumber, [row]);
    }
  }
  return grouped;
}

/**
 * Deterministically sample up to `sampleSize` PR numbers from the grouped
 * corpus: ascending PR number, so repeated dry-runs and repeated live runs
 * over the same corpus + --sample pick the identical subset (reproducible
 * comparisons across model configs run in separate invocations). Exported
 * for tests.
 */
export function samplePrNumbers(
  grouped: ReadonlyMap<number, CorpusRow[]>,
  sampleSize: number
): number[] {
  return Array.from(grouped.keys())
    .sort((a, b) => a - b)
    .slice(0, sampleSize);
}

/**
 * A ground-truth row is "positive" (the underlying finding was real) when
 * its label confidence is `gold` (injected-bug, unambiguous) or
 * `noisy-positive` (git-diff-fixed — the region was touched in a later
 * round, deterministic-but-imperfect evidence of a real fix). All other
 * confidence tags (`noisy-negative`: dismissed-no-change,
 * carried-forward-unchanged) are treated as negative ground truth.
 *
 * This is the confidence-tag reading of the mt#2726 spec's explicit mapping
 * ("A corpus row whose label indicates the finding was real/addressed
 * (git-diff-fixed) counts as a positive ground-truth; dismissed-no-change is
 * a weak-negative") — using `confidence` rather than hardcoding `value`
 * strings keeps this correct as the mining pipeline's label taxonomy grows
 * (e.g. a future `judge-verdict` row is positive/negative purely by which
 * confidence tag the judge pass assigned it, with no change needed here).
 *
 * Pure. Exported for tests.
 */
export function isPositiveGroundTruth(row: CorpusRow): boolean {
  return row.label.confidence === "gold" || row.label.confidence === "noisy-positive";
}

// ---------------------------------------------------------------------------
// Matching + scoring (pure, unit-tested)
// ---------------------------------------------------------------------------

/** Max line-number distance for a produced finding to count as citing the
 * same location as a ground-truth finding. Mirrors
 * `mine-ground-truth-corpus.ts`'s `RE_RAISE_LINE_PROXIMITY` convention (same
 * ±5-line window used there to decide whether a next-round finding re-raises
 * a prior one) — kept as a separate local constant since the two scripts
 * don't share a module boundary, but the value and rationale are identical:
 * review rounds routinely re-cite the same concern with a slightly different
 * line number as unrelated code shifts above it. */
const LOCATION_LINE_PROXIMITY = 5;

function locationsMatch(
  a: { file: string; line?: number },
  b: { file: string; line?: number }
): boolean {
  if (a.file !== b.file) return false;
  // Either side lacking a line number: file match is the best signal
  // available, mirroring findingReRaised's same-fallback in
  // mine-ground-truth-corpus.ts.
  if (a.line === undefined || b.line === undefined) return true;
  return Math.abs(a.line - b.line) <= LOCATION_LINE_PROXIMITY;
}

export interface FindingMatch {
  producedIndex: number;
  groundTruthIndex: number;
}

export interface ScoreModelFindingsResult {
  /** Produced findings matching >=1 POSITIVE ground-truth row. */
  tp: number;
  /** Produced findings matching NO positive ground-truth row (precision/
   * recall sense — broad: covers both "matched a negative row" and "matched
   * nothing at all", since either way the model asserted something the
   * corpus doesn't confirm as real). */
  fp: number;
  /** POSITIVE ground-truth rows matched by no produced finding (missed). */
  fn: number;
  /** NEGATIVE ground-truth rows matched by no produced finding (correctly
   * not re-flagged — the MCC "true negative" quadrant). */
  tn: number;
  /** Narrower false-positive count (MCC sense): produced findings that
   * specifically re-flag a NEGATIVE (dismissed) ground-truth row, as
   * opposed to asserting something with no ground-truth row at all. Not
   * used by precision/recall (see `fp` above) — only by the verdict
   * taxonomy below. */
  fpMatchingNegative: number;
  /**
   * Per-produced-finding verdict, same order as the `produced` input, for
   * `eval-metrics.falsePositiveRate`'s Bug-Hit/Valid/Noise taxonomy:
   *   - BUG_HIT: matches >=1 positive ground-truth row.
   *   - NOISE:   matches >=1 negative ground-truth row and no positive one.
   *   - VALID:   matches no ground-truth row at all — a novel assertion
   *              the corpus has no opinion on either way, so it's neither
   *              confirmed-bug nor confirmed-spurious.
   */
  verdicts: FindingVerdict[];
  /** tp/fn split by the ground-truth finding's severity bucket, for
   * `eval-metrics.severityStratifiedRecall`. */
  severityCounts: Record<string, { tp: number; fn: number }>;
  matches: FindingMatch[];
}

/**
 * Score one model's produced findings against a PR's ground-truth corpus
 * rows. Matching: same file + line within `LOCATION_LINE_PROXIMITY` (or a
 * file-only match when either side lacks a line number).
 *
 * tp/fp/fn mapping (documented per the mt#2726 spec's explicit instruction):
 *   - tp: a produced finding matches >=1 POSITIVE ground-truth row.
 *   - fp: a produced finding matches NO positive ground-truth row (whether
 *     it matches a negative row or nothing at all — asserting something the
 *     corpus doesn't confirm as real).
 *   - fn: a POSITIVE ground-truth row matched by no produced finding (the
 *     model missed a real, previously-fixed issue).
 *   - tn: a NEGATIVE ground-truth row matched by no produced finding (the
 *     model correctly stayed silent on a dismissed non-issue) — the MCC
 *     "true negative" quadrant, which precision/recall/F1 don't need but
 *     `verdictMcc` does.
 *
 * A single produced finding can match multiple ground-truth rows (e.g. two
 * corpus rows from different review rounds citing the same location); each
 * match is recorded, and a produced finding counts as tp once it matches
 * ANY positive row (not once per matching row) — see the per-produced-finding
 * loop below.
 *
 * Pure. No I/O, no network. Exported for unit testing.
 */
export function scoreModelFindings(
  produced: readonly FlatFinding[],
  groundTruth: readonly CorpusRow[]
): ScoreModelFindingsResult {
  const matches: FindingMatch[] = [];
  const matchedPositiveGtIndices = new Set<number>();
  const matchedNegativeGtIndices = new Set<number>();
  const verdicts: FindingVerdict[] = [];

  let tp = 0;
  let fp = 0;
  let fpMatchingNegative = 0;

  for (let pi = 0; pi < produced.length; pi++) {
    const p = produced[pi];
    if (p === undefined) continue;

    let matchedPositive = false;
    let matchedNegative = false;

    for (let gi = 0; gi < groundTruth.length; gi++) {
      const gt = groundTruth[gi];
      if (gt === undefined) continue;
      if (!locationsMatch(p, gt.finding)) continue;

      matches.push({ producedIndex: pi, groundTruthIndex: gi });

      if (isPositiveGroundTruth(gt)) {
        matchedPositive = true;
        matchedPositiveGtIndices.add(gi);
      } else {
        matchedNegative = true;
        matchedNegativeGtIndices.add(gi);
      }
    }

    if (matchedPositive) {
      tp += 1;
      verdicts.push("BUG_HIT");
    } else {
      fp += 1;
      if (matchedNegative) {
        fpMatchingNegative += 1;
        verdicts.push("NOISE");
      } else {
        verdicts.push("VALID");
      }
    }
  }

  let fn = 0;
  let tn = 0;
  const severityCounts: Record<string, { tp: number; fn: number }> = {};

  for (let gi = 0; gi < groundTruth.length; gi++) {
    const gt = groundTruth[gi];
    if (gt === undefined) continue;

    const positive = isPositiveGroundTruth(gt);
    const bucket = severityCounts[gt.finding.severity] ?? { tp: 0, fn: 0 };

    if (positive) {
      if (matchedPositiveGtIndices.has(gi)) {
        bucket.tp += 1;
      } else {
        fn += 1;
        bucket.fn += 1;
      }
    } else if (!matchedNegativeGtIndices.has(gi)) {
      tn += 1;
    }

    severityCounts[gt.finding.severity] = bucket;
  }

  return { tp, fp, fn, tn, fpMatchingNegative, verdicts, severityCounts, matches };
}

// ---------------------------------------------------------------------------
// Aggregation across PRs/attempts for one model config (uses eval-metrics.ts)
// ---------------------------------------------------------------------------

interface AggregateMetrics {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number;
  recall: number;
  f1: number;
  severityStratifiedRecall: Record<string, number>;
  falsePositiveRate: number;
  verdictMcc: number;
}

function aggregateScores(scores: readonly ScoreModelFindingsResult[]): AggregateMetrics {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  const verdicts: FindingVerdict[] = [];
  const severityCounts: Record<string, { tp: number; fn: number }> = {};

  for (const s of scores) {
    tp += s.tp;
    fp += s.fp;
    fn += s.fn;
    tn += s.tn;
    verdicts.push(...s.verdicts);
    for (const [severity, counts] of Object.entries(s.severityCounts)) {
      const bucket = severityCounts[severity] ?? { tp: 0, fn: 0 };
      bucket.tp += counts.tp;
      bucket.fn += counts.fn;
      severityCounts[severity] = bucket;
    }
  }

  return {
    tp,
    fp,
    fn,
    tn,
    precision: precision(tp, fp),
    recall: recall(tp, fn),
    f1: f1(tp, fp, fn),
    severityStratifiedRecall: severityStratifiedRecall(severityCounts),
    falsePositiveRate: falsePositiveRate(verdicts),
    verdictMcc: verdictMcc(tp, tn, fp, fn),
  };
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return 0;
  return finite.reduce((sum, v) => sum + v, 0) / finite.length;
}

// ---------------------------------------------------------------------------
// Model invocation (reuses providers.ts's callReviewer — multi-provider
// dispatch — and prompt.ts's builders, matching measure-calibration.ts's
// runAttempts prompt construction exactly).
// ---------------------------------------------------------------------------

function resolveProviderApiKey(provider: Provider): string | undefined {
  switch (provider) {
    case "openai":
      return process.env.OPENAI_API_KEY;
    case "google":
      return process.env.GOOGLE_AI_API_KEY;
    case "anthropic":
      return process.env.ANTHROPIC_API_KEY;
  }
}

/**
 * Build a minimal `ReviewerConfig` for the eval harness. Only the four
 * fields `callReviewer`/`callOpenAI`/`callGoogle`/`callAnthropic` actually
 * read (provider, providerApiKey, providerModel, modelTimeoutMs) matter;
 * the rest (App auth, MCP wiring, port, etc.) are unused placeholders —
 * this script never boots the reviewer server or authenticates as the App.
 */
function buildEvalReviewerConfig(modelConfig: ModelConfigArg, apiKey: string): ReviewerConfig {
  return {
    appId: 0,
    privateKey: "",
    installationId: 0,
    webhookSecret: "",
    provider: modelConfig.provider,
    providerApiKey: apiKey,
    providerModel: modelConfig.model,
    tier2Enabled: false,
    mcpUrl: undefined,
    mcpToken: undefined,
    port: 0,
    logLevel: "info",
    modelTimeoutMs: EVAL_MODEL_TIMEOUT_MS,
    githubTimeoutMs: EVAL_MODEL_TIMEOUT_MS,
  };
}

/**
 * Extract flat findings from a model's review output: primary path is
 * `submit_finding` tool calls; falls back to `parseFindingsFromBody` on the
 * free-text channel when no tool calls were emitted (mirrors
 * `measure-calibration.ts`'s `extractFindings` — reimplemented rather than
 * imported since that function isn't exported and this runner's needs are
 * simpler: no `findingSource` provenance tracking is required here).
 */
function extractProducedFindings(output: ReviewOutput): FlatFinding[] {
  const fromToolCalls: FlatFinding[] = output.toolCalls
    .filter((tc) => tc.name === "submit_finding")
    .map((tc) => {
      if (tc.name !== "submit_finding") throw new Error("unreachable");
      return { file: tc.args.file, severity: tc.args.severity, line: tc.args.line };
    });

  if (fromToolCalls.length > 0) return fromToolCalls;
  return parseFindingsFromBody(output.text);
}

/** Run one replay attempt for `modelConfig` against `ctx`, returning the
 * produced findings (tool-calls path, else free-text fallback). */
async function runSingleAttempt(
  modelConfig: ModelConfigArg,
  apiKey: string,
  ctx: IterationContext
): Promise<FlatFinding[]> {
  const systemPrompt = buildCriticConstitution(true, "normal", true);
  const userPrompt = buildReviewPrompt({
    prNumber: ctx.prNumber,
    prTitle: ctx.title,
    prBody: ctx.body,
    taskSpec: null,
    diff: ctx.diffAtIteration,
    authorshipTier: 3,
    branchName: ctx.branchName,
    baseBranch: ctx.baseBranch,
    priorReviews: ctx.priorReviewsMarkdown || undefined,
  });

  const config = buildEvalReviewerConfig(modelConfig, apiKey);
  const output = await callReviewer(config, systemPrompt, userPrompt, {
    readFile: async () => null,
    listDirectory: async () => null,
  });

  return extractProducedFindings(output);
}

// ---------------------------------------------------------------------------
// Output path (non-clobbering per the mt#2726 spec)
// ---------------------------------------------------------------------------

function buildDefaultOutputPath(corpusVersion: string, sample: number, attempts: number): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(
    RESULTS_DIR,
    `paired-eval-${corpusVersion}-s${sample}-a${attempts}-${timestamp}.json`
  );
}

// ---------------------------------------------------------------------------
// Per-config result shape (the comparative JSON artifact)
// ---------------------------------------------------------------------------

interface PerConfigResult extends AggregateMetrics {
  modelConfig: string;
  sampledPrCount: number;
  positiveGroundTruthCount: number;
  attemptsPerPr: number;
  meanPassAt1: number;
  meanPassCaretK: number;
  errors: string[];
}

interface PairedEvalArtifact {
  runStartedAt: string;
  corpusPath: string;
  corpusVersion: string;
  sample: number;
  attempts: number;
  sampledPrNumbers: number[];
  configs: PerConfigResult[];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs();
  const runStartedAt = new Date().toISOString();

  console.log("=== Paired-Eval Runner (mt#2726 Milestone A) ===");
  console.log(`Corpus: ${args.corpusPath}`);

  const corpusText = readFileSync(args.corpusPath, "utf-8");
  const { rows, skippedLineCount } = parseCorpusJsonlWithStats(corpusText);
  const corpusVersion = rows[0]?.corpusVersion ?? "unknown";

  console.log(
    `  corpusVersion=${corpusVersion} rows=${rows.length} skippedLines=${skippedLineCount}`
  );

  // Only "git-diff-mined" rows are tied to a real, replayable PR —
  // fetchIterationContext needs an actual PR to fetch. The injected-bug
  // slice (source="injected-bug") uses prNumber=0 as a sentinel (there is no
  // real PR #0) and is a separate, non-PR-replay ground-truth source (per
  // the mt#2726 spec's "Injected-bug slice" scope note); it's excluded from
  // this runner's PR-based sampling rather than fed to fetchIterationContext
  // and inevitably 404ing.
  const replayEligibleRows = rows.filter((row) => row.source === "git-diff-mined");
  const excludedNonPrRows = rows.length - replayEligibleRows.length;
  if (excludedNonPrRows > 0) {
    console.log(
      `  excluded ${excludedNonPrRows} non-PR row(s) (e.g. injected-bug) from PR-based sampling`
    );
  }

  const grouped = groupCorpusRowsByPr(replayEligibleRows);
  const sampledPrNumbers = samplePrNumbers(grouped, args.sample);

  console.log(
    `Grouped into ${grouped.size} distinct PRs; sampling ${sampledPrNumbers.length} (--sample ${args.sample}).`
  );
  for (const prNumber of sampledPrNumbers) {
    const prRows = grouped.get(prNumber) ?? [];
    const positiveCount = prRows.filter(isPositiveGroundTruth).length;
    console.log(`  PR #${prNumber}: ${prRows.length} row(s), ${positiveCount} positive`);
  }

  console.log(`Model configs (${args.models.length}):`);
  for (const m of args.models) console.log(`  ${m.provider}:${m.model}`);
  console.log(`Attempts per PR per config: ${args.attempts}`);

  const outputPath =
    args.outPath ?? buildDefaultOutputPath(corpusVersion, args.sample, args.attempts);
  console.log(`Output path: ${outputPath}`);

  if (args.dryRun) {
    console.log("\n[DRY-RUN] Corpus + grouping + config wiring validated. No network calls made.");
    process.exit(0);
  }

  if (!process.env.OPENAI_API_KEY) {
    console.log(
      "\nSKIP: OPENAI_API_KEY not set. Live paired-eval run requires at least an OpenAI-backed config."
    );
    console.log("HINT: re-run with --dry-run to validate wiring without API calls.");
    process.exit(0);
  }

  const githubToken = resolveGitHubToken();
  if (!githubToken) {
    console.error(
      "ERROR: Neither OCTOKIT_AUTH nor GITHUB_TOKEN set. Live run requires GitHub API access."
    );
    process.exit(1);
  }
  const octokit = new Octokit({ auth: githubToken });

  const perConfigResults: PerConfigResult[] = [];

  for (const modelConfig of args.models) {
    const configLabel = `${modelConfig.provider}:${modelConfig.model}`;
    const apiKey = resolveProviderApiKey(modelConfig.provider);
    const errors: string[] = [];

    if (!apiKey) {
      console.error(
        `  SKIPPING ${configLabel}: no API key configured for provider "${modelConfig.provider}".`
      );
      continue;
    }

    console.log(`\n--- Config: ${configLabel} ---`);

    const perPrScores: ScoreModelFindingsResult[] = [];
    /** Per-positive-corpus-row hit count across attempts, for pass@k/pass^k. */
    const positiveRowHitCounts = new Map<string, number>();
    let positiveGroundTruthCount = 0;
    let sampledPrCount = 0;

    for (const prNumber of sampledPrNumbers) {
      const groundTruthForPr = grouped.get(prNumber) ?? [];
      for (const row of groundTruthForPr) {
        if (isPositiveGroundTruth(row) && !positiveRowHitCounts.has(row.id)) {
          positiveRowHitCounts.set(row.id, 0);
          positiveGroundTruthCount += 1;
        }
      }

      let ctx: IterationContext;
      try {
        ctx = await fetchIterationContext(octokit, prNumber, 1);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`  ERROR fetching context for PR #${prNumber}: ${message}`);
        errors.push(`PR #${prNumber} context fetch: ${message}`);
        continue;
      }
      sampledPrCount += 1;

      for (let attempt = 1; attempt <= args.attempts; attempt++) {
        let produced: FlatFinding[];
        try {
          produced = await runSingleAttempt(modelConfig, apiKey, ctx);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`  PR #${prNumber} attempt ${attempt} ERROR: ${message}`);
          errors.push(`PR #${prNumber} attempt ${attempt}: ${message}`);
          produced = [];
        }

        const scored = scoreModelFindings(produced, groundTruthForPr);
        perPrScores.push(scored);

        console.log(
          `  PR #${prNumber} attempt ${attempt}/${args.attempts}: tp=${scored.tp} fp=${scored.fp} fn=${scored.fn}`
        );

        for (const match of scored.matches) {
          const gtRow = groundTruthForPr[match.groundTruthIndex];
          if (gtRow && isPositiveGroundTruth(gtRow)) {
            positiveRowHitCounts.set(gtRow.id, (positiveRowHitCounts.get(gtRow.id) ?? 0) + 1);
          }
        }
      }
    }

    const aggregate = aggregateScores(perPrScores);

    const hitCounts = Array.from(positiveRowHitCounts.values());
    const meanPassAt1 = mean(
      hitCounts.map((hits) => passAtK(args.attempts, Math.min(hits, args.attempts), 1))
    );
    const meanPassCaretK = mean(
      hitCounts.map((hits) =>
        passCaretK(args.attempts, Math.min(hits, args.attempts), args.attempts)
      )
    );

    perConfigResults.push({
      modelConfig: configLabel,
      sampledPrCount,
      positiveGroundTruthCount,
      attemptsPerPr: args.attempts,
      meanPassAt1,
      meanPassCaretK,
      errors,
      ...aggregate,
    });
  }

  const artifact: PairedEvalArtifact = {
    runStartedAt,
    corpusPath: args.corpusPath,
    corpusVersion,
    sample: args.sample,
    attempts: args.attempts,
    sampledPrNumbers,
    configs: perConfigResults,
  };

  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
  const outDir = dirname(outputPath);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(outputPath, JSON.stringify(artifact, null, 2), "utf-8");

  console.log("\n=== Summary ===");
  for (const config of perConfigResults) {
    console.log(
      `${config.modelConfig}: precision=${config.precision.toFixed(3)} recall=${config.recall.toFixed(3)} ` +
        `f1=${config.f1.toFixed(3)} fpRate=${config.falsePositiveRate.toFixed(3)} mcc=${config.verdictMcc.toFixed(3)} ` +
        `passAt1=${config.meanPassAt1.toFixed(3)}`
    );
  }
  console.log(`\nResults written to: ${outputPath}`);

  process.exit(0);
}

// Bun sets import.meta.main to true when the file is the entry point (not
// when it's imported for testing).
if (import.meta.main) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Paired-eval runner error:", message);
    if (err instanceof Error && err.stack) console.error(err.stack);
    process.exit(1);
  });
}
