#!/usr/bin/env bun
/**
 * Replay harness for the documentation-impact check (mt#3527).
 *
 * Replays a set of PRs through the reviewer prompt and reports, per attempt,
 * what `submit_documentation_impact` came back with: the verdict kind, the
 * evidence text, and the docs it named. It posts nothing to GitHub.
 *
 * Why this is not `replay-structural-output.ts` with a different assertion:
 * that script stubs the tool context (`readFile: async () => null`), which is
 * fine for a chain-of-thought-leak check but fatal here. Detecting that a diff
 * INVALIDATES a doc requires reading the doc's existing prose, so this harness
 * wires the real `readFileAtRef` / `listDirectoryAtRef` against the PR's head
 * SHA — the same view production gives the reviewer.
 *
 * Measuring before/after: run it on the baseline tree, apply the prompt change,
 * run it again. There is deliberately no "disable the new instruction" flag —
 * a flag that exists only for the benchmark can drift from what production
 * actually sends, and the git-checkout comparison cannot.
 *
 * Usage:
 *   bun services/reviewer/scripts/replay-doc-impact.ts
 *   bun services/reviewer/scripts/replay-doc-impact.ts --prs=2508,2513 --attempts=3
 *   bun services/reviewer/scripts/replay-doc-impact.ts --out=/tmp/baseline.json
 *
 * Flags:
 *   --owner=O      Repo owner. Default: GITHUB_REPOSITORY's owner, else edobry.
 *   --repo=R       Repo name.  Default: GITHUB_REPOSITORY's repo,  else minsky.
 *   --prs=N,N      PR numbers to replay. Default: the mt#3527 corpus.
 *   --attempts=K   Attempts per PR (the check is model output; K>1 shows spread). Default 1.
 *   --model=M      Model id. Default gpt-5.
 *   --out=PATH     Results JSON path. Default: scripts/replay-doc-impact-results.json.
 *
 * Skips cleanly (exit 0) when OPENAI_API_KEY or a GitHub token is absent.
 */

import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { callOpenAIWithClient } from "../src/providers";
import { buildCriticConstitution, buildReviewPrompt } from "../src/prompt";
import { readFileAtRef, listDirectoryAtRef } from "../src/github-client";
import type { ReviewToolCall } from "../src/output-tools";
import { resolveGitHubTokenOrSkip, getAuthSource } from "./harness-auth";

/**
 * Target repository for the PR fetch.
 *
 * Resolution order: `--owner`/`--repo` flags, then `GITHUB_REPOSITORY` ("owner/repo",
 * which CI sets), then the default below. The default is not a portability shortcut —
 * the corpus PR numbers are meaningless in any other repo — but it must stay
 * overridable so a fork or mirror does not silently replay against upstream.
 */
const DEFAULT_OWNER = "edobry";
const DEFAULT_REPO = "minsky";

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

  // Flags win over the environment.
  for (const arg of argv) {
    if (arg.startsWith("--owner=")) {
      const value = arg.slice("--owner=".length).trim();
      if (value) owner = value;
    } else if (arg.startsWith("--repo=")) {
      const value = arg.slice("--repo=".length).trim();
      if (value) repo = value;
    }
  }

  return { owner: owner ?? DEFAULT_OWNER, repo: repo ?? DEFAULT_REPO };
}

/**
 * The mt#3527 corpus.
 *
 * 2508 — Phase 1 of Telegram threaded mode. Changed the principal channel from
 *        one standing conversation to one per topic, falsifying the lead
 *        sentence of `docs/principal-channel.md`. All four production reviews
 *        returned `no-update-needed`. This is the miss under test.
 * 2513 — Phase 2 (`/bind` + taskId routing). Production caught this one, but
 *        framed additively ("docs omit /bind"). Regression check: it must still
 *        name the doc.
 * 2521 — Control. A reviewer-service internal change with no documented-behavior
 *        surface; a check that fires here is firing on everything.
 */
const DEFAULT_PR_NUMBERS = [2508, 2513, 2521];
const DEFAULT_ATTEMPTS = 1;
const DEFAULT_MODEL = "gpt-5";

interface Args {
  prNumbers: number[];
  attempts: number;
  model: string;
  outPath: string;
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

function parseArgs(): Args {
  let prNumbers = DEFAULT_PR_NUMBERS;
  let attempts = DEFAULT_ATTEMPTS;
  let model = DEFAULT_MODEL;
  let outPath = join(SCRIPT_DIR, "replay-doc-impact-results.json");

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
    }
  }

  return { prNumbers, attempts, model, outPath };
}

interface PrContext {
  prNumber: number;
  title: string;
  body: string;
  branchName: string;
  baseBranch: string;
  headSha: string;
  /**
   * Repo the head SHA lives in. For a fork PR this differs from the base repo, and
   * reading file content at that SHA under the BASE coordinates is not reliable —
   * so content reads use these, while the PR/diff fetch uses the base coordinates.
   * Falls back to the base repo when the head repo is gone (deleted fork).
   */
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

export interface DocImpactObservation {
  attempt: number;
  /** null when the model never emitted the call at all. */
  kind: string | null;
  evidence: string;
  affectedDocs: string[];
  /** Whether `evidence` contains a quoted span — the invalidation instruction asks for one. */
  quotesDocProse: boolean;
  readFileCallCount: number;
  docsRead: string[];
}

export interface PrReplayResult {
  prNumber: number;
  title: string;
  headSha: string;
  observations: DocImpactObservation[];
}

/**
 * A quoted doc sentence is the artifact the invalidation instruction asks for,
 * so detect it structurally rather than eyeballing the evidence text: paired
 * double quotes (straight or curly) or a backticked span long enough to be
 * prose rather than a bare identifier.
 *
 * The apostrophe is deliberately NOT a delimiter here. Two possessives in one
 * sentence ("the reviewer's verdict rests on the author's summary") sit far
 * enough apart to satisfy any useful length floor, so admitting `'` makes
 * ordinary English read as a quotation.
 */
const QUOTED_PROSE_MIN_CHARS = 25;

/**
 * Length alone does not separate prose from an identifier: `docs/principal-channel.md`
 * is 25 characters. Requiring an interior space does — file paths, symbols, and flags
 * do not contain one, and a quoted doc SENTENCE always does.
 */
function spanIsProse(span: string): boolean {
  return span.length >= QUOTED_PROSE_MIN_CHARS && span.trim().includes(" ");
}

export function evidenceQuotesDocProse(evidence: string): boolean {
  const spans = [...evidence.matchAll(/["“”]([^"“”]+)["“”]/g), ...evidence.matchAll(/`([^`]+)`/g)];
  return spans.some((m) => spanIsProse(m[1] ?? ""));
}

function extractDocImpact(toolCalls: ReadonlyArray<ReviewToolCall>): {
  kind: string | null;
  evidence: string;
  affectedDocs: string[];
} {
  // Mirrors compose-review.ts: the LAST call wins (self-correction semantics).
  const calls = toolCalls.filter((tc) => tc.name === "submit_documentation_impact");
  const last = calls[calls.length - 1];
  if (!last || last.name !== "submit_documentation_impact") {
    return { kind: null, evidence: "", affectedDocs: [] };
  }
  return {
    kind: last.args.kind,
    evidence: last.args.evidence,
    affectedDocs: last.args.affectedDocs ?? [],
  };
}

async function replayPr(
  client: OpenAI,
  octokit: Octokit,
  model: string,
  ctx: PrContext,
  attempts: number
): Promise<PrReplayResult> {
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

  const observations: DocImpactObservation[] = [];

  for (let i = 0; i < attempts; i++) {
    const attempt = i + 1;
    // Per-attempt, so one attempt's reads are not attributed to the next.
    const docsRead: string[] = [];

    const output = await callOpenAIWithClient(client, model, systemPrompt, userPrompt, {
      readFile: async (path: string, signal?: AbortSignal) => {
        docsRead.push(path);
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

    const { kind, evidence, affectedDocs } = extractDocImpact(output.toolCalls);

    observations.push({
      attempt,
      kind,
      evidence,
      affectedDocs,
      quotesDocProse: evidenceQuotesDocProse(evidence),
      readFileCallCount: docsRead.length,
      docsRead,
    });

    console.log(
      `  attempt ${attempt}/${attempts}: kind=${kind ?? "<none>"} docs=[${affectedDocs.join(", ")}] quoted=${evidenceQuotesDocProse(evidence)} reads=${docsRead.length}`
    );
    if (evidence) console.log(`    evidence: ${evidence.slice(0, 400)}`);
  }

  return {
    prNumber: ctx.prNumber,
    title: ctx.title,
    headSha: ctx.headSha,
    observations,
  };
}

async function main(): Promise<void> {
  // Env gating lives here, not at module scope: `evidenceQuotesDocProse` is unit-tested,
  // and a module-scope `process.exit(0)` would kill the test runner on import.
  const openaiApiKey = process.env.OPENAI_API_KEY;
  if (!openaiApiKey) {
    console.log("SKIP: OPENAI_API_KEY not set; skipping live doc-impact replay.");
    return;
  }
  const githubToken = resolveGitHubTokenOrSkip();

  const { prNumbers, attempts, model, outPath } = parseArgs();
  const { owner, repo } = resolveRepoCoordinates(process.argv.slice(2), process.env);

  console.log(
    `doc-impact replay: repo=${owner}/${repo} prs=[${prNumbers.join(", ")}] attempts=${attempts} model=${model} auth=${getAuthSource()}`
  );

  const client = new OpenAI({ apiKey: openaiApiKey });
  const octokit = new Octokit({ auth: githubToken });

  const results: PrReplayResult[] = [];

  for (const prNumber of prNumbers) {
    console.log(`\nPR #${prNumber}`);
    const ctx = await fetchPr(octokit, owner, repo, prNumber);
    console.log(`  ${ctx.title} (head ${ctx.headSha.slice(0, 9)}, ${ctx.diff.length} diff chars)`);
    results.push(await replayPr(client, octokit, model, ctx, attempts));
  }

  const hitCount = results.reduce(
    (acc, r) =>
      acc + r.observations.filter((o) => o.kind !== null && o.kind !== "no-update-needed").length,
    0
  );
  const total = results.reduce((acc, r) => acc + r.observations.length, 0);

  const artifact = {
    repo: `${owner}/${repo}`,
    model,
    attempts,
    prNumbers,
    // Callers stamp their own run label; the script takes no clock reading so
    // repeated runs stay diffable.
    results,
    summary: {
      totalObservations: total,
      nonNoUpdateNeeded: hitCount,
      hitRate: total === 0 ? 0 : hitCount / total,
    },
  };

  writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(
    `\nwrote ${outPath}: ${hitCount}/${total} observations returned a verdict other than no-update-needed`
  );
}

// Guarded so the test importing `evidenceQuotesDocProse` does not launch a replay.
if (import.meta.main) {
  await main();
}
