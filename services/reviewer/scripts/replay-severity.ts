#!/usr/bin/env bun
/**
 * Severity-inflation replay harness for mt#1465.
 *
 * Replays a set of (PR, iteration) pairs from the calibration corpus,
 * measuring whether the reviewer model re-escalates prior NON-BLOCKING /
 * PRE-EXISTING findings to BLOCKING without new code evidence — the failure
 * pattern mt#1188 + mt#1189 prompt rules were intended to prevent.
 *
 * The script does NOT post anything to GitHub. It only:
 *   - Fetches PR diffs at specific iteration commits via the GitHub API (read-only)
 *   - Fetches prior bot reviews on each PR
 *   - Calls the OpenAI API to run the reviewer (uses OPENAI_API_KEY)
 *   - Writes results to services/reviewer/scripts/replay-severity-results.json
 *
 * Inflation metric: a current-attempt BLOCKING finding whose `file` matches a
 * prior review's NON-BLOCKING / PRE-EXISTING finding is counted as a
 * "candidate inflation." See `detectSeverityInflation` in `replay-summary.ts`
 * for the heuristic and its limits.
 *
 * Usage:
 *   bun services/reviewer/scripts/replay-severity.ts
 *   bun services/reviewer/scripts/replay-severity.ts --pr=743 --iteration=3 --attempts=3
 *   bun services/reviewer/scripts/replay-severity.ts --corpus=default --attempts=3
 *
 * Skips gracefully when OPENAI_API_KEY or GITHUB_TOKEN is absent.
 *
 * mt#1465 context: complements `replay-structural-output.ts` (which targets
 * mt#1395 CoT-leak verification). This harness targets severity-monotonicity
 * compliance under prompt-level "MUST" directives — same compliance-failure
 * shape as mt#1413's 0/15 conclude_review emission rate.
 */

import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { callOpenAIWithClient } from "../src/providers";
import { composeReviewBody } from "../src/compose-review";
import { sanitizeReviewBody } from "../src/sanitize";
import { buildCriticConstitution, buildReviewPrompt } from "../src/prompt";

// ---------------------------------------------------------------------------
// Baseline preamble (mt#1465 A/B comparator)
// ---------------------------------------------------------------------------

/**
 * The Critic Constitution preamble *before* mt#1465 sub-fix 2.
 *
 * Used when the harness is invoked with --baseline so we can A/B compare the
 * pre-restructure prompt against the post-restructure prompt on the same
 * branch checkout, without git-shenanigans. Production builds use
 * buildCriticConstitution which is the post-restructure version.
 *
 * Keep this string byte-identical to the pre-mt#1465 preamble so the only
 * variable across the A/B is the structural placement of the
 * severity-monotonicity rule.
 */
const BASELINE_PREAMBLE_PRE_MT1465 =
  "You are the adversarial reviewer for an agentic software development pipeline. You are reviewing a pull request that was opened by another AI agent. You have no access to that agent's reasoning, chat history, or intermediate artifacts — only the diff, the task specification, and read-only access to the codebase.\n\n" +
  'Your role is structurally adversarial. You are not here to verify correctness. You are here to find flaws. A review that says "looks good to me" is a failed review — it means you added no signal the implementer\'s own self-review could not have produced.';

/**
 * Build a baseline (pre-mt#1465) system prompt by stripping the post-mt#1465
 * preamble and Principle 8 framing from the live prompt and substituting the
 * pre-mt#1465 wording. Inflates the post-restructure prompt back to the
 * pre-restructure wording rather than maintaining a parallel build pipeline.
 *
 * Behavior under test: severity-monotonicity stated as Principle 8 layered
 * constraint vs. promoted into the preamble's primary identity.
 */
function buildBaselinePrompt(toolsAvailable: boolean): string {
  const live = buildCriticConstitution(toolsAvailable, "normal", true);
  // Replace the post-mt#1465 preamble with the pre-mt#1465 wording.
  // The current preamble starts with "You are the adversarial reviewer" and
  // ends just before "## Principles".
  const principlesIdx = live.indexOf("## Principles");
  if (principlesIdx < 0) {
    throw new Error("buildBaselinePrompt: could not locate ## Principles header");
  }
  const livePreamble = live.slice(0, principlesIdx).trimEnd();
  const rest = live.slice(principlesIdx);

  // Verify the live preamble starts with the expected structural-adversariality
  // sentence we're replacing — otherwise we'd silently corrupt the prompt.
  if (!livePreamble.includes("Your role is structurally adversarial")) {
    throw new Error("buildBaselinePrompt: live preamble shape changed; update this helper");
  }

  // Restore the pre-mt#1465 Principle 8 wording (sticky-classification rule).
  // We rewrite Principle 8 in place via regex on the live prompt's anchoring
  // text. PR #920 R1 catch: pre-fix this had no guard verifying the regex
  // matched, so any minor editorial change to Principle 8 (or section
  // ordering) would silently produce a Frankenstein prompt mixing the new
  // preamble with the new Principle 8, invalidating the A/B comparison.
  // Now: explicitly check the regex matched at least once and fail fast with
  // a clear error otherwise.
  const principle8Re = /8\. \*\*Severity-monotonicity is definitional.*?coherent across rounds\./s;
  if (!principle8Re.test(rest)) {
    throw new Error(
      "buildBaselinePrompt: live Principle 8 anchor (`8. **Severity-monotonicity is definitional...coherent across rounds.`) not found — likely a prompt edit. Update the anchor regex in this helper, or the baseline A/B will be invalid."
    );
  }
  const preMt1465Principle8 =
    "8. **Prior NON-BLOCKING / PRE-EXISTING classifications are sticky.** If a prior review classified a concern as NON-BLOCKING or PRE-EXISTING, you must not re-classify the same concern as BLOCKING in a later iteration unless the current diff introduces new code or new evidence that materially changes the risk. Severity inflation without new evidence is a failure mode — it breaks the convergence contract and generates noise that erodes the implementer's trust in the review signal. When in doubt, keep the prior severity.";
  const restPreMt1465 = rest.replace(principle8Re, preMt1465Principle8);
  // Defense in depth: also verify the substitution actually occurred by
  // checking the post-mt#1465 wording is gone.
  if (restPreMt1465.includes("Severity-monotonicity is definitional")) {
    throw new Error(
      "buildBaselinePrompt: regex substitution silently failed — post-mt#1465 wording still present after replace. Live prompt shape may have changed."
    );
  }

  return `${BASELINE_PREAMBLE_PRE_MT1465}\n\n${restPreMt1465}`;
}
import {
  ALLOWED_REVIEWER_BOT_LOGINS,
  CHINESE_WALL_MARKER,
  summarizePriorReviews,
  type PriorReview,
} from "../src/prior-review-summary";
import {
  buildAttemptResult,
  detectSeverityInflation,
  parseFindingsFromBody,
  type AttemptResult,
  type FlatFinding,
  type SeverityInflationResult,
} from "../src/replay-summary";

// ---------------------------------------------------------------------------
// Environment gating
// ---------------------------------------------------------------------------

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const DRY_RUN = process.argv.includes("--dry-run");

// Dry-run mode fetches corpus context (priors + diffs) without calling OpenAI,
// so operators can validate harness wiring + see prompt-budget numbers before
// authorizing a real run. Still requires GITHUB_TOKEN for the read-only fetch.
if (!OPENAI_API_KEY && !DRY_RUN) {
  console.log("SKIP: OPENAI_API_KEY not set; skipping live replay test.");
  console.log("HINT: re-run with --dry-run to inspect corpus context without API calls.");
  process.exit(0);
}

if (!GITHUB_TOKEN) {
  console.log("SKIP: GITHUB_TOKEN not set; skipping live replay test.");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Calibration corpus
// ---------------------------------------------------------------------------

/**
 * Default calibration corpus for mt#1465. Each entry pins a (PR, iteration)
 * pair previously documented in `project_mt1110_calibration_data.md` as
 * exhibiting severity inflation despite the mt#1188 / mt#1189 prompt rules.
 *
 * The iteration index is 1-based and refers to the position of the bot's
 * review in oldest-first order (see `fetchPriorReviews`). For example,
 * "PR #743 R3" -> { prNumber: 743, iteration: 3 }.
 */
interface CorpusEntry {
  readonly prNumber: number;
  readonly iteration: number;
  readonly notes: string;
}

const DEFAULT_CORPUS: ReadonlyArray<CorpusEntry> = [
  {
    prNumber: 732,
    iteration: 4,
    notes: "5-round PR; R4 re-raised R1/R2/R3 NON-BLOCKING as BLOCKING",
  },
  { prNumber: 743, iteration: 3, notes: "3-round PR; R3 escalated 6 NON-BLOCKING to BLOCKING" },
  {
    prNumber: 751,
    iteration: 3,
    notes: "4-round PR; R3 same `as PostgresJsDatabase` cast NON-BLOCKING->BLOCKING",
  },
  {
    prNumber: 758,
    iteration: 5,
    notes: "5-round PR; R5 bold-heading NON-BLOCKING->BLOCKING + hallucinated info-leak",
  },
  {
    prNumber: 829,
    iteration: 3,
    notes: "3-round PR; R3 re-flagged misclassification despite PR-description rebuttal",
  },
];

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_MODEL = "gpt-5";

interface ParsedArgs {
  corpus: CorpusEntry[];
  attemptsPerEntry: number;
  model: string;
  /** When true, swap in the pre-mt#1465 preamble + Principle 8 for A/B comparison. */
  baseline: boolean;
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  let corpus: CorpusEntry[] = [...DEFAULT_CORPUS];
  let attemptsPerEntry = DEFAULT_ATTEMPTS;
  let model = DEFAULT_MODEL;
  let prOverride: number | undefined;
  let iterationOverride: number | undefined;
  let baseline = false;

  for (const arg of args) {
    if (arg.startsWith("--pr=")) {
      const parsed = parseInt(arg.slice("--pr=".length).trim(), 10);
      if (!isNaN(parsed) && parsed > 0) prOverride = parsed;
    } else if (arg.startsWith("--iteration=")) {
      const parsed = parseInt(arg.slice("--iteration=".length).trim(), 10);
      if (!isNaN(parsed) && parsed > 0) iterationOverride = parsed;
    } else if (arg.startsWith("--attempts=")) {
      const parsed = parseInt(arg.slice("--attempts=".length).trim(), 10);
      if (!isNaN(parsed) && parsed > 0) attemptsPerEntry = parsed;
    } else if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length).trim();
    } else if (arg === "--corpus=default") {
      // explicit no-op for clarity
    } else if (arg === "--baseline") {
      baseline = true;
    }
  }

  // Single-entry override: replace the corpus with one entry
  if (prOverride !== undefined && iterationOverride !== undefined) {
    corpus = [
      {
        prNumber: prOverride,
        iteration: iterationOverride,
        notes: "ad-hoc override",
      },
    ];
  } else if (prOverride !== undefined || iterationOverride !== undefined) {
    console.error("Error: --pr and --iteration must be provided together to override the corpus.");
    process.exit(2);
  }

  return { corpus, attemptsPerEntry, model, baseline };
}

// ---------------------------------------------------------------------------
// GitHub fetch helpers
// ---------------------------------------------------------------------------

const OWNER = "edobry";
const REPO = "minsky";

interface FetchedIterationContext {
  prNumber: number;
  iteration: number;
  title: string;
  body: string;
  branchName: string;
  baseBranch: string;
  /** SHA the iteration's review was posted against. */
  iterationSha: string;
  /** Diff between the PR base branch and the iteration's commit. */
  diffAtIteration: string;
  /** Findings extracted from prior reviews (iterations 1..iteration-1). */
  priorFindings: FlatFinding[];
  /** Rendered prior-reviews summary markdown (priorReviews argument to buildReviewPrompt). */
  priorReviewsMarkdown: string;
}

/**
 * Fetch all bot reviews on a PR for replay purposes.
 *
 * Differs from production's fetchPriorReviews:
 *   - Includes DISMISSED reviews. In production these are correctly filtered
 *     (operator dismissed them). For replay we need the historical record;
 *     calibration-data references iterations by submission order regardless
 *     of later operator action.
 *   - Still drops PENDING (drafts) and non-bot reviews.
 *
 * Returns reviews oldest-first.
 */
async function fetchAllBotReviewsForReplay(
  octokit: Octokit,
  prNumber: number
): Promise<PriorReview[]> {
  const allReviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner: OWNER,
    repo: REPO,
    pull_number: prNumber,
    per_page: 100,
  });

  return allReviews
    .map(
      (r): PriorReview => ({
        id: r.id,
        state: r.state as PriorReview["state"],
        submittedAt: r.submitted_at ?? new Date(0).toISOString(),
        commitId: r.commit_id ?? "",
        userLogin: r.user?.login ?? "",
        body: r.body ?? "",
      })
    )
    .filter((r) => {
      if (r.state === "PENDING") return false;
      if (!ALLOWED_REVIEWER_BOT_LOGINS.has(r.userLogin)) return false;
      return r.body.includes(CHINESE_WALL_MARKER);
    })
    .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
}

async function fetchIterationContext(
  octokit: Octokit,
  entry: CorpusEntry
): Promise<FetchedIterationContext> {
  const [prResponse, allBotReviews] = await Promise.all([
    octokit.rest.pulls.get({ owner: OWNER, repo: REPO, pull_number: entry.prNumber }),
    fetchAllBotReviewsForReplay(octokit, entry.prNumber),
  ]);

  const pr = prResponse.data;

  if (allBotReviews.length < entry.iteration) {
    throw new Error(
      `PR #${entry.prNumber} only has ${allBotReviews.length} bot reviews; cannot replay iteration ${entry.iteration}.`
    );
  }

  // The iteration we want to replay — its commitId is the SHA we should
  // diff against; reviews submitted before it form the "prior context."
  const iterationReview = allBotReviews[entry.iteration - 1];
  if (!iterationReview) {
    throw new Error(`PR #${entry.prNumber} iteration ${entry.iteration} not found after slice.`);
  }
  const priorReviews = allBotReviews.slice(0, entry.iteration - 1);

  // Aggregate prior findings for the inflation metric.
  const priorFindings: FlatFinding[] = [];
  for (const r of priorReviews) {
    priorFindings.push(...parseFindingsFromBody(r.body));
  }

  // Render prior-reviews markdown (what gets injected into the prompt).
  const summary = summarizePriorReviews(priorReviews, iterationReview.commitId);

  // Compare API: use pr.base.sha (the original base SHA when the PR was
  // created), NOT pr.base.ref. For merged PRs, base.ref HEAD has advanced
  // past the iteration commit, making the compare empty or reverse. base.sha
  // pins to the original base, giving us the cumulative PR diff at iteration N.
  const compareResponse = await octokit.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
    owner: OWNER,
    repo: REPO,
    basehead: `${pr.base.sha}...${iterationReview.commitId}`,
    mediaType: { format: "diff" },
  });

  return {
    prNumber: entry.prNumber,
    iteration: entry.iteration,
    title: pr.title,
    body: pr.body ?? "",
    branchName: pr.head.ref,
    baseBranch: pr.base.ref,
    iterationSha: iterationReview.commitId,
    diffAtIteration: String(compareResponse.data),
    priorFindings,
    priorReviewsMarkdown: summary.markdown,
  };
}

// ---------------------------------------------------------------------------
// Replay logic
// ---------------------------------------------------------------------------

interface PerAttemptSeverityResult extends AttemptResult {
  /** Findings parsed from this attempt's submit_finding tool calls. */
  currentFindings: FlatFinding[];
  /** Inflation analysis for this attempt. */
  inflation: SeverityInflationResult;
  /** Length of the rendered prior-reviews markdown injected into the prompt. */
  priorReviewsMarkdownChars: number;
}

interface PerEntryResult {
  prNumber: number;
  iteration: number;
  notes: string;
  iterationSha: string;
  attempts: PerAttemptSeverityResult[];
  /** Total prior NON-BLOCKING/PRE-EXISTING findings across all prior iterations. */
  priorNonBlockingFileCount: number;
}

async function replayEntry(
  openaiClient: OpenAI,
  model: string,
  ctx: FetchedIterationContext,
  attemptsPerEntry: number,
  baseline: boolean
): Promise<PerEntryResult> {
  // KNOWN LIMITATION: the harness wires no-op tool handlers (readFile and
  // listDirectory always return null) while declaring tools-available in
  // the system prompt. This is a deliberate choice for the existing
  // recorded measurements (80% -> 64.3% inflation rate were taken under
  // these conditions). The alternatives both have downsides:
  //
  //   (a) toolsAvailable=false + tools=undefined: the no-tools path in
  //       providers.ts skips ALL tool registration including the output
  //       tools (submit_finding, etc.), producing toolCalls=[] always.
  //       This invalidates the inflation metric (currentFindings would be
  //       empty on every attempt). Tested 2026-04-30 in PR #920 R2#1
  //       attempt; reverted after PR #920 R3 caught the metric breakage.
  //
  //   (b) Real tool handlers via GitHub Contents API: correct fix; deferred
  //       to mt#1497 (empirical-verification follow-up). Requires
  //       substantial implementation + another corpus run; out of scope
  //       for the prototype-shipping criteria of mt#1465.
  //
  // Net effect of the no-op-with-tools-on regime: the model may try to
  // call read_file/list_directory and get null, narrating the attempt in
  // scratch text. The A/B *delta* (baseline vs post-restructure) remains
  // valid because both runs are under identical conditions; the absolute
  // rates are likely higher than they would be with real tools wired.
  // mt#1497 will re-run with real handlers to get production-fidelity
  // absolute numbers.
  const toolsAvailable = true;
  const systemPrompt = baseline
    ? buildBaselinePrompt(toolsAvailable)
    : buildCriticConstitution(toolsAvailable, "normal", true);
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

  const attempts: PerAttemptSeverityResult[] = [];

  for (let i = 0; i < attemptsPerEntry; i++) {
    const attemptNum = i + 1;
    console.log(`  Attempt ${attemptNum}/${attemptsPerEntry}...`);

    // Pass no-op tool handlers — see KNOWN LIMITATION comment at top of
    // function. The non-undefined tools arg is necessary for the output
    // tools (submit_finding, etc.) to be registered with the model; the
    // input tools (readFile/listDirectory) are no-ops because real
    // GitHub-Contents-API wiring is deferred to mt#1497.
    const output = await callOpenAIWithClient(openaiClient, model, systemPrompt, userPrompt, {
      readFile: async (_path: string) => null,
      listDirectory: async (_path: string) => null,
    });

    const composed = composeReviewBody(output.toolCalls);
    const scratchSanitized = sanitizeReviewBody(output.text);
    const postedBodySanitized = sanitizeReviewBody(composed.body);

    const baseAttempt = buildAttemptResult(
      attemptNum,
      output.toolCalls,
      output.text,
      scratchSanitized.action,
      postedBodySanitized.action
    );

    // Flatten current submit_finding tool calls for severity analysis.
    // Deduplicate by file:line:severity (PR #920 R6#3): the model
    // occasionally emits the same finding twice in one review (observed
    // on PR #732 attempt 3); dedup avoids inflating the inflation metric.
    const seenFindings = new Set<string>();
    const currentFindings: FlatFinding[] = [];
    for (const tc of output.toolCalls) {
      if (tc.name !== "submit_finding") continue;
      const key = `${tc.args.file}:${tc.args.line}:${tc.args.severity}`;
      if (seenFindings.has(key)) continue;
      seenFindings.add(key);
      currentFindings.push({
        file: tc.args.file,
        severity: tc.args.severity,
        line: tc.args.line,
      });
    }

    const inflation = detectSeverityInflation(currentFindings, ctx.priorFindings);

    const attemptResult: PerAttemptSeverityResult = {
      ...baseAttempt,
      currentFindings,
      inflation,
      priorReviewsMarkdownChars: ctx.priorReviewsMarkdown.length,
    };

    attempts.push(attemptResult);

    console.log(
      `    blocking=${inflation.currentBlockingCount} inflated=${inflation.inflatedFindings.length} ` +
        `rate=${inflation.inflationRate.toFixed(2)} concludeEvent=${baseAttempt.concludeEvent} ` +
        `priorMd=${ctx.priorReviewsMarkdown.length}c`
    );

    if (inflation.inflatedFindings.length > 0) {
      console.log(
        `    inflated files: ${inflation.inflatedFindings.map((f) => f.file).join(", ")}`
      );
    }

    if (output.usage) {
      const u = output.usage;
      console.log(
        `    tokens: prompt=${u.promptTokens ?? "?"} completion=${u.completionTokens ?? "?"} reasoning=${u.reasoningTokens ?? "?"} total=${u.totalTokens ?? "?"}`
      );
    }
  }

  return {
    prNumber: ctx.prNumber,
    iteration: ctx.iteration,
    notes: "", // filled in by caller
    iterationSha: ctx.iterationSha,
    attempts,
    priorNonBlockingFileCount: new Set(
      ctx.priorFindings.filter((f) => f.severity !== "BLOCKING").map((f) => f.file)
    ).size,
  };
}

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

interface AggregateSummary {
  entriesTested: number;
  attemptsPerEntry: number;
  totalAttempts: number;
  totalCurrentBlocking: number;
  totalInflated: number;
  weightedInflationRate: number;
}

function aggregate(perEntry: PerEntryResult[], attemptsPerEntry: number): AggregateSummary {
  let totalCurrentBlocking = 0;
  let totalInflated = 0;
  let totalAttempts = 0;
  for (const e of perEntry) {
    for (const a of e.attempts) {
      totalAttempts += 1;
      totalCurrentBlocking += a.inflation.currentBlockingCount;
      totalInflated += a.inflation.inflatedFindings.length;
    }
  }
  return {
    entriesTested: perEntry.length,
    attemptsPerEntry,
    totalAttempts,
    totalCurrentBlocking,
    totalInflated,
    weightedInflationRate: totalCurrentBlocking === 0 ? 0 : totalInflated / totalCurrentBlocking,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface RunResult {
  runStartedAt: string;
  model: string;
  /** "baseline" (pre-mt#1465 preamble) or "post-restructure" (mt#1465 sub-fix 2). */
  promptVariant: "baseline" | "post-restructure";
  summary: AggregateSummary;
  perEntry: PerEntryResult[];
}

async function main() {
  const { corpus, attemptsPerEntry, model, baseline } = parseArgs();
  const runStartedAt = new Date().toISOString();

  console.log("=== Severity-Monotonicity Replay (mt#1465) ===");
  console.log(`Model: ${model}`);
  console.log(
    `Prompt variant: ${baseline ? "baseline (pre-mt#1465)" : "post-restructure (mt#1465 sub-fix 2)"}`
  );
  console.log(`Corpus entries: ${corpus.map((e) => `#${e.prNumber}@R${e.iteration}`).join(", ")}`);
  console.log(`Attempts per entry: ${attemptsPerEntry}`);
  console.log(`Total API calls: ${corpus.length * attemptsPerEntry}`);
  console.log("");
  console.log(
    "NOTE: This replay consumes real API tokens. Estimated cost varies by model and diff size."
  );
  console.log("");

  const octokit = new Octokit({ auth: GITHUB_TOKEN });
  const openaiClient = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

  const perEntry: PerEntryResult[] = [];

  for (const entry of corpus) {
    console.log(`\nPR #${entry.prNumber} R${entry.iteration} - ${entry.notes}`);

    let ctx: FetchedIterationContext;
    try {
      ctx = await fetchIterationContext(octokit, entry);
      console.log(`  Iteration SHA: ${ctx.iterationSha}`);
      console.log(`  Diff length: ${ctx.diffAtIteration.length} chars`);
      console.log(
        `  Prior findings: ${ctx.priorFindings.length} (${
          ctx.priorFindings.filter((f) => f.severity === "BLOCKING").length
        } BLOCKING, ${ctx.priorFindings.filter((f) => f.severity === "NON-BLOCKING").length} NON-BLOCKING, ${
          ctx.priorFindings.filter((f) => f.severity === "PRE-EXISTING").length
        } PRE-EXISTING)`
      );
      console.log(
        `  Prior-reviews markdown: ${ctx.priorReviewsMarkdown.length} chars (budget guard)`
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  ERROR fetching context: ${message}`);
      perEntry.push({
        prNumber: entry.prNumber,
        iteration: entry.iteration,
        notes: entry.notes,
        iterationSha: "",
        attempts: [],
        priorNonBlockingFileCount: 0,
      });
      continue;
    }

    if (DRY_RUN || !openaiClient) {
      // Dry-run: just record the fetched context, no API calls.
      perEntry.push({
        prNumber: entry.prNumber,
        iteration: entry.iteration,
        notes: entry.notes,
        iterationSha: ctx.iterationSha,
        attempts: [],
        priorNonBlockingFileCount: new Set(
          ctx.priorFindings.filter((f) => f.severity !== "BLOCKING").map((f) => f.file)
        ).size,
      });
      continue;
    }

    const result = await replayEntry(openaiClient, model, ctx, attemptsPerEntry, baseline);
    result.notes = entry.notes;
    perEntry.push(result);
  }

  const summary = aggregate(perEntry, attemptsPerEntry);

  const runResult: RunResult = {
    runStartedAt,
    model,
    promptVariant: baseline ? "baseline" : "post-restructure",
    summary,
    perEntry,
  };

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const outputFilename = baseline
    ? "replay-severity-baseline-results.json"
    : "replay-severity-results.json";
  const outputPath = join(scriptDir, outputFilename);
  writeFileSync(outputPath, JSON.stringify(runResult, null, 2), "utf-8");

  console.log("\n=== Replay Summary ===");
  console.log(`Entries tested: ${summary.entriesTested}`);
  console.log(`Attempts per entry: ${summary.attemptsPerEntry}`);
  console.log(`Total attempts: ${summary.totalAttempts}`);
  console.log(`Total current BLOCKING findings: ${summary.totalCurrentBlocking}`);
  console.log(`Total inflated findings: ${summary.totalInflated}`);
  console.log(`Weighted inflation rate: ${(summary.weightedInflationRate * 100).toFixed(1)}%`);
  console.log(`\nResults written to: ${outputPath}`);

  // Exit 0 always — this is a measurement script, not a verification gate.
  // The output JSON + stdout summary is the deliverable.
  process.exit(0);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error("Replay script error:", message);
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
