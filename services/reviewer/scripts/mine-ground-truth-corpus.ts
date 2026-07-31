#!/usr/bin/env bun
/**
 * Ground-truth corpus miner (mt#2726 Milestone A, wave 2).
 *
 * Mines `minsky-reviewer[bot]`'s own review history on `edobry/minsky` into a
 * versioned, git-committed JSONL corpus (`CorpusRow[]`, see `../src/eval-corpus.ts`)
 * for the paired-eval runner (not built in this wave) to replay models/prompt
 * variants against.
 *
 * For each BLOCKING finding raised in a review round, the finding's file:line
 * window is cross-checked against the diff to the NEXT round (or, for a PR's
 * final round, the diff to the merge commit) to derive a noisy but
 * deterministic outcome label — see `deriveLabel` below and the mt#2726 spec's
 * "Design sketch" section for the label taxonomy.
 *
 * A second, independent slice reuses `seeded-bug-harness.ts`'s `BUG_CATALOG`
 * as unambiguous-location ground truth (`buildInjectedBugCorpusRows`) — those
 * rows need no GitHub access at all.
 *
 * Usage:
 *   GITHUB_TOKEN=<pat> bun services/reviewer/scripts/mine-ground-truth-corpus.ts
 *   GITHUB_TOKEN=<pat> bun services/reviewer/scripts/mine-ground-truth-corpus.ts --dry-run --limit 2
 *   GITHUB_TOKEN=<pat> bun services/reviewer/scripts/mine-ground-truth-corpus.ts --limit 50 --out /tmp/corpus.jsonl --corpus-version v1
 *
 * Flags:
 *   --dry-run          Validate wiring only: construct the Octokit client and
 *                       fetch a small bounded sample (2 PRs, unpaginated).
 *                       Prints a JSON summary; does not write a corpus file.
 *   --limit N          Cap the number of closed/merged PRs mined (full run only).
 *   --out <path>        Corpus output path. Default:
 *                       services/reviewer/eval/corpus/ground-truth-<version>.jsonl
 *   --corpus-version v1 Corpus version tag stamped on every row. Default "v1".
 *
 * Skips gracefully (exit 0) when neither GITHUB_TOKEN nor GH_TOKEN is set —
 * this script is GitHub-API-heavy and is not meant to run unattended in CI.
 *
 * Diff caching: `octokit.repos.compareCommits` responses are cached to disk
 * under `services/reviewer/eval/cache/diffs/<baseSha>_<headSha>.json`, keyed
 * by the SHA pair, to avoid refetching the same diff across findings/PRs
 * (documented cache dir, not a scratch artifact — safe to delete and
 * re-populate; it IS gitignored via `services/reviewer/eval/cache/` in
 * `.gitignore` — regenerable local data, so large caches never get
 * committed — but repeat local runs still stay cheap because deleting the
 * ignored directory only forces a one-time refetch, not a permanent loss).
 */

import { Octokit } from "@octokit/rest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFindingsFromBody, type FlatFinding } from "../src/replay-summary";
import {
  serializeCorpusJsonl,
  type CorpusFinding,
  type CorpusLabelConfidence,
  type CorpusLabelValue,
  type CorpusRow,
} from "../src/eval-corpus";
import { BUG_CATALOG, type BugPattern } from "./seeded-bug-harness";
import { resolveGitHubToken } from "./harness-auth";

const OWNER = "edobry";
const REPO = "minsky";
const BOT_LOGIN = "minsky-reviewer[bot]";

/** Target context-window radius in lines, per the mt#2726 spec's Design sketch. */
const CONTEXT_WINDOW_LINES = 80;

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(SCRIPT_DIR, "..", "eval", "cache", "diffs");
const CORPUS_DIR = join(SCRIPT_DIR, "..", "eval", "corpus");

// ---------------------------------------------------------------------------
// Label derivation (pure — unit-tested with fixture inputs, no live API)
// ---------------------------------------------------------------------------

/**
 * Inputs to `deriveLabel`: the two deterministic signals git-diff mining can
 * observe about a BLOCKING finding once the next review round (or the PR's
 * merge diff, for a final round) is known.
 */
export interface DeriveLabelInput {
  /**
   * Whether the finding's file:line window overlaps a changed region in the
   * next round's diff (or the merge diff, for a final-round finding).
   */
  regionChanged: boolean;
  /**
   * Whether a finding at the same (or overlapping) file:line window was
   * re-raised in the next review round. Always `false` when there is no
   * next round (the PR's final reviewed round).
   */
  reRaised: boolean;
}

/** Output of `deriveLabel`: the outcome value plus its confidence tag. */
export interface DerivedLabel {
  value: CorpusLabelValue;
  confidence: CorpusLabelConfidence;
}

/**
 * Derive a noisy-but-deterministic outcome label for a BLOCKING finding from
 * the two git-diff-mining signals above. Rules (mt#2726 spec, Design sketch):
 *
 *   - region changed             -> `git-diff-fixed`             (`noisy-positive`)
 *   - re-raised, region unchanged -> `carried-forward-unchanged`  (`noisy-negative`)
 *   - neither                    -> `dismissed-no-change`         (`noisy-negative`)
 *
 * `regionChanged` takes priority over `reRaised`: a finding can, in
 * principle, be both touched AND re-raised on the same file (a partial fix
 * that resurfaces a related concern) — the "touched" signal is treated as
 * the stronger one, per `noisy-positive`'s own caveat: touched != proven-fixed,
 * but it's still evidence of engagement, whereas an untouched-and-re-raised
 * region is unambiguous evidence of non-engagement.
 *
 * Pure function — no I/O, no network. Exported for unit testing.
 */
export function deriveLabel(input: DeriveLabelInput): DerivedLabel {
  if (input.regionChanged) {
    return { value: "git-diff-fixed", confidence: "noisy-positive" };
  }
  if (input.reRaised) {
    return { value: "carried-forward-unchanged", confidence: "noisy-negative" };
  }
  return { value: "dismissed-no-change", confidence: "noisy-negative" };
}

// ---------------------------------------------------------------------------
// Injected-bug slice (pure — no GitHub access needed)
// ---------------------------------------------------------------------------

/**
 * Build the ±`CONTEXT_WINDOW_LINES` code context window around `anchorLine`
 * (1-based) from a full file's text content. Pure, shared by both the
 * injected-bug slice (local `bugPattern.code`) and the git-diff-mined slice
 * (file content fetched from GitHub at the review round's head SHA).
 */
export function extractContextWindow(fullText: string, anchorLine: number): string {
  const lines = fullText.split("\n");
  const startIdx = Math.max(0, anchorLine - 1 - CONTEXT_WINDOW_LINES);
  const endIdx = Math.min(lines.length, anchorLine - 1 + CONTEXT_WINDOW_LINES + 1);
  return lines.slice(startIdx, endIdx).join("\n");
}

/**
 * Map one `seeded-bug-harness.ts` `BugPattern` to a `CorpusRow`. The bug's
 * location (`injectedLine`) is exact ground truth — unlike the git-diff-mined
 * slice's noisy labels — so these rows get `confidence: "gold"`.
 *
 * Pure function — no I/O, no network. Exported for unit testing.
 */
export function buildInjectedBugCorpusRow(
  bug: BugPattern,
  corpusVersion: string,
  minedAt: string
): CorpusRow {
  const finding: CorpusFinding = {
    file: `services/reviewer/scripts/__seeded_bug_targets__/${bug.name}.ts`,
    severity: "BLOCKING",
    line: bug.injectedLine,
    text: bug.description,
  };

  return {
    id: `injected-${bug.name}`,
    corpusVersion,
    source: "injected-bug",
    prNumber: 0,
    round: 0,
    finding,
    codeContextWindow: extractContextWindow(bug.code, bug.injectedLine),
    label: { value: "injected-exact", provenance: "deterministic", confidence: "gold" },
    minedAt,
  };
}

/**
 * Build the full injected-bug slice from `BUG_CATALOG`. Pure — no I/O.
 * Exported for unit testing.
 */
export function buildInjectedBugCorpusRows(corpusVersion: string, minedAt: string): CorpusRow[] {
  return BUG_CATALOG.map((bug) => buildInjectedBugCorpusRow(bug, corpusVersion, minedAt));
}

// ---------------------------------------------------------------------------
// Diff cross-check (pure helpers; I/O only in fetchCompare)
// ---------------------------------------------------------------------------

interface CachedCompareFile {
  filename: string;
  status: string;
  patch?: string;
}

interface CachedCompare {
  files: CachedCompareFile[];
}

function isValidCachedCompare(value: unknown): value is CachedCompare {
  if (typeof value !== "object" || value === null) return false;
  const files = (value as Record<string, unknown>)["files"];
  if (!Array.isArray(files)) return false;
  return files.every((f) => {
    if (typeof f !== "object" || f === null) return false;
    const rec = f as Record<string, unknown>;
    return typeof rec["filename"] === "string" && typeof rec["status"] === "string";
  });
}

function diffCachePath(baseSha: string, headSha: string): string {
  return join(CACHE_DIR, `${baseSha}_${headSha}.json`);
}

function readDiffCache(baseSha: string, headSha: string): CachedCompare | undefined {
  const cachePath = diffCachePath(baseSha, headSha);
  try {
    if (!existsSync(cachePath)) return undefined;
    const raw = readFileSync(cachePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    return isValidCachedCompare(parsed) ? parsed : undefined;
  } catch {
    // Corrupt/unreadable cache entry — treat as a miss, re-fetch.
    return undefined;
  }
}

function writeDiffCache(baseSha: string, headSha: string, data: CachedCompare): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(diffCachePath(baseSha, headSha), JSON.stringify(data), "utf-8");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `Warning: failed to write diff cache for ${baseSha}..${headSha}: ${message}\n`
    );
  }
}

async function fetchCompare(
  octokit: Octokit,
  baseSha: string,
  headSha: string
): Promise<CachedCompare | undefined> {
  const cached = readDiffCache(baseSha, headSha);
  if (cached) return cached;

  try {
    const resp = await octokit.rest.repos.compareCommits({
      owner: OWNER,
      repo: REPO,
      base: baseSha,
      head: headSha,
    });
    const files: CachedCompareFile[] = (resp.data.files ?? []).map((f) => ({
      filename: f.filename,
      status: f.status,
      ...(f.patch ? { patch: f.patch } : {}),
    }));
    const data: CachedCompare = { files };
    writeDiffCache(baseSha, headSha, data);
    return data;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Warning: compareCommits failed for ${baseSha}..${headSha}: ${message}\n`);
    return undefined;
  }
}

/**
 * Parse a unified-diff patch's `@@ -a,b +c,d @@` hunk headers into the
 * post-image (`+`) line ranges they cover. Pure. Exported for unit testing.
 */
export function parsePatchHunkRanges(patch: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const hunkRe = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
  for (const match of patch.matchAll(hunkRe)) {
    const startRaw = match[1];
    if (!startRaw) continue;
    const start = parseInt(startRaw, 10);
    const lenRaw = match[2];
    const len = lenRaw ? parseInt(lenRaw, 10) : 1;
    ranges.push({ start, end: start + Math.max(len - 1, 0) });
  }
  return ranges;
}

/**
 * Determine whether `finding`'s file:line window overlaps a changed region
 * in `compare`. Conservative widening when line-level precision isn't
 * available (no patch text — e.g. a binary or too-large diff — or the
 * finding itself has no line number): "the file was touched at all" is
 * treated as a region change, since there's no finer signal to check
 * against. Pure. Exported for unit testing.
 */
export function regionChangedForFinding(compare: CachedCompare, finding: FlatFinding): boolean {
  const fileEntry = compare.files.find((f) => f.filename === finding.file);
  if (!fileEntry) return false;
  if (!fileEntry.patch || finding.line === undefined) return true;

  const findingStart = finding.line;
  const findingEnd = finding.lineEnd ?? finding.line;
  const ranges = parsePatchHunkRanges(fileEntry.patch);
  return ranges.some((r) => r.start <= findingEnd && findingStart <= r.end);
}

/**
 * Max line-number distance for a next-round finding to count as "the same
 * location" as the current finding. Mirrors `refutation-recovery.ts`'s
 * `LINE_PROXIMITY` — successive review rounds routinely re-cite the same
 * concern with a slightly different line number as unrelated code shifts
 * above it, so exact-line or strict-range-overlap matching is too strict.
 */
const RE_RAISE_LINE_PROXIMITY = 5;

/**
 * Determine whether `finding` was re-raised in `nextRoundFindings`: same
 * file, and a line number within `RE_RAISE_LINE_PROXIMITY` (or — when
 * either side lacks line info — same file is the best signal available).
 * Pure. Exported for unit testing.
 */
export function findingReRaised(finding: FlatFinding, nextRoundFindings: FlatFinding[]): boolean {
  return nextRoundFindings.some((other) => {
    if (other.file !== finding.file) return false;
    if (finding.line === undefined || other.line === undefined) return true;
    return Math.abs(finding.line - other.line) <= RE_RAISE_LINE_PROXIMITY;
  });
}

// ---------------------------------------------------------------------------
// GitHub orchestration (pagination pattern reused from calibrate-tolerance.ts's
// fetchAllBotReviews)
// ---------------------------------------------------------------------------

interface PrSummary {
  number: number;
  mergeCommitSha: string | undefined;
}

async function fetchClosedMergedPrs(
  octokit: Octokit,
  limit: number | undefined
): Promise<PrSummary[]> {
  const prs: PrSummary[] = [];
  let page = 1;
  const PER_PAGE = 30;

  while (true) {
    const resp = await octokit.rest.pulls.list({
      owner: OWNER,
      repo: REPO,
      state: "closed",
      sort: "created",
      direction: "desc",
      per_page: PER_PAGE,
      page,
    });
    const batch = resp.data;
    if (batch.length === 0) break;

    for (const pr of batch) {
      if (!pr.merged_at) continue;
      prs.push({ number: pr.number, mergeCommitSha: pr.merge_commit_sha ?? undefined });
      if (limit !== undefined && prs.length >= limit) return prs;
    }

    if (batch.length < PER_PAGE) break;
    page++;
  }

  return prs;
}

interface BotReviewRound {
  round: number;
  body: string;
  commitSha: string;
}

async function fetchBotReviewRounds(octokit: Octokit, prNumber: number): Promise<BotReviewRound[]> {
  interface RawRound {
    body: string;
    commitSha: string;
    submittedAt: string;
  }
  const raw: RawRound[] = [];
  let page = 1;
  const PER_PAGE = 100;

  while (true) {
    const resp = await octokit.rest.pulls.listReviews({
      owner: OWNER,
      repo: REPO,
      pull_number: prNumber,
      per_page: PER_PAGE,
      page,
    });
    const reviews = resp.data;
    if (reviews.length === 0) break;

    for (const review of reviews) {
      if (review.user?.login !== BOT_LOGIN) continue;
      const body = review.body ?? "";
      if (body.trim().length === 0) continue;
      if (!review.commit_id) continue;
      raw.push({ body, commitSha: review.commit_id, submittedAt: review.submitted_at ?? "" });
    }

    if (reviews.length < PER_PAGE) break;
    page++;
  }

  raw.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  return raw.map((r, idx) => ({ round: idx + 1, body: r.body, commitSha: r.commitSha }));
}

async function fetchCodeContextWindow(
  octokit: Octokit,
  path: string,
  ref: string,
  anchorLine: number
): Promise<string> {
  try {
    const resp = await octokit.rest.repos.getContent({ owner: OWNER, repo: REPO, path, ref });
    const data = resp.data;
    if (Array.isArray(data) || data.type !== "file" || typeof data.content !== "string") {
      return "";
    }
    const decoded = Buffer.from(data.content, "base64").toString("utf-8");
    return extractContextWindow(decoded, anchorLine);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Warning: getContent failed for ${path}@${ref}: ${message}\n`);
    return "";
  }
}

/** Mine one PR's bot review rounds into `CorpusRow`s. Never throws — logs + skips on failure. */
async function mineOnePr(
  octokit: Octokit,
  pr: PrSummary,
  corpusVersion: string
): Promise<CorpusRow[]> {
  const rows: CorpusRow[] = [];

  try {
    const rounds = await fetchBotReviewRounds(octokit, pr.number);
    if (rounds.length === 0) return rows;

    for (let i = 0; i < rounds.length; i++) {
      const round = rounds[i];
      if (!round) continue;

      const findings = parseFindingsFromBody(round.body);
      const blockingFindings = findings.filter((f) => f.severity === "BLOCKING");
      if (blockingFindings.length === 0) continue;

      const nextRound = rounds[i + 1];
      const diffHeadSha = nextRound ? nextRound.commitSha : pr.mergeCommitSha;
      if (!diffHeadSha) continue; // nothing to cross-check against — skip defensively

      const compare = await fetchCompare(octokit, round.commitSha, diffHeadSha);
      if (!compare) continue; // fetch failure already logged by fetchCompare

      const nextRoundFindings = nextRound ? parseFindingsFromBody(nextRound.body) : [];
      const minedAt = new Date().toISOString();

      for (let findingIdx = 0; findingIdx < blockingFindings.length; findingIdx++) {
        const finding = blockingFindings[findingIdx];
        if (!finding) continue;

        try {
          const regionChanged = regionChangedForFinding(compare, finding);
          const reRaised = nextRound ? findingReRaised(finding, nextRoundFindings) : false;
          const label = deriveLabel({ regionChanged, reRaised });

          const anchorLine = finding.line ?? 1;
          const codeContextWindow = await fetchCodeContextWindow(
            octokit,
            finding.file,
            round.commitSha,
            anchorLine
          );

          const text =
            finding.text && finding.text.length > 0
              ? finding.text
              : `${finding.severity} finding at ${finding.file}:${finding.line ?? "?"}`;

          const corpusFinding: CorpusFinding = {
            file: finding.file,
            severity: finding.severity,
            ...(finding.line !== undefined ? { line: finding.line } : {}),
            ...(finding.lineEnd !== undefined ? { lineEnd: finding.lineEnd } : {}),
            text,
          };

          rows.push({
            id: `pr-${pr.number}-r${round.round}-f${findingIdx}`,
            corpusVersion,
            source: "git-diff-mined",
            prNumber: pr.number,
            round: round.round,
            finding: corpusFinding,
            codeContextWindow,
            label: {
              value: label.value,
              provenance: "deterministic",
              confidence: label.confidence,
            },
            minedAt,
          });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `Warning: failed to process finding ${findingIdx} in PR #${pr.number} round ${round.round}: ${message}\n`
          );
        }
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Warning: failed to mine PR #${pr.number}: ${message}\n`);
  }

  return rows;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliArgs {
  dryRun: boolean;
  limit: number | undefined;
  out: string | undefined;
  corpusVersion: string;
}

function parseArgs(argv: string[]): CliArgs {
  let dryRun = false;
  let limit: number | undefined;
  let out: string | undefined;
  let corpusVersion = "v1";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--limit") {
      const val = argv[i + 1];
      if (val !== undefined) {
        const parsed = parseInt(val, 10);
        if (Number.isFinite(parsed) && parsed > 0) limit = parsed;
        i++;
      }
      continue;
    }
    if (arg === "--out") {
      const val = argv[i + 1];
      if (val !== undefined) {
        out = val;
        i++;
      }
      continue;
    }
    if (arg === "--corpus-version") {
      const val = argv[i + 1];
      if (val !== undefined) {
        corpusVersion = val;
        i++;
      }
      continue;
    }
  }

  return { dryRun, limit, out, corpusVersion };
}

const DRY_RUN_SAMPLE_SIZE = 2;

async function runDryRun(octokit: Octokit, corpusVersion: string): Promise<void> {
  console.log("=== mine-ground-truth-corpus dry-run ===");
  console.log(`Sample size: ${DRY_RUN_SAMPLE_SIZE} PR(s), unpaginated.`);

  const prs = await fetchClosedMergedPrs(octokit, DRY_RUN_SAMPLE_SIZE);
  let totalReviewRounds = 0;
  let totalBlockingFindings = 0;

  for (const pr of prs) {
    try {
      const rounds = await fetchBotReviewRounds(octokit, pr.number);
      totalReviewRounds += rounds.length;
      for (const round of rounds) {
        const findings = parseFindingsFromBody(round.body);
        totalBlockingFindings += findings.filter((f) => f.severity === "BLOCKING").length;
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `Warning: dry-run failed to fetch reviews for PR #${pr.number}: ${message}\n`
      );
    }
  }

  const injectedRows = buildInjectedBugCorpusRows(corpusVersion, new Date().toISOString());

  console.log(
    JSON.stringify(
      {
        prsFetched: prs.length,
        totalBotReviewRounds: totalReviewRounds,
        totalBlockingFindings,
        injectedBugRowCount: injectedRows.length,
      },
      null,
      2
    )
  );
  console.log(
    "Dry-run OK: wiring validated (Octokit client constructed, bounded sample fetch succeeded)."
  );
}

async function runFullMine(octokit: Octokit, args: CliArgs): Promise<void> {
  console.log(`Mining ground-truth corpus from ${OWNER}/${REPO}...`);
  const prs = await fetchClosedMergedPrs(octokit, args.limit);
  console.log(`Found ${prs.length} closed/merged PR(s) to mine.`);

  const allRows: CorpusRow[] = [];
  for (const pr of prs) {
    const rows = await mineOnePr(octokit, pr, args.corpusVersion);
    if (rows.length > 0) {
      console.log(`  PR #${pr.number}: ${rows.length} row(s) mined.`);
    }
    allRows.push(...rows);
  }

  const gitDiffMinedCount = allRows.length;
  const injectedRows = buildInjectedBugCorpusRows(args.corpusVersion, new Date().toISOString());
  allRows.push(...injectedRows);

  console.log(
    `Total rows mined: ${allRows.length} (${gitDiffMinedCount} git-diff-mined + ${injectedRows.length} injected-bug).`
  );

  const outPath = args.out ?? join(CORPUS_DIR, `ground-truth-${args.corpusVersion}.jsonl`);

  try {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, serializeCorpusJsonl(allRows), "utf-8");
    console.log(`Corpus written to: ${outPath}`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Fatal: failed to write corpus file: ${message}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const token = resolveGitHubToken() ?? process.env["GH_TOKEN"];
  if (!token) {
    console.log("SKIP: no GitHub token");
    process.exit(0);
  }

  const octokit = new Octokit({ auth: token });

  if (args.dryRun) {
    try {
      await runDryRun(octokit, args.corpusVersion);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Dry-run failed: ${message}`);
      process.exit(1);
    }
    return;
  }

  await runFullMine(octokit, args);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Fatal:", message);
    process.exit(1);
  });
}
