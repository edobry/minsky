#!/usr/bin/env bun
/**
 * Replay harness for the tool-loop round budget (mt#3547).
 *
 * Replays a set of PRs through the reviewer and reports, per attempt, how the
 * tool loop TERMINATED: how many rounds it used, whether the model emitted
 * `conclude_review` itself, and — so a round-count win cannot be bought with
 * review quality — what it actually found while doing so.
 *
 * Why not `paired-eval-runner.ts`: that runner stubs the tool context
 * (`readFile: async () => null`), which is fine for comparing MODELS on
 * findings quality but fatal here. A loop whose every read returns null does
 * not spend rounds the way production does, so its round counts measure the
 * stub, not the reviewer. This harness wires the real `readFileAtRef` /
 * `listDirectoryAtRef` against the PR's head SHA — the same view production
 * gives the reviewer — following `replay-doc-impact.ts`.
 *
 * Measuring before/after: run it on the baseline tree, apply the change, run it
 * again. There is deliberately no "disable the budget counter" flag — a flag
 * that exists only for the benchmark can drift from what production actually
 * sends, and a git-checkout comparison cannot.
 *
 * **The instrumentation must be present in BOTH arms.** `toolLoop` (round count,
 * concludedInLoop) shipped in the same commit as the intervention it measures, so
 * a naive `git restore --source=<base> -- services/reviewer/src` produces a
 * baseline with no diagnostics at all — this harness then throws rather than
 * silently recording zeros. Restore the INTERVENTION, keep the MEASUREMENT:
 *
 *   # baseline arm — pre-change prompt, injection off, diagnostics retained
 *   git restore --source=<base-sha> services/reviewer/src/prompt.ts
 *   #   then disable only the `messages.push(buildRoundBudgetNotice(...))` block
 *   #   in providers.ts, leaving the `toolLoop` return field in place
 *   bun services/reviewer/scripts/replay-round-budget.ts --out=/tmp/before.json
 *
 *   # changed arm — restore everything
 *   git restore --source=HEAD services/reviewer/src
 *   bun services/reviewer/scripts/replay-round-budget.ts --out=/tmp/after.json
 *
 *   bun services/reviewer/scripts/replay-round-budget.ts --compare=/tmp/before.json,/tmp/after.json
 *
 * The general rule this instance taught: when a change ships its own
 * observability, "check out the base tree" is not a valid control — the control
 * needs the observability and not the behavior. Separate the two by hand.
 *
 * Usage:
 *   bun services/reviewer/scripts/replay-round-budget.ts
 *   bun services/reviewer/scripts/replay-round-budget.ts --prs=2530,2534 --attempts=3
 *   bun services/reviewer/scripts/replay-round-budget.ts --compare=before.json,after.json
 *
 * Flags:
 *   --owner=O      Repo owner. Default: GITHUB_REPOSITORY's owner, else edobry.
 *   --repo=R       Repo name.  Default: GITHUB_REPOSITORY's repo,  else minsky.
 *   --prs=N,N      PR numbers to replay. Default: the corpus below.
 *   --attempts=K   Attempts per PR. Round count is model output and varies, so
 *                  K>1 is what makes a median meaningful. Default 3.
 *   --model=M      Model id. Default gpt-5.
 *   --out=PATH     Results JSON path. Default: scripts/replay-round-budget-results.json.
 *   --compare=A,B  Read two prior result files and print the A/B table. Makes
 *                  no API calls and needs no credentials.
 *
 * Credentials: the OpenAI key comes from OPENAI_API_KEY, else from Minsky's own
 * configuration (`ai.providers.openai.apiKey`) — a harness runs on a developer
 * machine, where the key normally lives in the config system rather than the
 * shell. Skips cleanly (exit 0) when neither source has it, or when no GitHub
 * token is available.
 */

import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { callOpenAIWithClient } from "../src/providers";
import { buildCriticConstitution, buildReviewPrompt } from "../src/prompt";
import { readFileAtRef, listDirectoryAtRef } from "../src/github-client";
import type { ReviewToolCall } from "../src/output-tools";
import {
  resolveOpenAIKeyOrSkip,
  getOpenAIKeySource,
  resolveGitHubTokenWithConfigOrSkip,
  getGitHubTokenSource,
} from "./harness-config-auth";

const DEFAULT_OWNER = "edobry";
const DEFAULT_REPO = "minsky";

/**
 * Default corpus. Recent merged reviewer-service PRs of differing sizes — the
 * point is a spread of diff sizes, since round count scales with how much
 * there is to sweep, not a curated set of known-interesting reviews.
 */
const DEFAULT_PR_NUMBERS = [2530, 2533, 2534];
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_MODEL = "gpt-5";

const SEVERITY_BLOCKING = "BLOCKING";
const TOOL_SUBMIT_FINDING = "submit_finding";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

interface Args {
  prNumbers: number[];
  attempts: number;
  model: string;
  outPath: string;
  comparePaths: [string, string] | null;
}

export function resolveRepoCoordinates(
  argv: string[],
  env: Record<string, string | undefined>
): { owner: string; repo: string } {
  let owner: string | undefined;
  let repo: string | undefined;

  const fromEnv = env.GITHUB_REPOSITORY;
  if (fromEnv?.includes("/")) {
    const [envOwner, envRepo] = fromEnv.split("/", 2);
    if (envOwner) owner = envOwner;
    if (envRepo) repo = envRepo;
  }

  for (const arg of argv) {
    if (arg.startsWith("--owner=")) owner = arg.slice("--owner=".length).trim();
    else if (arg.startsWith("--repo=")) repo = arg.slice("--repo=".length).trim();
  }

  return { owner: owner || DEFAULT_OWNER, repo: repo || DEFAULT_REPO };
}

function parseArgs(): Args {
  let prNumbers = DEFAULT_PR_NUMBERS;
  let attempts = DEFAULT_ATTEMPTS;
  let model = DEFAULT_MODEL;
  let outPath = join(SCRIPT_DIR, "replay-round-budget-results.json");
  let comparePaths: [string, string] | null = null;

  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--prs=")) {
      const parsed = arg
        .slice("--prs=".length)
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !Number.isNaN(n));
      if (parsed.length > 0) prNumbers = parsed;
    } else if (arg.startsWith("--attempts=")) {
      const parsed = parseInt(arg.slice("--attempts=".length).trim(), 10);
      if (!Number.isNaN(parsed) && parsed > 0) attempts = parsed;
    } else if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length).trim();
    } else if (arg.startsWith("--out=")) {
      outPath = arg.slice("--out=".length).trim();
    } else if (arg.startsWith("--compare=")) {
      const parts = arg
        .slice("--compare=".length)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (parts.length === 2 && parts[0] && parts[1]) comparePaths = [parts[0], parts[1]];
    }
  }

  return { prNumbers, attempts, model, outPath, comparePaths };
}

interface PrContext {
  prNumber: number;
  title: string;
  body: string;
  branchName: string;
  baseBranch: string;
  headSha: string;
  headOwner: string;
  headRepo: string;
  diff: string;
}

async function fetchPr(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<PrContext> {
  const [prResponse, diffResponse] = await Promise.all([
    octokit.rest.pulls.get({ owner, repo, pull_number: prNumber }),
    octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner,
      repo,
      pull_number: prNumber,
      mediaType: { format: "diff" },
    }),
  ]);

  const pr = prResponse.data;

  return {
    prNumber,
    title: pr.title,
    body: pr.body ?? "",
    branchName: pr.head.ref,
    baseBranch: pr.base.ref,
    headSha: pr.head.sha,
    headOwner: pr.head.repo?.owner?.login ?? owner,
    headRepo: pr.head.repo?.name ?? repo,
    diff: String(diffResponse.data),
  };
}

export interface RoundBudgetObservation {
  attempt: number;
  /** Main-loop rounds used, excluding the post-loop forced passes. */
  roundsUsed: number;
  maxRounds: number;
  /** True when the loop ran to the cap — the cohort that carries the cost. */
  exhaustedCap: boolean;
  /**
   * Whether the model emitted conclude_review ITSELF. The metric this task
   * moves. Read from ToolLoopDiagnostics, not from toolCalls: the forced pass
   * puts a conclude_review in toolCalls either way.
   */
  concludedInLoop: boolean;
  forcedConcludeGateBranch: string | null;
  /** Quality side of the ledger — a cheaper review that finds less is not a win. */
  findingCount: number;
  blockingFindingCount: number;
  readFileCallCount: number;
  inputTokens: number;
  cachedTokens: number;
}

export interface PrRoundBudgetResult {
  prNumber: number;
  title: string;
  headSha: string;
  diffChars: number;
  observations: RoundBudgetObservation[];
}

/** Median of a numeric list; 0 for an empty list. Even-length takes the mean. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

export interface RunSummary {
  observationCount: number;
  medianRounds: number;
  meanRounds: number;
  capExhaustedRate: number;
  concludedInLoopRate: number;
  medianBlockingFindings: number;
  totalBlockingFindings: number;
  medianInputTokens: number;
}

export function summarize(results: PrRoundBudgetResult[]): RunSummary {
  const obs = results.flatMap((r) => r.observations);
  const n = obs.length;
  const rate = (count: number) => (n === 0 ? 0 : count / n);
  const rounds = obs.map((o) => o.roundsUsed);

  return {
    observationCount: n,
    medianRounds: median(rounds),
    meanRounds: n === 0 ? 0 : rounds.reduce((a, b) => a + b, 0) / n,
    capExhaustedRate: rate(obs.filter((o) => o.exhaustedCap).length),
    concludedInLoopRate: rate(obs.filter((o) => o.concludedInLoop).length),
    medianBlockingFindings: median(obs.map((o) => o.blockingFindingCount)),
    totalBlockingFindings: obs.reduce((a, o) => a + o.blockingFindingCount, 0),
    medianInputTokens: median(obs.map((o) => o.inputTokens)),
  };
}

function countFindings(toolCalls: ReadonlyArray<ReviewToolCall>): {
  findingCount: number;
  blockingFindingCount: number;
} {
  const findings = toolCalls.filter((tc) => tc.name === TOOL_SUBMIT_FINDING);
  const blocking = findings.filter(
    (tc) => tc.name === TOOL_SUBMIT_FINDING && tc.args.severity === SEVERITY_BLOCKING
  );
  return { findingCount: findings.length, blockingFindingCount: blocking.length };
}

async function replayPr(
  client: OpenAI,
  octokit: Octokit,
  model: string,
  ctx: PrContext,
  attempts: number
): Promise<PrRoundBudgetResult> {
  const systemPrompt = buildCriticConstitution(true, "normal", true);
  const userPrompt = buildReviewPrompt({
    prNumber: ctx.prNumber,
    prTitle: ctx.title,
    prBody: ctx.body,
    taskSpec: null,
    diff: ctx.diff,
    authorshipTier: 3,
    branchName: ctx.branchName,
    baseBranch: ctx.baseBranch,
  });

  const observations: RoundBudgetObservation[] = [];

  for (let i = 0; i < attempts; i++) {
    const attempt = i + 1;
    let readFileCallCount = 0;

    const output = await callOpenAIWithClient(client, model, systemPrompt, userPrompt, {
      readFile: async (path: string, signal?: AbortSignal) => {
        readFileCallCount++;
        return readFileAtRef(
          octokit,
          ctx.headOwner,
          ctx.headRepo,
          path,
          ctx.headSha,
          undefined,
          signal
        );
      },
      listDirectory: async (path: string, signal?: AbortSignal) =>
        listDirectoryAtRef(
          octokit,
          ctx.headOwner,
          ctx.headRepo,
          path,
          ctx.headSha,
          undefined,
          signal
        ),
    });

    const loop = output.toolLoop;
    const { findingCount, blockingFindingCount } = countFindings(output.toolCalls);

    // A missing toolLoop means a non-tool-loop provider path ran; recording it
    // as 0 rounds would silently drag the median down, so fail loudly instead.
    if (!loop) {
      throw new Error(
        `PR #${ctx.prNumber} attempt ${attempt}: no toolLoop diagnostics on the response — ` +
          `the tool-use path did not run, so round counts are not measurable for this attempt.`
      );
    }

    observations.push({
      attempt,
      roundsUsed: loop.roundsUsed,
      maxRounds: loop.maxRounds,
      exhaustedCap: loop.roundsUsed >= loop.maxRounds,
      concludedInLoop: loop.concludedInLoop,
      forcedConcludeGateBranch: loop.forcedConcludeGateBranch,
      findingCount,
      blockingFindingCount,
      readFileCallCount,
      inputTokens: output.usage?.promptTokens ?? 0,
      cachedTokens: output.usage?.cachedTokens ?? 0,
    });

    console.log(
      `  attempt ${attempt}/${attempts}: rounds=${loop.roundsUsed}/${loop.maxRounds} ` +
        `concludedInLoop=${loop.concludedInLoop} findings=${findingCount} ` +
        `(${blockingFindingCount} blocking) reads=${readFileCallCount} in=${output.usage?.promptTokens ?? 0}`
    );
  }

  return {
    prNumber: ctx.prNumber,
    title: ctx.title,
    headSha: ctx.headSha,
    diffChars: ctx.diff.length,
    observations,
  };
}

interface ResultArtifact {
  repo: string;
  model: string;
  attempts: number;
  prNumbers: number[];
  results: PrRoundBudgetResult[];
  summary: RunSummary;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

/**
 * Print the A/B table SC3 asks for. Deliberately reports both axes together:
 * a round-count drop is only a win if the blocking-finding rate holds, and
 * showing them side by side is what makes that judgeable at a glance.
 */
function printComparison(beforePath: string, afterPath: string): void {
  const before = JSON.parse(readFileSync(beforePath, "utf-8")) as ResultArtifact;
  const after = JSON.parse(readFileSync(afterPath, "utf-8")) as ResultArtifact;
  const b = before.summary;
  const a = after.summary;

  const rows: Array<[string, string, string]> = [
    ["observations", String(b.observationCount), String(a.observationCount)],
    ["median rounds", b.medianRounds.toFixed(1), a.medianRounds.toFixed(1)],
    ["mean rounds", b.meanRounds.toFixed(2), a.meanRounds.toFixed(2)],
    ["cap-exhausted rate", pct(b.capExhaustedRate), pct(a.capExhaustedRate)],
    ["concluded in-loop rate", pct(b.concludedInLoopRate), pct(a.concludedInLoopRate)],
    [
      "median BLOCKING findings",
      b.medianBlockingFindings.toFixed(1),
      a.medianBlockingFindings.toFixed(1),
    ],
    ["total BLOCKING findings", String(b.totalBlockingFindings), String(a.totalBlockingFindings)],
    ["median input tokens", String(b.medianInputTokens), String(a.medianInputTokens)],
  ];

  console.log(`\n| metric | before | after |`);
  console.log(`| --- | --- | --- |`);
  for (const [label, beforeValue, afterValue] of rows) {
    console.log(`| ${label} | ${beforeValue} | ${afterValue} |`);
  }

  const roundsDelta = a.medianRounds - b.medianRounds;
  const blockingDelta = a.totalBlockingFindings - b.totalBlockingFindings;
  console.log(
    `\nmedian rounds ${roundsDelta <= 0 ? "fell" : "ROSE"} by ${Math.abs(roundsDelta).toFixed(1)}; ` +
      `total BLOCKING findings ${blockingDelta < 0 ? "FELL" : blockingDelta === 0 ? "held" : "rose"} by ${Math.abs(blockingDelta)}.`
  );
  if (blockingDelta < 0) {
    console.log(
      "BLOCKING findings dropped. This is a review-quality tradeoff and is principal-reserved: " +
        "report both numbers and route the ship/no-ship call as an ask (mt#3547 SC3)."
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs();

  // Comparison mode reads local files only — gate credentials after it so a
  // report can be produced on a machine with no API access.
  if (args.comparePaths) {
    printComparison(args.comparePaths[0], args.comparePaths[1]);
    return;
  }

  // Resolves OPENAI_API_KEY, else Minsky's configured ai.providers.openai.apiKey.
  // Reading env alone would report "no key" on a machine where the key is
  // configured — see resolveOpenAIKey's docstring.
  const openaiApiKey = await resolveOpenAIKeyOrSkip();
  const githubToken = await resolveGitHubTokenWithConfigOrSkip();

  const { owner, repo } = resolveRepoCoordinates(process.argv.slice(2), process.env);
  const { prNumbers, attempts, model, outPath } = args;

  console.log(
    `round-budget replay: repo=${owner}/${repo} prs=[${prNumbers.join(", ")}] ` +
      `attempts=${attempts} model=${model} githubToken=${await getGitHubTokenSource()} ` +
      `openaiKey=${await getOpenAIKeySource()}`
  );

  const client = new OpenAI({ apiKey: openaiApiKey });
  const octokit = new Octokit({ auth: githubToken });

  const results: PrRoundBudgetResult[] = [];

  for (const prNumber of prNumbers) {
    console.log(`\nPR #${prNumber}`);
    const ctx = await fetchPr(octokit, owner, repo, prNumber);
    console.log(`  ${ctx.title} (head ${ctx.headSha.slice(0, 9)}, ${ctx.diff.length} diff chars)`);
    results.push(await replayPr(client, octokit, model, ctx, attempts));
  }

  const summary = summarize(results);
  const artifact: ResultArtifact = {
    repo: `${owner}/${repo}`,
    model,
    attempts,
    prNumbers,
    results,
    summary,
  };

  writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(
    `\nwrote ${outPath}: median rounds ${summary.medianRounds}, ` +
      `cap-exhausted ${pct(summary.capExhaustedRate)}, ` +
      `concluded in-loop ${pct(summary.concludedInLoopRate)}, ` +
      `${summary.totalBlockingFindings} BLOCKING findings across ${summary.observationCount} observations`
  );
}

// Guarded so tests importing the pure helpers do not launch a replay.
if (import.meta.main) {
  await main();
}
