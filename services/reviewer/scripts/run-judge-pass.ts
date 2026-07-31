#!/usr/bin/env bun
/**
 * Raw judge-pass CLI runner (mt#2726 Milestone A, wave 3 — PR #2151 R1 fix,
 * success criterion 3 completeness gap).
 *
 * `judge.ts` exposes the pure judging/aggregation/selection primitives
 * (`judgeFinding`, `aggregateVerdicts`, `findDisagreementWeightedSubset`) but
 * nothing RUNS them end-to-end to produce the disagreement-weighted subset
 * artifact mt#2746's human-labeling pass consumes. This script is that
 * runner: load the committed corpus, select the ambiguous/disputable
 * candidate rows, judge each across a diverse provider panel (reusing
 * `judgeFinding`), select the disagreement-weighted subset (reusing
 * `findDisagreementWeightedSubset`), and write it to a non-clobbering
 * artifact.
 *
 * Usage:
 *   bun services/reviewer/scripts/run-judge-pass.ts --dry-run
 *   bun services/reviewer/scripts/run-judge-pass.ts --sample 50
 *
 * Flags:
 *   --corpus <path>   Corpus JSONL path. Default: the committed v1 corpus.
 *   --sample N        Cap the number of candidate rows judged. Default: all
 *                      candidates (no cap).
 *   --out <path>      Output artifact path. Default: a non-clobbering,
 *                      corpus-version + timestamp-keyed path under
 *                      ../eval/results/.
 *   --dry-run         Load the corpus, select candidates, print counts, and
 *                      exit — no network calls at all. (This script never
 *                      calls GitHub in the first place: corpus rows already
 *                      carry their code context window, unlike
 *                      paired-eval-runner.ts's PR replay.)
 *
 * Live runs require at least one of OPENAI_API_KEY / GOOGLE_AI_API_KEY /
 * ANTHROPIC_API_KEY, gated per-provider (mirrors paired-eval-runner.ts's
 * `resolveProviderApiKey`, reused here rather than duplicated). A missing
 * key for one panel member SKIPS just that member; the run proceeds with
 * whichever providers ARE configured, as long as at least one is. Not
 * required for --dry-run.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseCorpusJsonlWithStats,
  type CorpusLabelValue,
  type CorpusRow,
} from "../src/eval-corpus";
import {
  findDisagreementWeightedSubset,
  judgeFinding,
  type JudgeModelConfig,
  type JudgeResult,
} from "../src/judge";
import { resolveProviderApiKey } from "./paired-eval-runner";

// ---------------------------------------------------------------------------
// Paths + constants
// ---------------------------------------------------------------------------

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CORPUS_PATH = join(SCRIPT_DIR, "..", "eval", "corpus", "ground-truth-v1.jsonl");
const RESULTS_DIR = join(SCRIPT_DIR, "..", "eval", "results");

/**
 * Label values considered "ambiguous/disputable" — deterministic-but-noisy
 * outcomes worth spending a raw-judge opinion on, per the mt#2726 spec's
 * residual-slice framing ("scores the deterministically-unresolvable
 * slice"). `injected-exact` (gold, unambiguous ground truth — no ambiguity
 * to judge) and `dismissed-no-change` (the corpus's large, usually-
 * uncontested negative bucket — see paired-eval-runner.ts's corpus-label
 * distribution: 257/374 rows) are excluded: judging either spends model
 * calls without much information.
 */
const CANDIDATE_LABEL_VALUES: ReadonlySet<CorpusLabelValue> = new Set([
  "git-diff-fixed",
  "carried-forward-unchanged",
]);

/**
 * Select the candidate rows for the raw judge pass: rows whose deterministic
 * label is `git-diff-fixed` or `carried-forward-unchanged` (see
 * `CANDIDATE_LABEL_VALUES` above for the rationale). `sample`, when
 * provided, caps the returned row count — first N in corpus order,
 * deterministic, matching `paired-eval-runner.ts`'s `samplePrNumbers`
 * sampling convention (reproducible across repeated invocations).
 *
 * Pure. No I/O, no network. Exported for unit testing.
 */
export function selectJudgeCandidateRows(rows: readonly CorpusRow[], sample?: number): CorpusRow[] {
  const candidates = rows.filter((row) => CANDIDATE_LABEL_VALUES.has(row.label.value));
  if (sample === undefined) return candidates;
  return candidates.slice(0, sample);
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  corpusPath: string;
  sample: number | undefined;
  outPath: string | undefined;
  dryRun: boolean;
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  let corpusPath = DEFAULT_CORPUS_PATH;
  let sample: number | undefined;
  let outPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;

    if (arg === "--corpus") {
      const value = args[++i];
      if (value !== undefined) corpusPath = value;
    } else if (arg === "--sample") {
      const value = args[++i];
      const parsed = value !== undefined ? parseInt(value, 10) : NaN;
      if (Number.isFinite(parsed) && parsed > 0) sample = parsed;
    } else if (arg === "--out") {
      const value = args[++i];
      if (value !== undefined) outPath = value;
    }
  }

  return { corpusPath, sample, outPath, dryRun };
}

// ---------------------------------------------------------------------------
// Judge panel — 2-3 diverse provider/model configs (mirrors config.ts's
// per-provider REVIEWER_MODEL defaults: gpt-5 / gemini-2.5-pro /
// claude-sonnet-4-6), per the mt#2726 spec's "2-3 diverse provider/model
// configs" instruction.
// ---------------------------------------------------------------------------

interface JudgePanelMember {
  provider: JudgeModelConfig["provider"];
  model: string;
}

const JUDGE_PANEL_MODELS: readonly JudgePanelMember[] = [
  { provider: "openai", model: "gpt-5" },
  { provider: "google", model: "gemini-2.5-pro" },
  { provider: "anthropic", model: "claude-sonnet-4-6" },
];

function buildDefaultOutputPath(corpusVersion: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(RESULTS_DIR, `disagreement-subset-${corpusVersion}-${timestamp}.json`);
}

// ---------------------------------------------------------------------------
// Output artifact shape
// ---------------------------------------------------------------------------

interface JudgePassArtifact {
  runStartedAt: string;
  corpusPath: string;
  corpusVersion: string;
  candidateCount: number;
  judgedCount: number;
  disagreementCount: number;
  panel: string[];
  disagreementSubset: CorpusRow[];
  errors: string[];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs();
  const runStartedAt = new Date().toISOString();

  console.log("=== Raw Judge Pass Runner (mt#2726 Milestone A) ===");
  console.log(`Corpus: ${args.corpusPath}`);

  const corpusText = readFileSync(args.corpusPath, "utf-8");
  const { rows, skippedLineCount } = parseCorpusJsonlWithStats(corpusText);
  const corpusVersion = rows[0]?.corpusVersion ?? "unknown";

  console.log(
    `  corpusVersion=${corpusVersion} rows=${rows.length} skippedLines=${skippedLineCount}`
  );

  const candidates = selectJudgeCandidateRows(rows, args.sample);
  console.log(
    `Selected ${candidates.length} candidate row(s) (label in {git-diff-fixed, carried-forward-unchanged})${
      args.sample !== undefined ? `, capped at --sample ${args.sample}` : ""
    }.`
  );

  const outputPath = args.outPath ?? buildDefaultOutputPath(corpusVersion);
  console.log(`Output path: ${outputPath}`);
  console.log(
    `Judge panel: ${JUDGE_PANEL_MODELS.map((c) => `${c.provider}:${c.model}`).join(", ")}`
  );

  if (args.dryRun) {
    console.log(
      "\n[DRY-RUN] Corpus + candidate selection + panel wiring validated. No network calls made."
    );
    process.exit(0);
  }

  // Per-provider gating (mirrors paired-eval-runner.ts): a missing key for
  // one panel member skips just that member; the whole run only SKIPs when
  // NONE of the panel is runnable.
  const runnablePanel = JUDGE_PANEL_MODELS.filter(
    (c) => resolveProviderApiKey(c.provider) !== undefined
  );
  if (runnablePanel.length === 0) {
    const requestedProviders = [...new Set(JUDGE_PANEL_MODELS.map((c) => c.provider))];
    console.log(
      `\nSKIP: no API key configured for any judge-panel provider (${requestedProviders.join(", ")}). ` +
        "Live judge pass requires at least one of OPENAI_API_KEY / GOOGLE_AI_API_KEY / ANTHROPIC_API_KEY."
    );
    console.log("HINT: re-run with --dry-run to validate wiring without API calls.");
    process.exit(0);
  }
  if (runnablePanel.length < JUDGE_PANEL_MODELS.length) {
    for (const c of JUDGE_PANEL_MODELS) {
      if (!runnablePanel.includes(c)) {
        console.error(
          `  SKIPPING panel member ${c.provider}:${c.model}: no API key configured for provider "${c.provider}".`
        );
      }
    }
  }

  const configs: JudgeModelConfig[] = [];
  for (const c of runnablePanel) {
    const apiKey = resolveProviderApiKey(c.provider);
    if (apiKey === undefined) continue; // already filtered above; guard for noUncheckedIndexedAccess-style safety
    configs.push({ provider: c.provider, model: c.model, apiKey });
  }

  const judgeResults: JudgeResult[] = [];
  const errors: string[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const row = candidates[i];
    if (row === undefined) continue;

    console.log(`  Judging ${i + 1}/${candidates.length}: ${row.id}...`);
    try {
      const result = await judgeFinding(row.finding, row.codeContextWindow, configs);
      judgeResults.push(result);
      console.log(`    verdict=${result.verdict} agreement=${result.agreement}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`    ERROR: ${message}`);
      errors.push(`${row.id}: ${message}`);
      // Push a neutral, non-disagreeing placeholder so `candidates` and
      // `judgeResults` stay index-aligned for findDisagreementWeightedSubset
      // below (mirrors measure-calibration.ts's per-attempt ERROR
      // placeholder pattern). A failed judge call degrades to "no signal",
      // not "disagreement" — errors are surfaced separately in the
      // artifact's `errors` array rather than silently inflating the
      // disagreement-weighted subset.
      judgeResults.push({ verdict: "VALID", agreement: true, perJudge: [] });
    }
  }

  const disagreementSubset = findDisagreementWeightedSubset(candidates, judgeResults);

  const artifact: JudgePassArtifact = {
    runStartedAt,
    corpusPath: args.corpusPath,
    corpusVersion,
    candidateCount: candidates.length,
    judgedCount: judgeResults.length,
    disagreementCount: disagreementSubset.length,
    panel: configs.map((c) => `${c.provider}:${c.model}`),
    disagreementSubset,
    errors,
  };

  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
  const outDir = dirname(outputPath);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(outputPath, JSON.stringify(artifact, null, 2), "utf-8");

  console.log("\n=== Summary ===");
  console.log(`Candidates judged: ${judgeResults.length}/${candidates.length}`);
  console.log(`Disagreement-weighted subset: ${disagreementSubset.length}`);
  console.log(`Results written to: ${outputPath}`);

  process.exit(0);
}

// Bun sets import.meta.main to true when the file is the entry point (not
// when it's imported for testing).
if (import.meta.main) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Judge-pass runner error:", message);
    if (err instanceof Error && err.stack) console.error(err.stack);
    process.exit(1);
  });
}
