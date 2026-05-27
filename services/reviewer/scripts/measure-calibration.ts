#!/usr/bin/env bun
/**
 * Calibration measurement script for mt#1493.
 *
 * Implements three measurement modes targeting mt#1110 success criteria:
 *
 *   --mode=trivial   (SC #1)
 *     Measures REQUEST_CHANGES rate on trivial PRs (<= 10 lines changed).
 *     Corpus: automatically fetched — closed PRs from last 30 days with
 *     <= 10 additions+deletions. Aim for >= 10 PRs; broadens to <= 20 lines
 *     and 60 days if insufficient.
 *
 *   --mode=larger    (SC #3)
 *     Measures REQUEST_CHANGES rate, BLOCKING count, false-positive rate.
 *     Corpus: PR #732 R1, #744 R1, #761 R1, #763 R1, #805 R1 (hardcoded).
 *
 *   --mode=contradiction
 *     Replays PR #881 R3 with R1+R2 in prior-review summary, checking for
 *     direct-contradiction: a BLOCKING in R3 that contradicts R1's *accepted*
 *     BLOCKING (the "use process.exit instead of exit() helper" finding,
 *     row 54 in calibration data).
 *
 * Add --dry-run to run full setup (corpus fetch, prompt build, prior-review
 * fetch) WITHOUT calling OpenAI. Verifies harness wiring + corpus shape.
 *
 * Usage:
 *   bun services/reviewer/scripts/measure-calibration.ts --mode=trivial --dry-run
 *   bun services/reviewer/scripts/measure-calibration.ts --mode=larger --dry-run
 *   bun services/reviewer/scripts/measure-calibration.ts --mode=contradiction --dry-run
 *
 * Live runs (authorized by main agent only):
 *   bun services/reviewer/scripts/measure-calibration.ts --mode=trivial
 *   bun services/reviewer/scripts/measure-calibration.ts --mode=larger
 *   bun services/reviewer/scripts/measure-calibration.ts --mode=contradiction
 *
 * Requires: GITHUB_TOKEN (all modes), OPENAI_API_KEY (live runs only).
 * Outputs: services/reviewer/scripts/measure-calibration-<mode>-results.json
 *
 * Free-text fallback (mt#1493 mitigation for PR #920 R5 bug):
 *   If output.toolCalls is empty AND output.text contains structured findings,
 *   parseFindingsFromBody() extracts them from the text. Falls back to
 *   "no findings" only if both paths yield nothing. Documented in PerAttemptResult.
 *
 * mt#1493 context: builds infrastructure for three calibration measurements
 * targeting mt#1110 SCs #1 + #3 + direct-contradiction class. Live runs are
 * deferred to the main agent post-handoff.
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
import {
  ALLOWED_REVIEWER_BOT_LOGINS,
  CHINESE_WALL_MARKER,
  summarizePriorReviews,
  type PriorReview,
} from "../src/prior-review-summary";
import { buildAttemptResult, parseFindingsFromBody, type FlatFinding } from "../src/replay-summary";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MeasurementMode = "trivial" | "larger" | "contradiction";

/**
 * Per-attempt result for a calibration measurement.
 *
 * Extends the base AttemptResult shape with measurement-specific fields:
 * - event: the conclude_review event (REQUEST_CHANGES, COMMENT, APPROVE, NONE)
 * - blockingCount: number of BLOCKING findings in this attempt
 * - nonBlockingCount: number of NON-BLOCKING findings
 * - preExistingCount: number of PRE-EXISTING findings
 * - currentFindings: flat findings list (tool-calls path, then free-text fallback)
 * - findingSource: "tool-calls" or "free-text-fallback" or "none"
 */
interface PerAttemptResult {
  attempt: number;
  event: string;
  blockingCount: number;
  nonBlockingCount: number;
  preExistingCount: number;
  /** Flat findings list. Source is recorded in findingSource. */
  currentFindings: FlatFinding[];
  /**
   * How findings were obtained:
   * - "tool-calls": from submit_finding tool calls (normal path)
   * - "free-text-fallback": toolCalls empty; parsed from output.text via parseFindingsFromBody
   * - "none": both paths yielded nothing
   *
   * Free-text fallback is the mt#1493 mitigation for the PR #920 R5 bug (tools
   * enabled with no-op handlers, model narrates findings in scratch text rather
   * than emitting tool calls).
   */
  findingSource: "tool-calls" | "free-text-fallback" | "none";
  toolCallCount: number;
  scratchTextLength: number;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
  };
}

/** Per-corpus-entry result (one PR + iteration pair). */
interface PerEntryResult {
  prNumber: number;
  iteration: number;
  notes: string;
  iterationSha: string;
  /** True when context was fetched successfully; false on network/404 error. */
  contextFetched: boolean;
  /** Dry-run output: prompt character counts and corpus metadata. */
  dryRunInfo?: {
    diffChars: number;
    priorReviewsMarkdownChars: number;
    priorFindingCount: number;
    systemPromptChars: number;
    userPromptChars: number;
  };
  attempts: PerAttemptResult[];
}

interface RunSummary {
  mode: MeasurementMode;
  entriesTested: number;
  attemptsPerEntry: number;
  totalAttempts: number;
  requestChangesRate: number;
  meanBlockingCount: number;
  /** Only meaningful for 'larger' mode — estimated false-positive rate. */
  estimatedFalsePositiveRate?: number;
}

interface RunResult {
  runStartedAt: string;
  mode: MeasurementMode;
  model: string;
  dryRun: boolean;
  summary: RunSummary;
  perEntry: PerEntryResult[];
  /** Corpus broadening note when trivial mode needed to expand window. */
  corpusBroadeningNote?: string;
}

// ---------------------------------------------------------------------------
// Environment gating
// ---------------------------------------------------------------------------

import { resolveGitHubTokenOrSkip } from "./harness-auth";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GITHUB_TOKEN = resolveGitHubTokenOrSkip();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OWNER = "edobry";
const REPO = "minsky";
const DEFAULT_MODEL = "gpt-5";
const DEFAULT_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  mode: MeasurementMode;
  attemptsPerEntry: number;
  model: string;
  dryRun: boolean;
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  let mode: MeasurementMode | undefined;
  let attemptsPerEntry = DEFAULT_ATTEMPTS;
  let model = DEFAULT_MODEL;
  const dryRun = args.includes("--dry-run");

  for (const arg of args) {
    if (arg.startsWith("--mode=")) {
      const raw = arg.slice("--mode=".length).trim();
      if (raw === "trivial" || raw === "larger" || raw === "contradiction") {
        mode = raw;
      } else {
        console.error(`ERROR: Unknown mode "${raw}". Valid modes: trivial, larger, contradiction.`);
        process.exit(2);
      }
    } else if (arg.startsWith("--attempts=")) {
      const parsed = parseInt(arg.slice("--attempts=".length).trim(), 10);
      if (!isNaN(parsed) && parsed > 0) attemptsPerEntry = parsed;
    } else if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length).trim();
    }
  }

  if (!mode) {
    console.error("ERROR: --mode is required. Valid modes: trivial, larger, contradiction.");
    process.exit(2);
  }

  return { mode, attemptsPerEntry, model, dryRun };
}

// ---------------------------------------------------------------------------
// GitHub helpers
// ---------------------------------------------------------------------------

/**
 * Fetch all bot reviews on a PR for replay purposes.
 *
 * Same as replay-severity.ts: includes DISMISSED reviews (historical record),
 * filters PENDING + non-bot + missing-Chinese-wall-marker.
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

interface IterationContext {
  prNumber: number;
  iteration: number;
  title: string;
  body: string;
  branchName: string;
  baseBranch: string;
  iterationSha: string;
  diffAtIteration: string;
  priorFindings: FlatFinding[];
  priorReviewsMarkdown: string;
}

/**
 * Fetch context for a (PR, iteration) pair.
 *
 * For iteration=1, there are no prior reviews — priorFindings=[] and
 * priorReviewsMarkdown="".
 *
 * For iteration=N (N > 1), fetches all bot reviews up to iteration N-1 and
 * renders the prior-review summary markdown.
 */
async function fetchIterationContext(
  octokit: Octokit,
  prNumber: number,
  iteration: number
): Promise<IterationContext> {
  const [prResponse, allBotReviews] = await Promise.all([
    octokit.rest.pulls.get({ owner: OWNER, repo: REPO, pull_number: prNumber }),
    fetchAllBotReviewsForReplay(octokit, prNumber),
  ]);

  const pr = prResponse.data;

  // For iteration 1: use the PR's head SHA (most recent) as the diff target.
  // For iteration N: use the SHA the N-th review was posted against.
  let iterationSha: string;
  let priorReviews: PriorReview[];

  if (iteration === 1) {
    // Iteration 1: no prior reviews; diff is the full PR diff at head SHA.
    iterationSha = pr.head.sha;
    priorReviews = [];
  } else {
    if (allBotReviews.length < iteration) {
      throw new Error(
        `PR #${prNumber} only has ${allBotReviews.length} bot reviews; cannot replay iteration ${iteration}.`
      );
    }
    const iterationReview = allBotReviews[iteration - 1];
    if (!iterationReview) {
      throw new Error(`PR #${prNumber} iteration ${iteration} not found after slice.`);
    }
    iterationSha = iterationReview.commitId;
    priorReviews = allBotReviews.slice(0, iteration - 1);
  }

  // Aggregate prior findings for use in contradiction detection.
  const priorFindings: FlatFinding[] = [];
  for (const r of priorReviews) {
    priorFindings.push(...parseFindingsFromBody(r.body));
  }

  // Render prior-reviews markdown for injection into the prompt.
  const summary = summarizePriorReviews(priorReviews, iterationSha);

  // Fetch the cumulative diff from PR base SHA to iteration SHA.
  // Using pr.base.sha (original base) not pr.base.ref (which may have advanced).
  const compareResponse = await octokit.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
    owner: OWNER,
    repo: REPO,
    basehead: `${pr.base.sha}...${iterationSha}`,
    mediaType: { format: "diff" },
  });

  return {
    prNumber,
    iteration,
    title: pr.title,
    body: pr.body ?? "",
    branchName: pr.head.ref,
    baseBranch: pr.base.ref,
    iterationSha,
    diffAtIteration: String(compareResponse.data),
    priorFindings,
    priorReviewsMarkdown: summary.markdown,
  };
}

// ---------------------------------------------------------------------------
// Trivial-PR corpus enumeration (SC #1)
// ---------------------------------------------------------------------------

interface TrivialPrCorpusEntry {
  prNumber: number;
  /** Always 1 for trivial PRs — we test the first review. */
  iteration: 1;
  additions: number;
  deletions: number;
  mergedAt: string;
  notes: string;
}

interface TrivialCorpusResult {
  entries: TrivialPrCorpusEntry[];
  /** Description of any broadening that was applied. */
  broadeningNote?: string;
}

/**
 * Enumerate trivial-PR corpus for SC #1 measurement.
 *
 * Primary window: PRs with additions + deletions <= 10, merged in last 30 days.
 * Fallback window: if < 10 PRs found, broaden to <= 20 lines and last 60 days.
 * Documents any broadening in the returned result.
 */
async function enumerateTrivialCorpus(octokit: Octokit): Promise<TrivialCorpusResult> {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

  // Use GraphQL to fetch additions/deletions inline. One call returns 100 PRs
  // with line counts; the REST equivalent needs a per-PR detail fetch because
  // pulls.list does not include additions/deletions. Reduces enumeration cost
  // from ~50-100 REST calls per dry-run to ~1-3 GraphQL calls. GraphQL has its
  // own 5000-points/hour budget separate from REST 5000-requests/hour.
  //
  // KNOWN BIAS (PR #934 R1): orderBy=UPDATED_AT means PRs whose `updated_at`
  // moves outside the time window (e.g. via late comments/labels) can drop
  // off the first 5 pages even if they merged within the window. GraphQL's
  // IssueOrder enum doesn't support MERGED_AT directly; CREATED_AT is the
  // closest proxy but biases toward newly-opened PRs. For this corpus
  // (edobry/minsky, ~30 day window, hard cap 500 PRs scanned) the bias is
  // negligible — the repo doesn't have hundreds of PRs being re-touched
  // without re-merging. If extending to higher-volume repos, consider:
  // (a) using CREATED_AT and post-filtering by mergedAt, or
  // (b) doing two passes: GraphQL by UPDATED_AT + GraphQL by CREATED_AT, then
  //     deduplicating on number.
  const graphqlQuery =
    "query($owner: String!, $repo: String!, $cursor: String) {\n" +
    "  repository(owner: $owner, name: $repo) {\n" +
    '    pullRequests(first: 100, states: MERGED, baseRefName: "main",\n' +
    "                 orderBy: { field: UPDATED_AT, direction: DESC },\n" +
    "                 after: $cursor) {\n" +
    "      pageInfo { hasNextPage endCursor }\n" +
    "      nodes { number additions deletions mergedAt }\n" +
    "    }\n" +
    "  }\n" +
    "}";

  interface GraphqlPr {
    number: number;
    additions: number;
    deletions: number;
    mergedAt: string;
  }
  interface GraphqlResponse {
    repository: {
      pullRequests: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: GraphqlPr[];
      };
    };
  }

  async function fetchCandidates(maxLines: number, since: Date): Promise<TrivialPrCorpusEntry[]> {
    const candidates: TrivialPrCorpusEntry[] = [];
    let cursor: string | null = null;
    let pagesFetched = 0;
    const maxPages = 5;

    while (candidates.length < 20 && pagesFetched < maxPages) {
      const response = await octokit.graphql<GraphqlResponse>(graphqlQuery, {
        owner: OWNER,
        repo: REPO,
        cursor,
      });
      pagesFetched++;

      let anyRecentEnough = false;
      for (const pr of response.repository.pullRequests.nodes) {
        if (!pr.mergedAt) continue;
        const mergedAt = new Date(pr.mergedAt);
        if (mergedAt < since) continue;

        anyRecentEnough = true;
        const totalLines = pr.additions + pr.deletions;
        if (totalLines <= maxLines) {
          candidates.push({
            prNumber: pr.number,
            iteration: 1,
            additions: pr.additions,
            deletions: pr.deletions,
            mergedAt: pr.mergedAt,
            notes: `${totalLines} lines (${pr.additions}+/${pr.deletions}-)`,
          });
        }
      }

      // PRs are sorted by updated_at desc. Once a full page lacks any
      // recently-merged entries we can stop (with a 1-page buffer for
      // out-of-order updates).
      if (!anyRecentEnough && pagesFetched > 1) break;
      if (!response.repository.pullRequests.pageInfo.hasNextPage) break;
      cursor = response.repository.pullRequests.pageInfo.endCursor;
    }

    return candidates;
  }

  // Primary window: <= 10 lines, last 30 days
  const primary = await fetchCandidates(10, thirtyDaysAgo);

  if (primary.length >= 10) {
    console.log(
      `  Trivial corpus: found ${
        primary.length
      } PRs with <= 10 lines in last 30 days (primary window, GraphQL).`
    );
    return { entries: primary.slice(0, 20) };
  }

  // Fallback: broaden to <= 20 lines and last 60 days
  const fallback = await fetchCandidates(20, sixtyDaysAgo);
  const broadeningNote = `Primary window (<=10 lines, last 30 days) found ${
    primary.length
  } PRs. Broadened to <=20 lines and last 60 days; found ${fallback.length} PRs.`;
  console.log(`  ${broadeningNote}`);

  if (fallback.length === 0) {
    throw new Error(
      "No trivial PRs found even after broadening to <= 20 lines / 60 days. Cannot run trivial mode."
    );
  }

  return { entries: fallback.slice(0, 20), broadeningNote };
}

// ---------------------------------------------------------------------------
// Larger-PR corpus (SC #3)
// ---------------------------------------------------------------------------

interface LargerPrCorpusEntry {
  prNumber: number;
  iteration: number;
  notes: string;
}

/** Hardcoded larger-PR baseline corpus for SC #3. */
const LARGER_PR_CORPUS: ReadonlyArray<LargerPrCorpusEntry> = [
  { prNumber: 732, iteration: 1, notes: "5-round PR; R1 is the baseline first review" },
  { prNumber: 744, iteration: 1, notes: "larger PR; R1 baseline" },
  { prNumber: 761, iteration: 1, notes: "larger PR; R1 baseline" },
  { prNumber: 763, iteration: 1, notes: "larger PR; R1 baseline (later went to 4+ rounds)" },
  { prNumber: 805, iteration: 1, notes: "larger PR; R1 baseline (later went to 3+ rounds)" },
];

// ---------------------------------------------------------------------------
// Contradiction corpus (direct-contradiction class)
// ---------------------------------------------------------------------------

interface ContradictionCorpusEntry {
  prNumber: number;
  /** The iteration to replay (we're replaying R3). */
  iteration: number;
  notes: string;
  /** The accepted BLOCKING finding from R1 that R3 may contradict. */
  acceptedR1Finding: string;
}

/**
 * Contradiction corpus: PR #881 R3.
 *
 * The accepted R1 BLOCKING was "use process.exit instead of exit() helper"
 * (calibration-data row 54). R3 may contradict this by flagging the same area
 * as either acceptable or by reversing the recommendation.
 */
const CONTRADICTION_CORPUS: ReadonlyArray<ContradictionCorpusEntry> = [
  {
    prNumber: 881,
    iteration: 3,
    notes:
      "PR #881 R3: check if R3 emits BLOCKING contradicting R1 accepted finding (process.exit vs exit() helper)",
    acceptedR1Finding:
      "use process.exit instead of exit() helper — accepted as BLOCKING in R1, row 54 in calibration data",
  },
];

// ---------------------------------------------------------------------------
// OpenAI invocation
// ---------------------------------------------------------------------------

/**
 * Extract flat findings from a model output.
 *
 * Primary path: submit_finding tool calls.
 * Fallback (mt#1493 mitigation): if toolCalls is empty AND output.text contains
 * structured findings, parse them via parseFindingsFromBody.
 * Returns source="none" only if both paths yield nothing.
 */
function extractFindings(
  toolCalls: import("../src/output-tools").ReviewToolCall[],
  text: string
): { findings: FlatFinding[]; source: PerAttemptResult["findingSource"] } {
  // Primary: tool-call path
  const fromToolCalls: FlatFinding[] = toolCalls
    .filter((tc) => tc.name === "submit_finding")
    .map((tc) => {
      if (tc.name !== "submit_finding") throw new Error("unreachable");
      return {
        file: tc.args.file,
        severity: tc.args.severity,
        line: tc.args.line,
      };
    });

  if (fromToolCalls.length > 0) {
    return { findings: fromToolCalls, source: "tool-calls" };
  }

  // Fallback: free-text path (PR #920 R5 mitigation)
  // When the model narrates findings in scratch text instead of emitting tool calls,
  // parseFindingsFromBody can often recover structured findings from the text.
  const fromText = parseFindingsFromBody(text);
  if (fromText.length > 0) {
    return { findings: fromText, source: "free-text-fallback" };
  }

  return { findings: [], source: "none" };
}

/**
 * Run N attempts for a single (PR, iteration) context and record results.
 */
async function runAttempts(
  openaiClient: OpenAI,
  model: string,
  ctx: IterationContext,
  attemptsPerEntry: number
): Promise<PerAttemptResult[]> {
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

  const results: PerAttemptResult[] = [];

  for (let i = 0; i < attemptsPerEntry; i++) {
    const attemptNum = i + 1;
    console.log(`    Attempt ${attemptNum}/${attemptsPerEntry}...`);

    let output;
    try {
      // No-op tool handlers — same constraint as replay-severity.ts.
      // See KNOWN LIMITATION in replay-severity.ts for full explanation.
      output = await callOpenAIWithClient(openaiClient, model, systemPrompt, userPrompt, {
        readFile: async (_path: string) => null,
        listDirectory: async (_path: string) => null,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`    Attempt ${attemptNum} failed: ${msg}`);
      // Push a placeholder so result count matches attemptsPerEntry; downstream
      // analysis can filter on event === "ERROR" to exclude failed attempts.
      results.push({
        attempt: attemptNum,
        event: "ERROR",
        blockingCount: 0,
        nonBlockingCount: 0,
        preExistingCount: 0,
        currentFindings: [],
        findingSource: "none",
        toolCallCount: 0,
        scratchTextLength: 0,
        usage: { promptTokens: undefined, completionTokens: undefined, reasoningTokens: undefined },
      });
      continue;
    }

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

    const { findings, source } = extractFindings(output.toolCalls, output.text);

    const blockingCount = findings.filter((f) => f.severity === "BLOCKING").length;
    const nonBlockingCount = findings.filter((f) => f.severity === "NON-BLOCKING").length;
    const preExistingCount = findings.filter((f) => f.severity === "PRE-EXISTING").length;

    const result: PerAttemptResult = {
      attempt: attemptNum,
      event: baseAttempt.concludeEvent,
      blockingCount,
      nonBlockingCount,
      preExistingCount,
      currentFindings: findings,
      findingSource: source,
      toolCallCount: output.toolCalls.length,
      scratchTextLength: output.text.length,
      usage: output.usage,
    };

    results.push(result);

    console.log(
      `      event=${result.event} blocking=${blockingCount} non-blocking=${nonBlockingCount} ` +
        `source=${source} toolCalls=${output.toolCalls.length}`
    );

    if (output.usage) {
      const u = output.usage;
      console.log(
        `      tokens: prompt=${u.promptTokens ?? "?"} completion=${u.completionTokens ?? "?"} reasoning=${u.reasoningTokens ?? "?"}`
      );
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Dry-run helpers
// ---------------------------------------------------------------------------

/**
 * Print dry-run info for a (PR, iteration) pair: prompt sizes, corpus metadata.
 */
function printDryRunInfo(ctx: IterationContext): PerAttemptResult["usage"] {
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

  console.log(
    `    [DRY-RUN] diff=${ctx.diffAtIteration.length}c systemPrompt=${systemPrompt.length}c userPrompt=${userPrompt.length}c`
  );
  console.log(
    `    [DRY-RUN] priorReviewsMd=${ctx.priorReviewsMarkdown.length}c priorFindings=${ctx.priorFindings.length}`
  );
  console.log(`    [DRY-RUN] iterationSha=${ctx.iterationSha}`);

  if (ctx.priorFindings.length > 0) {
    const bCount = ctx.priorFindings.filter((f) => f.severity === "BLOCKING").length;
    const nbCount = ctx.priorFindings.filter((f) => f.severity === "NON-BLOCKING").length;
    const peCount = ctx.priorFindings.filter((f) => f.severity === "PRE-EXISTING").length;
    console.log(
      `    [DRY-RUN] priorFindings breakdown: ${bCount} BLOCKING, ${nbCount} NON-BLOCKING, ${peCount} PRE-EXISTING`
    );
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Mode runners
// ---------------------------------------------------------------------------

async function runTrivialMode(
  octokit: Octokit,
  openaiClient: OpenAI | null,
  model: string,
  attemptsPerEntry: number,
  dryRun: boolean
): Promise<{ perEntry: PerEntryResult[]; broadeningNote?: string }> {
  console.log("\n--- Trivial-PR corpus enumeration ---");
  const corpusResult = await enumerateTrivialCorpus(octokit);
  const corpus = corpusResult.entries;

  console.log(`Corpus: ${corpus.length} trivial PRs`);
  for (const e of corpus) {
    console.log(`  PR #${e.prNumber}: ${e.notes} (merged ${e.mergedAt.slice(0, 10)})`);
  }
  console.log("");

  const perEntry: PerEntryResult[] = [];

  for (const entry of corpus) {
    console.log(`\nPR #${entry.prNumber} R${entry.iteration} — ${entry.notes}`);

    let ctx: IterationContext;
    try {
      ctx = await fetchIterationContext(octokit, entry.prNumber, entry.iteration);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  ERROR fetching context: ${message}`);
      perEntry.push({
        prNumber: entry.prNumber,
        iteration: entry.iteration,
        notes: entry.notes,
        iterationSha: "",
        contextFetched: false,
        attempts: [],
      });
      continue;
    }

    if (dryRun || !openaiClient) {
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
      printDryRunInfo(ctx);
      perEntry.push({
        prNumber: entry.prNumber,
        iteration: entry.iteration,
        notes: entry.notes,
        iterationSha: ctx.iterationSha,
        contextFetched: true,
        dryRunInfo: {
          diffChars: ctx.diffAtIteration.length,
          priorReviewsMarkdownChars: ctx.priorReviewsMarkdown.length,
          priorFindingCount: ctx.priorFindings.length,
          systemPromptChars: systemPrompt.length,
          userPromptChars: userPrompt.length,
        },
        attempts: [],
      });
      continue;
    }

    const attempts = await runAttempts(openaiClient, model, ctx, attemptsPerEntry);
    perEntry.push({
      prNumber: entry.prNumber,
      iteration: entry.iteration,
      notes: entry.notes,
      iterationSha: ctx.iterationSha,
      contextFetched: true,
      attempts,
    });
  }

  return { perEntry, broadeningNote: corpusResult.broadeningNote };
}

async function runLargerMode(
  octokit: Octokit,
  openaiClient: OpenAI | null,
  model: string,
  attemptsPerEntry: number,
  dryRun: boolean
): Promise<PerEntryResult[]> {
  const perEntry: PerEntryResult[] = [];

  for (const entry of LARGER_PR_CORPUS) {
    console.log(`\nPR #${entry.prNumber} R${entry.iteration} — ${entry.notes}`);

    let ctx: IterationContext;
    try {
      ctx = await fetchIterationContext(octokit, entry.prNumber, entry.iteration);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  ERROR fetching context: ${message}`);
      perEntry.push({
        prNumber: entry.prNumber,
        iteration: entry.iteration,
        notes: entry.notes,
        iterationSha: "",
        contextFetched: false,
        attempts: [],
      });
      continue;
    }

    if (dryRun || !openaiClient) {
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
      printDryRunInfo(ctx);
      perEntry.push({
        prNumber: entry.prNumber,
        iteration: entry.iteration,
        notes: entry.notes,
        iterationSha: ctx.iterationSha,
        contextFetched: true,
        dryRunInfo: {
          diffChars: ctx.diffAtIteration.length,
          priorReviewsMarkdownChars: ctx.priorReviewsMarkdown.length,
          priorFindingCount: ctx.priorFindings.length,
          systemPromptChars: systemPrompt.length,
          userPromptChars: userPrompt.length,
        },
        attempts: [],
      });
      continue;
    }

    const attempts = await runAttempts(openaiClient, model, ctx, attemptsPerEntry);
    perEntry.push({
      prNumber: entry.prNumber,
      iteration: entry.iteration,
      notes: entry.notes,
      iterationSha: ctx.iterationSha,
      contextFetched: true,
      attempts,
    });
  }

  return perEntry;
}

async function runContradictionMode(
  octokit: Octokit,
  openaiClient: OpenAI | null,
  model: string,
  attemptsPerEntry: number,
  dryRun: boolean
): Promise<PerEntryResult[]> {
  const perEntry: PerEntryResult[] = [];

  for (const entry of CONTRADICTION_CORPUS) {
    console.log(`\nPR #${entry.prNumber} R${entry.iteration} — ${entry.notes}`);
    console.log(`  Accepted R1 finding: "${entry.acceptedR1Finding}"`);

    let ctx: IterationContext;
    try {
      ctx = await fetchIterationContext(octokit, entry.prNumber, entry.iteration);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  ERROR fetching context: ${message}`);
      perEntry.push({
        prNumber: entry.prNumber,
        iteration: entry.iteration,
        notes: entry.notes,
        iterationSha: "",
        contextFetched: false,
        attempts: [],
      });
      continue;
    }

    if (dryRun || !openaiClient) {
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
      printDryRunInfo(ctx);
      perEntry.push({
        prNumber: entry.prNumber,
        iteration: entry.iteration,
        notes: entry.notes,
        iterationSha: ctx.iterationSha,
        contextFetched: true,
        dryRunInfo: {
          diffChars: ctx.diffAtIteration.length,
          priorReviewsMarkdownChars: ctx.priorReviewsMarkdown.length,
          priorFindingCount: ctx.priorFindings.length,
          systemPromptChars: systemPrompt.length,
          userPromptChars: userPrompt.length,
        },
        attempts: [],
      });
      continue;
    }

    const attempts = await runAttempts(openaiClient, model, ctx, attemptsPerEntry);
    perEntry.push({
      prNumber: entry.prNumber,
      iteration: entry.iteration,
      notes: entry.notes,
      iterationSha: ctx.iterationSha,
      contextFetched: true,
      attempts,
    });
  }

  return perEntry;
}

// ---------------------------------------------------------------------------
// Summary computation
// ---------------------------------------------------------------------------

function computeSummary(
  mode: MeasurementMode,
  perEntry: PerEntryResult[],
  attemptsPerEntry: number
): RunSummary {
  let totalAttempts = 0;
  let requestChangesCount = 0;
  let totalBlockingCount = 0;

  for (const entry of perEntry) {
    for (const attempt of entry.attempts) {
      totalAttempts++;
      if (attempt.event === "REQUEST_CHANGES") requestChangesCount++;
      totalBlockingCount += attempt.blockingCount;
    }
  }

  const requestChangesRate = totalAttempts === 0 ? 0 : requestChangesCount / totalAttempts;
  const meanBlockingCount = totalAttempts === 0 ? 0 : totalBlockingCount / totalAttempts;

  // For larger-PR mode: estimate false-positive rate as the fraction of
  // attempts with BLOCKING findings that don't correspond to human-verified
  // issues. This is a rough proxy — the corpus PRs are all human-authored and
  // the reviews were all eventually accepted as legitimate concerns.
  // A high REQUEST_CHANGES rate on "good" PRs (R1 of accepted PRs) may
  // indicate over-blocking. We don't have ground-truth false-positive labels,
  // so we use a simple proxy: REQUEST_CHANGES rate on R1 as a rough proxy.
  const estimatedFalsePositiveRate = mode === "larger" ? requestChangesRate : undefined;

  return {
    mode,
    entriesTested: perEntry.filter((e) => e.contextFetched).length,
    attemptsPerEntry,
    totalAttempts,
    requestChangesRate,
    meanBlockingCount,
    estimatedFalsePositiveRate,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { mode, attemptsPerEntry, model, dryRun } = parseArgs();
  const runStartedAt = new Date().toISOString();

  console.log(`=== Calibration Measurement: ${mode.toUpperCase()} mode (mt#1493) ===`);
  console.log(`Model: ${model}`);
  console.log(`Attempts per entry: ${attemptsPerEntry}`);
  console.log(`Dry-run: ${dryRun}`);
  if (!dryRun) {
    if (!OPENAI_API_KEY) {
      console.error("ERROR: OPENAI_API_KEY not set. Required for live runs.");
      console.error("HINT: re-run with --dry-run to validate harness wiring without API calls.");
      process.exit(1);
    }
    console.log(
      "\nNOTE: Live mode — this will consume real API tokens (~$10 per run at gpt-5 rates)."
    );
    console.log("Authorized by main agent only. If you see this, verify you meant to run live.");
  }
  console.log("");

  const octokit = new Octokit({ auth: GITHUB_TOKEN });
  // 20-min per-request timeout: gpt-5 with deep reasoning can take 5-10 min per
  // call (10K+ output tokens at ~30 tokens/sec). maxRetries handles transient
  // network errors at the SDK level; the per-attempt try/catch in runAttempts
  // handles unrecoverable failures by skipping the attempt.
  const openaiClient = OPENAI_API_KEY
    ? new OpenAI({ apiKey: OPENAI_API_KEY, timeout: 1200000, maxRetries: 3 })
    : null;

  let perEntry: PerEntryResult[] = [];
  let broadeningNote: string | undefined;

  if (mode === "trivial") {
    const result = await runTrivialMode(octokit, openaiClient, model, attemptsPerEntry, dryRun);
    perEntry = result.perEntry;
    broadeningNote = result.broadeningNote;
  } else if (mode === "larger") {
    perEntry = await runLargerMode(octokit, openaiClient, model, attemptsPerEntry, dryRun);
  } else {
    // mode === "contradiction"
    perEntry = await runContradictionMode(octokit, openaiClient, model, attemptsPerEntry, dryRun);
  }

  const summary = computeSummary(mode, perEntry, attemptsPerEntry);

  const runResult: RunResult = {
    runStartedAt,
    mode,
    model,
    dryRun,
    summary,
    perEntry,
    ...(broadeningNote ? { corpusBroadeningNote: broadeningNote } : {}),
  };

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const outputPath = join(scriptDir, `measure-calibration-${mode}-results.json`);
  writeFileSync(outputPath, JSON.stringify(runResult, null, 2), "utf-8");

  // Summary printout
  console.log("\n=== Measurement Summary ===");
  if (broadeningNote) console.log(`NOTE: ${broadeningNote}`);
  console.log(`Mode: ${mode}`);
  console.log(`Entries tested: ${summary.entriesTested}`);
  if (!dryRun) {
    console.log(`Total attempts: ${summary.totalAttempts}`);
    console.log(`REQUEST_CHANGES rate: ${(summary.requestChangesRate * 100).toFixed(1)}%`);
    console.log(`Mean BLOCKING count per attempt: ${summary.meanBlockingCount.toFixed(2)}`);
    if (mode === "larger" && summary.estimatedFalsePositiveRate !== undefined) {
      console.log(
        `Estimated false-positive rate (proxy): ${(summary.estimatedFalsePositiveRate * 100).toFixed(1)}%`
      );
    }
  } else {
    console.log(
      `[DRY-RUN] Context fetched for all ${perEntry.filter((e) => e.contextFetched).length}/${perEntry.length} entries.`
    );
    const failed = perEntry.filter((e) => !e.contextFetched);
    if (failed.length > 0) {
      console.log(`[DRY-RUN] ERRORS: ${failed.length} entries failed to fetch context:`);
      for (const e of failed) {
        console.log(`  PR #${e.prNumber} R${e.iteration}`);
      }
    }
  }
  console.log(`\nResults written to: ${outputPath}`);

  process.exit(0);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error("Measurement script error:", message);
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
