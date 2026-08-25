#!/usr/bin/env bun
/**
 * Martian Code Review Bench — review generation (mt#4577).
 *
 * Generates `minsky-reviewer` reviews for the 50 PRs in Martian's offline Code Review Bench gold
 * set and writes `results/benchmark_data.json` in the exact schema
 * `code_review_benchmark.step1_download_prs` would have produced, so the pinned checkout's own
 * `step2_extract_comments` -> `step2_5_dedup_candidates` -> `step3_judge_comments` run completely
 * unmodified against our output. See `martian-bench/PIN.md` (this directory) for why steps 0-1
 * (fork + GitHub-scrape) are replaced rather than run, and the mt#4577 task spec's
 * "Planning Audit" section for the full investigation trail.
 *
 * Deliberately NOT a reuse of `measure-calibration.ts`'s `fetchIterationContext`: that function
 * closes over module-level `OWNER`/`REPO` constants hardcoded to this repo and reconstructs
 * multi-iteration replay state (prior bot reviews) this task never needs — every benchmark PR
 * gets exactly one, first-look review. The PR-context fetch below is new, small, and generic
 * over `{owner, repo, pull_number}`. Review generation itself (`callReviewer()`, prompt building,
 * provider credential resolution) IS reused from `paired-eval-runner.ts` / `providers.ts` /
 * `prompt.ts` — no new credential, no new App installation.
 *
 * Usage:
 *   bun services/reviewer/eval/martian-bench-generate.ts --dry-run \
 *     --golden /tmp/martian-bench/offline/golden_comments
 *
 *   bun services/reviewer/eval/martian-bench-generate.ts \
 *     --golden /tmp/martian-bench/offline/golden_comments \
 *     --model openai:gpt-5 --out results/benchmark_data.json
 *
 * Flags:
 *   --golden <dir>   Path to the pinned checkout's `offline/golden_comments` directory
 *                    (5 JSON files: sentry.json, grafana.json, keycloak.json, discourse.json,
 *                    cal_dot_com.json). Required unless --dry-run with no golden dir available.
 *   --model <p:m>    "<provider>:<model>", e.g. "openai:gpt-5". Default: openai:gpt-5 (the
 *                    production reviewer's model).
 *   --out <path>     Output path. Default: ./results/benchmark_data.json (relative to this file).
 *   --limit N        Only process the first N PRs (across all golden files, in file order) —
 *                    for smoke-testing before a full 50-PR run.
 *   --dry-run        Parse the golden files, print the PR list + owner/repo/pull_number
 *                    resolution, and exit — no GitHub fetch, no model call.
 *
 * Live runs require OPENAI_API_KEY (or the credential matching --model's provider) plus
 * OCTOKIT_AUTH or GITHUB_TOKEN (read-only GitHub access to the 5 public benchmark source repos —
 * NOT the reviewer App's installation token; see the module docblock above). Neither is required
 * for --dry-run.
 *
 * Cost note (SC7): this script records `output.usage`/`output.timing` per review into the
 * output artifact's `_generationMeta` field so the actual token cost of the run is measured, not
 * estimated, per the mt#4577 spec's success criteria.
 */

import { Octokit } from "@octokit/rest";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { callReviewer, type ReviewOutput } from "../src/providers";
import { buildCriticConstitution, buildReviewPrompt } from "../src/prompt";
import type { ReviewerConfig } from "../src/config";
import { resolveGitHubToken } from "../scripts/harness-auth";
import { resolveProviderApiKey } from "../scripts/paired-eval-runner";

// ---------------------------------------------------------------------------
// Paths + constants
// ---------------------------------------------------------------------------

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = join(SCRIPT_DIR, "results", "benchmark_data.json");

/** Same generous per-call budget paired-eval-runner.ts uses for live model calls. */
const MODEL_TIMEOUT_MS = 300_000;

type Provider = "openai" | "google" | "anthropic";

interface ModelConfigArg {
  provider: Provider;
  model: string;
}

function parseModelSpec(spec: string): ModelConfigArg {
  const [provider, ...rest] = spec.split(":");
  const model = rest.join(":");
  if (!provider || !model || !["openai", "google", "anthropic"].includes(provider)) {
    throw new Error(
      `Invalid --model "${spec}" — expected "<provider>:<model>", e.g. "openai:gpt-5"`
    );
  }
  return { provider: provider as Provider, model };
}

// ---------------------------------------------------------------------------
// Golden-comments loading (mirrors offline/README.md's documented schema)
// ---------------------------------------------------------------------------

interface GoldenComment {
  comment: string;
  severity: "Low" | "Medium" | "High" | "Critical";
  category?: string;
}

interface GoldenEntry {
  pr_title: string;
  url: string;
  comments: GoldenComment[];
}

interface ResolvedPr {
  goldenUrl: string;
  owner: string;
  repo: string;
  prNumber: number;
  sourceFile: string;
}

/** Parse a GitHub PR URL into {owner, repo, prNumber}. Throws on an unrecognized shape rather
 * than silently skipping — a golden file with a malformed URL is a data problem worth surfacing,
 * not swallowing. */
function parsePrUrl(url: string): { owner: string; repo: string; prNumber: number } {
  const match = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  const owner = match?.[1];
  const repo = match?.[2];
  const prNumberStr = match?.[3];
  if (!owner || !repo || !prNumberStr) throw new Error(`Cannot parse GitHub PR URL: ${url}`);
  return { owner, repo, prNumber: Number(prNumberStr) };
}

function loadGoldenPrs(goldenDir: string): ResolvedPr[] {
  const files = readdirSync(goldenDir).filter((f) => f.endsWith(".json"));
  if (files.length === 0) {
    throw new Error(`No .json files found in --golden dir: ${goldenDir}`);
  }
  const resolved: ResolvedPr[] = [];
  for (const file of files) {
    const entries: GoldenEntry[] = JSON.parse(readFileSync(join(goldenDir, file), "utf-8"));
    for (const entry of entries) {
      const { owner, repo, prNumber } = parsePrUrl(entry.url);
      resolved.push({ goldenUrl: entry.url, owner, repo, prNumber, sourceFile: file });
    }
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// PR context fetch — generic over {owner, repo, prNumber}, unlike
// measure-calibration.ts's fetchIterationContext (see module docblock).
// ---------------------------------------------------------------------------

interface PrContext {
  title: string;
  body: string;
  branchName: string;
  baseBranch: string;
  diff: string;
}

async function fetchPrContext(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<PrContext> {
  const pr = (await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber })).data;
  const diffResponse = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
    mediaType: { format: "diff" },
  });
  return {
    title: pr.title,
    body: pr.body ?? "",
    branchName: pr.head.ref,
    baseBranch: pr.base.ref,
    // mediaType: { format: "diff" } makes Octokit return the body as a raw string at runtime
    // even though the typed response is PullRequest. String() safely coerces the runtime value
    // without an as-unknown double cast — same pattern as github-client.ts:220-221.
    diff: String(diffResponse.data),
  };
}

// ---------------------------------------------------------------------------
// Review generation — reuses providers.ts / prompt.ts exactly as
// paired-eval-runner.ts does; no Minsky task spec (taskSpec: null), matching
// the mt#4577 spec's stated "generic bug-finding only" limitation.
// ---------------------------------------------------------------------------

/** Mirrors paired-eval-runner.ts's buildEvalReviewerConfig: only the fields callReviewer()
 * actually reads matter (provider, providerApiKey, providerModel, modelTimeoutMs). This script
 * never boots the reviewer server or authenticates as the GitHub App. */
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
    modelTimeoutMs: MODEL_TIMEOUT_MS,
    githubTimeoutMs: MODEL_TIMEOUT_MS,
  } as ReviewerConfig;
}

async function generateReview(
  modelConfig: ModelConfigArg,
  apiKey: string,
  ctx: PrContext,
  prNumber: number
): Promise<ReviewOutput> {
  const systemPrompt = buildCriticConstitution(true, "normal", true);
  const userPrompt = buildReviewPrompt({
    prNumber,
    prTitle: ctx.title,
    prBody: ctx.body,
    taskSpec: null,
    diff: ctx.diff,
    authorshipTier: 3,
    branchName: ctx.branchName,
    baseBranch: ctx.baseBranch,
  });
  const config = buildEvalReviewerConfig(modelConfig, apiKey);
  return callReviewer(config, systemPrompt, userPrompt, {
    readFile: async () => null,
    listDirectory: async () => null,
  });
}

// ---------------------------------------------------------------------------
// Martian benchmark_data.json schema (offline/README.md -> "Data format")
// ---------------------------------------------------------------------------

interface MartianReviewComment {
  path: string | null;
  line: number | null;
  body: string;
  created_at: string;
}

interface MartianReview {
  tool: string;
  pr_url: string;
  review_comments: MartianReviewComment[];
}

/** `submit_finding`'s args always carry `file` + `line` (both required —
 * `SubmitFindingArgsSchema` in `output-tools.ts`), so every finding maps to a "line-specific"
 * Martian comment, which offline/README.md's step2 treats as a direct candidate (no LLM
 * extraction pass needed on our own output). `summary` is the one-sentence headline; `details`
 * carries the full rationale — both are folded into `body` so nothing is lost to the judge. */
function findingToMartianComment(
  finding: { file: string; line: number; severity: string; summary: string; details: string },
  createdAt: string
): MartianReviewComment {
  return {
    path: finding.file,
    line: finding.line,
    body: `[${finding.severity}] ${finding.summary}\n\n${finding.details}`,
    created_at: createdAt,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Args {
  golden?: string;
  model: ModelConfigArg;
  out: string;
  limit?: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  let golden: string | undefined;
  let model = "openai:gpt-5";
  let out = DEFAULT_OUT;
  let limit: number | undefined;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--golden") golden = argv[++i];
    else if (arg === "--model") model = argv[++i] ?? model;
    else if (arg === "--out") out = argv[++i] ?? out;
    else if (arg === "--limit") limit = Number(argv[++i]);
    else if (arg === "--dry-run") dryRun = true;
  }

  return { golden, model: parseModelSpec(model), out, limit, dryRun };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.golden) {
    console.error("Error: --golden <dir> is required (path to offline/golden_comments)");
    process.exit(1);
  }

  const allPrs = loadGoldenPrs(args.golden);
  const prs = args.limit ? allPrs.slice(0, args.limit) : allPrs;

  console.log(
    `Loaded ${allPrs.length} golden PRs from ${args.golden}${args.limit ? ` (limiting to ${prs.length})` : ""}`
  );
  for (const pr of prs) {
    console.log(`  ${pr.sourceFile}: ${pr.owner}/${pr.repo}#${pr.prNumber}`);
  }

  if (args.dryRun) {
    console.log("\n--dry-run: no GitHub fetch, no model call. Exiting.");
    return;
  }

  const githubToken = resolveGitHubToken();
  if (!githubToken) {
    console.error("Error: set OCTOKIT_AUTH or GITHUB_TOKEN (read-only GitHub access).");
    process.exit(1);
  }
  const apiKey = resolveProviderApiKey(args.model.provider);
  if (!apiKey) {
    console.error(
      `Error: no credential for provider "${args.model.provider}". Set OPENAI_API_KEY / GOOGLE_AI_API_KEY / ANTHROPIC_API_KEY as appropriate.`
    );
    process.exit(1);
  }

  const octokit = new Octokit({ auth: githubToken });

  const output: Record<string, { reviews: MartianReview[] }> = {};
  const generationMeta: Array<{ pr: string; tokensUsed?: number; roundsUsed?: number }> = [];

  for (const [idx, pr] of prs.entries()) {
    console.log(`\n[${idx + 1}/${prs.length}] ${pr.owner}/${pr.repo}#${pr.prNumber}...`);
    const ctx = await fetchPrContext(octokit, pr.owner, pr.repo, pr.prNumber);
    const reviewOutput = await generateReview(args.model, apiKey, ctx, pr.prNumber);

    const createdAt = new Date().toISOString();
    const findings = reviewOutput.toolCalls
      .filter((tc) => tc.name === "submit_finding")
      .map((tc) => (tc.name === "submit_finding" ? tc.args : null))
      .filter((f): f is NonNullable<typeof f> => f !== null);

    const reviewComments = findings.map((f) =>
      findingToMartianComment(
        {
          file: f.file,
          line: f.line,
          severity: f.severity,
          summary: f.summary,
          details: f.details,
        },
        createdAt
      )
    );

    output[pr.goldenUrl] = {
      reviews: [
        {
          tool: "minsky",
          pr_url: `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.prNumber}`,
          review_comments: reviewComments,
        },
      ],
    };

    generationMeta.push({
      pr: pr.goldenUrl,
      tokensUsed: reviewOutput.tokensUsed,
      roundsUsed: reviewOutput.toolLoop?.roundsUsed,
    });

    console.log(`  -> ${reviewComments.length} findings, ${reviewOutput.tokensUsed ?? "?"} tokens`);
  }

  const outDir = dirname(args.out);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  // benchmark_data.json's real schema also carries golden_comments/pr_title/source_repo per
  // entry (offline/README.md -> "Data format") — those come from the golden file itself and are
  // deliberately NOT duplicated here; step2/step2.5/step3 read `reviews[]` off whatever entry
  // already exists in the file the pinned checkout's own step1 would have produced. This script
  // writes a reviews-only overlay; merging it onto step1's golden-comment-carrying shape (or
  // producing the full shape directly) is remaining implementation work — see the mt#4577 spec's
  // "Remaining implementation work" list, item 2.
  writeFileSync(args.out, JSON.stringify(output, null, 2));
  writeFileSync(
    args.out.replace(/\.json$/, "-generation-meta.json"),
    JSON.stringify(
      { model: args.model, generatedAt: new Date().toISOString(), reviews: generationMeta },
      null,
      2
    )
  );

  console.log(`\nWrote ${Object.keys(output).length} reviews to ${args.out}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
