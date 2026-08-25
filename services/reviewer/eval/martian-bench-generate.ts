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

import "reflect-metadata";

import { callReviewer, type ReviewOutput } from "../src/providers";
import { buildCriticConstitution, buildReviewPrompt } from "../src/prompt";
import type { ReviewerConfig } from "../src/config";
import { resolveGitHubTokenWithConfig, getGitHubTokenSource } from "../scripts/harness-config-auth";
import { setupConfiguration } from "@minsky/domain/config-setup";
import { getConfiguration, isConfigurationInitialized } from "@minsky/domain/configuration/index";

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

/** Config path each provider's key lives at, per `config_credentials_list` /
 * `harness-config-auth.ts`'s `resolveOpenAIKey` — same shape, generalized across the three
 * providers `--model` accepts, since `resolveOpenAIKey` only covers openai. */
function configApiKeyOf(
  config: ReturnType<typeof getConfiguration>,
  provider: Provider
): string | undefined {
  return config.ai?.providers?.[provider]?.apiKey || undefined;
}

/** Env var name each provider's key is read from — matches
 * `paired-eval-runner.ts`'s `resolveProviderApiKey`, whose behavior this function extends
 * with the config fallback that function lacks (env-only; misses a machine where the key is
 * configured in Minsky rather than exported to the shell — the same trap
 * `resolveOpenAIKey`'s docblock documents for OpenAI specifically). */
function envVarNameOf(provider: Provider): string {
  switch (provider) {
    case "openai":
      return "OPENAI_API_KEY";
    case "google":
      return "GOOGLE_AI_API_KEY";
    case "anthropic":
      return "ANTHROPIC_API_KEY";
  }
}

/** Env first (matches the deployed reviewer's own resolution and keeps a run overridable),
 * then Minsky's configured `ai.providers.<provider>.apiKey` — the same two-step resolution
 * `resolveOpenAIKey` implements for openai, generalized here to all three `--model` providers
 * so a config-only anthropic/google key is not silently treated as absent either. */
async function resolveModelApiKeyWithConfig(provider: Provider): Promise<string | undefined> {
  const fromEnv = process.env[envVarNameOf(provider)];
  if (fromEnv) return fromEnv;

  if (!isConfigurationInitialized()) {
    await setupConfiguration();
  }
  return configApiKeyOf(getConfiguration(), provider);
}

async function getModelApiKeySource(provider: Provider): Promise<string> {
  if (process.env[envVarNameOf(provider)]) return envVarNameOf(provider);
  return (await resolveModelApiKeyWithConfig(provider)) ? "minsky-config" : "none";
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
  /** Carried straight through into the output artifact (see `main()`'s output construction) —
   * `step2_extract_comments.py`/`step3_judge_comments.py` read `golden_comments`/`pr_title` off
   * the SAME per-PR entry that carries `reviews[]` (offline/README.md -> "Data format"); an
   * entry with `reviews` but no `golden_comments` scores every candidate against zero golden
   * comments, which is not "unscored" but silently wrong (recall trivially undefined/skipped,
   * precision computed against nothing). */
  prTitle: string;
  goldenComments: GoldenComment[];
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
      resolved.push({
        goldenUrl: entry.url,
        owner,
        repo,
        prNumber,
        sourceFile: file,
        prTitle: entry.pr_title,
        goldenComments: entry.comments,
      });
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

/** One entry of `benchmark_data.json`, keyed by golden-comment PR URL — the shape
 * `step1_download_prs.py` writes and `step2_extract_comments.py`/`step3_judge_comments.py` read
 * (offline/README.md -> "Data format"). `golden_comments`/`pr_title`/`source_repo` live on the
 * SAME entry as `reviews[]`; an entry missing them scores against zero golden comments. */
interface MartianBenchmarkEntry {
  pr_title: string;
  original_url: string;
  source_repo: string;
  golden_comments: GoldenComment[];
  reviews: MartianReview[];
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

  // Env first, then Minsky's own configuration — a harness running on a developer machine
  // typically has neither OCTOKIT_AUTH/GITHUB_TOKEN nor OPENAI_API_KEY/etc. exported to the
  // shell while the equivalent credential IS configured in Minsky (`github.token`,
  // `ai.providers.<provider>.apiKey`). An env-only resolver reports "no credential" on a
  // machine that has one — see harness-config-auth.ts's resolveOpenAIKey docblock, and
  // resolveModelApiKeyWithConfig above, which generalizes that fallback to all three
  // `--model` providers.
  const githubToken = await resolveGitHubTokenWithConfig();
  if (!githubToken) {
    console.error(
      "Error: no GitHub token. Set OCTOKIT_AUTH or GITHUB_TOKEN, or configure `github.token` in Minsky."
    );
    process.exit(1);
  }
  const apiKey = await resolveModelApiKeyWithConfig(args.model.provider);
  if (!apiKey) {
    console.error(
      `Error: no credential for provider "${args.model.provider}". Set ${envVarNameOf(args.model.provider)}, or configure ai.providers.${args.model.provider}.apiKey in Minsky.`
    );
    process.exit(1);
  }
  console.log(
    `Credentials: github=${await getGitHubTokenSource()} model(${args.model.provider})=${await getModelApiKeySource(args.model.provider)}`
  );

  const octokit = new Octokit({ auth: githubToken });

  const output: Record<string, MartianBenchmarkEntry> = {};
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
      pr_title: pr.prTitle,
      original_url: pr.goldenUrl,
      source_repo: pr.repo,
      golden_comments: pr.goldenComments,
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

  // Writes the FULL benchmark_data.json shape (golden_comments + reviews per entry), not a
  // reviews-only overlay — so step2_extract_comments.py/step3_judge_comments.py can run against
  // this file directly, without a separate merge step against step1's output.
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
