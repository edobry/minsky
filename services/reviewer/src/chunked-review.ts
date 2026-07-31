/**
 * Chunked review orchestration for large PRs (mt#2120).
 *
 * When a PR's total diff exceeds the size gate, files are grouped into
 * chunks of ~20 and each chunk gets a separate model call with only
 * its files' patches in the prompt. Findings are aggregated across
 * chunks before composition.
 */

import type { PrFileEntry } from "./github-client";
import type { ReviewPromptInput } from "./prompt";
import {
  buildReviewThreadsSection,
  buildMigrationBaselineSection,
  buildOutOfRepoSection,
} from "./prompt";
import { parseUnifiedDiff } from "@minsky/domain/utils/parse-diff";
import { safeTruncate } from "@minsky/shared/safe-truncate";
import type { ReviewerConfig } from "./config";
import type { ReviewerToolContext } from "./tools";
import { callReviewer, type ReviewOutput } from "./providers";
import {
  callReviewerWithRetry,
  validateReviewOutput,
  type CallWithRetryResult,
  type CallReviewerFn,
} from "./review-output-validation";
import { log } from "./logger";

export const CHUNKED_REVIEW_FILE_THRESHOLD = 20;
export const CHUNKED_REVIEW_LINE_THRESHOLD = 2000;
export const FILES_PER_CHUNK = 20;

// Token-budget constants (mt#2243). The originating incident: PR #1478's
// regenerated minified Slidev bundle assembled a 292,033-token chunk prompt
// against gpt-5's 272,000-token input limit, because chunkFiles grouped purely
// by file count with no size budget and buildChunkDiff embedded each patch
// verbatim with no cap. These bound the diff portion of every chunk so the
// assembled prompt stays comfortably under the model limit.

// Conservative chars-per-token estimate. Minified/dense content runs
// ~2.5-3.5 chars/token; 3 is a safe middle, and the large headroom below
// (100k diff budget vs 272k model limit) absorbs estimator error.
export const CHARS_PER_TOKEN = 3;

// The model's input-token limit (gpt-5, as reported by the 400 error that
// motivated mt#2243). The budget below is derived from it.
export const MODEL_INPUT_TOKEN_LIMIT = 272_000;

// Tokens reserved for everything in the prompt that is NOT the chunk diff: the
// system Critic Constitution, task spec, prior reviews, review threads, AND the
// model's completion/reasoning budget. The diff budget is the limit minus this
// reserve, so even at a full diff budget the assembled prompt stays under the
// limit unless the non-diff overhead itself exceeds the reserve. Deliberately
// generous (172k) — the same reserve protects BOTH single-pass and chunked
// mode (see shouldChunkReview), since both carry this overhead.
export const PROMPT_OVERHEAD_TOKEN_RESERVE = 172_000;

// Per-chunk diff token budget = limit - overhead reserve. An earlier chunk that
// fit on PR #1478 was ~112k tokens total; this caps the variable (diff) portion
// at 100k, leaving 172k for the fixed overhead + completion.
export const MAX_CHUNK_DIFF_TOKENS = MODEL_INPUT_TOKEN_LIMIT - PROMPT_OVERHEAD_TOKEN_RESERVE;

// Per-file truncation cap (tokens). A single file contributes at most this much
// to a chunk, so one oversized minified/vendored file (e.g. a 258 kB bundle
// chunk) can never overflow a chunk on its own. Half the chunk budget so two
// capped files still fit together.
export const MAX_FILE_PATCH_TOKENS = 50_000;
export const MAX_FILE_PATCH_CHARS = MAX_FILE_PATCH_TOKENS * CHARS_PER_TOKEN;

// Fallback average chars-per-changed-line when GitHub omits the patch (files
// >1MB or binary): estimate the size from the additions+deletions counts.
const AVG_DIFF_LINE_CHARS = 50;

export interface ChunkInfo {
  index: number;
  totalChunks: number;
  files: PrFileEntry[];
}

function estimateTokensFromChars(charCount: number): number {
  return Math.ceil(charCount / CHARS_PER_TOKEN);
}

/**
 * Uncapped estimate of the diff-text size (in chars) a file contributes.
 * Uses the patch length when present, else estimates from changed-line counts.
 */
function rawFileChars(file: PrFileEntry): number {
  if (file.patch !== undefined) return file.patch.length;
  return (file.additions + file.deletions) * AVG_DIFF_LINE_CHARS;
}

/**
 * Estimated tokens a file contributes to a CHUNK — capped at the per-file
 * truncation limit, because buildChunkDiff truncates any single patch to
 * MAX_FILE_PATCH_CHARS. Used for size-aware chunk packing.
 */
function estimateChunkFileTokens(file: PrFileEntry): number {
  return estimateTokensFromChars(Math.min(rawFileChars(file), MAX_FILE_PATCH_CHARS));
}

/**
 * Determine whether a PR should be reviewed in chunked mode.
 *
 * Chunks on file count, line count, total diff tokens, OR any single file
 * exceeding the per-file cap. The token gate (mt#2243) closes the
 * minified-single-line gap: line count is blind to a 258 kB one-line vendored
 * bundle (~1 "line" but tens of thousands of tokens), which would overflow a
 * single-pass prompt.
 *
 * Two single-pass-overflow guards, both using UNCAPPED estimates (single-pass
 * review sends the full diff verbatim — it does NOT truncate):
 *   - total diff tokens > MAX_CHUNK_DIFF_TOKENS — the whole diff is too big.
 *   - any single file > MAX_FILE_PATCH_TOKENS — only the chunked path truncates
 *     per file, so a single oversized file must route to chunked mode to be
 *     capped; otherwise single-pass would send it whole.
 * Together these guarantee single-pass runs only when the full diff is no
 * larger than a single chunk would be, and the PROMPT_OVERHEAD_TOKEN_RESERVE
 * (subtracted into MAX_CHUNK_DIFF_TOKENS) covers the non-diff prompt overhead
 * that single-pass also carries.
 */
export function shouldChunkReview(fileEntries: PrFileEntry[], totalDiffLines: number): boolean {
  if (
    fileEntries.length > CHUNKED_REVIEW_FILE_THRESHOLD ||
    totalDiffLines > CHUNKED_REVIEW_LINE_THRESHOLD
  ) {
    return true;
  }
  const anyFileExceedsCap = fileEntries.some(
    (f) => estimateTokensFromChars(rawFileChars(f)) > MAX_FILE_PATCH_TOKENS
  );
  if (anyFileExceedsCap) return true;
  const estimatedTotalTokens = fileEntries.reduce(
    (sum, f) => sum + estimateTokensFromChars(rawFileChars(f)),
    0
  );
  return estimatedTotalTokens > MAX_CHUNK_DIFF_TOKENS;
}

/**
 * Group files into chunks bounded by BOTH file count (<= FILES_PER_CHUNK) and
 * cumulative estimated diff tokens (<= MAX_CHUNK_DIFF_TOKENS). Greedy packing:
 * a file is added to the current chunk unless doing so would exceed either
 * bound, in which case a new chunk is started. A single file always lands in a
 * chunk (its capped estimate <= MAX_FILE_PATCH_TOKENS < MAX_CHUNK_DIFF_TOKENS,
 * so it fits in a fresh chunk), and buildChunkDiff truncates its patch.
 *
 * Packing is order-dependent (greedy, single pass) — this is intentional: it
 * preserves GitHub's stable file ordering so adjacent files (often in the same
 * directory) tend to land in the same chunk, which gives the reviewer better
 * local context than a bin-packing reorder would. Correctness (every chunk
 * under budget) holds regardless of order.
 */
export function chunkFiles(fileEntries: PrFileEntry[]): ChunkInfo[] {
  const groups: PrFileEntry[][] = [];
  let current: PrFileEntry[] = [];
  let currentTokens = 0;

  for (const file of fileEntries) {
    const fileTokens = estimateChunkFileTokens(file);
    const exceedsTokens = currentTokens + fileTokens > MAX_CHUNK_DIFF_TOKENS;
    const exceedsCount = current.length >= FILES_PER_CHUNK;
    if (current.length > 0 && (exceedsTokens || exceedsCount)) {
      groups.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(file);
    currentTokens += fileTokens;
  }
  if (current.length > 0) groups.push(current);

  const totalChunks = groups.length;
  return groups.map((files, index) => ({ index, totalChunks, files }));
}

/**
 * Build the diff section for a single chunk using per-file patches.
 * Falls back to extracting from the full diff when a file's patch is
 * missing (GitHub omits patch for files >1MB).
 */
export function buildChunkDiff(chunk: ChunkInfo, fullDiff: string): string {
  const sections: string[] = [];
  let parsedFullDiff: ReturnType<typeof parseUnifiedDiff> | null = null;

  for (const file of chunk.files) {
    const header = `### ${file.filename} (${file.status}, +${file.additions} -${file.deletions})`;

    if (file.patch) {
      sections.push(`${header}\n\`\`\`diff\n${capDiffText(file.patch, file)}\n\`\`\``);
      continue;
    }

    // Fallback: extract from full diff
    if (!parsedFullDiff) {
      parsedFullDiff = parseUnifiedDiff(fullDiff);
    }
    const diffFile = parsedFullDiff.find(
      (df) =>
        df.path === file.filename ||
        df.oldPath === file.filename ||
        (file.previousFilename && df.oldPath === file.previousFilename)
    );
    if (diffFile) {
      if (diffFile.hunks.length === 0 && file.status === "renamed") {
        sections.push(`${header}\n(Rename only — no content changes.)`);
      } else {
        const reconstructed = reconstructFileDiff(diffFile);
        sections.push(`${header}\n\`\`\`diff\n${capDiffText(reconstructed, file)}\n\`\`\``);
      }
      continue;
    }

    // Ultimate fallback: note the file for tool-based review
    sections.push(
      `${header}\n(Patch unavailable from GitHub API. ` +
        `Use \`read_file\` to inspect this file at HEAD.)`
    );
  }

  return sections.join("\n\n");
}

/**
 * Truncate a single file's diff text to MAX_FILE_PATCH_CHARS (mt#2243), so one
 * oversized minified/vendored patch cannot overflow the chunk's token budget.
 * Appends a marker pointing the model at read_file for the full content. The
 * head of a diff is the most informative slice, so we keep the prefix.
 */
function capDiffText(text: string, file: PrFileEntry): string {
  if (text.length <= MAX_FILE_PATCH_CHARS) return text;
  // Surrogate-pair-safe head truncation (mt#1615): a raw .slice could sever a
  // UTF-16 surrogate pair in patch content (e.g. an emoji in source), leaving a
  // lone surrogate that breaks downstream JSON round-trips.
  const head = safeTruncate(text, MAX_FILE_PATCH_CHARS, "head");
  return (
    `${head}\n` +
    `... [diff truncated at ${MAX_FILE_PATCH_CHARS} chars ` +
    `(${file.additions + file.deletions} changed lines total); ` +
    `use \`read_file\` to inspect the full file at HEAD]`
  );
}

/**
 * Reconstruct a unified diff string from a parsed DiffFile.
 */
function reconstructFileDiff(diffFile: ReturnType<typeof parseUnifiedDiff>[number]): string {
  const lines: string[] = [`--- a/${diffFile.oldPath ?? diffFile.path}`, `+++ b/${diffFile.path}`];

  for (const hunk of diffFile.hunks) {
    lines.push(hunk.header);
    for (const line of hunk.lines) {
      const prefix = line.side === "RIGHT" ? "+" : line.side === "LEFT" ? "-" : " ";
      lines.push(`${prefix}${line.content}`);
    }
  }

  return lines.join("\n");
}

/**
 * Build a per-chunk user prompt. Same structure as buildReviewPrompt but
 * with the chunk's file diffs instead of the full PR diff.
 */
export function buildChunkedReviewPrompt(
  baseInput: Omit<ReviewPromptInput, "diff">,
  chunk: ChunkInfo,
  chunkDiff: string
): string {
  const tierLine =
    baseInput.authorshipTier !== null ? `Tier: ${baseInput.authorshipTier}` : `Tier: unknown`;

  const specSection = baseInput.taskSpec
    ? `## Task Specification\n\n${baseInput.taskSpec}`
    : `## Task Specification\n\n(No task spec found.)`;

  // Migration/move baseline-awareness pre-check (mt#2655). Chunked reviews
  // are exactly where the originating incident (mt#2304's #1812) occurred —
  // each chunk only sees its own files' deletion/addition hunks, so every
  // chunk needs this instruction independently, not just the single-pass path.
  const migrationBaselineSection = buildMigrationBaselineSection(
    baseInput.prBody,
    baseInput.taskSpec
  );
  const migrationBaselineBlock = migrationBaselineSection ? `\n\n${migrationBaselineSection}` : "";

  // Out-of-repo references pre-check: same parity argument as the migration
  // baseline above — each chunk reviews independently, so the "no filesystem
  // access to verify these paths" instruction must reach every chunk, not
  // just the single-pass path.
  const outOfRepoSection = buildOutOfRepoSection(baseInput.prBody, baseInput.taskSpec);
  const outOfRepoBlock = outOfRepoSection ? `\n\n${outOfRepoSection}` : "";

  const priorReviewsSection =
    baseInput.priorReviews && baseInput.priorReviews.trim() ? `\n\n${baseInput.priorReviews}` : "";

  const reviewThreadsSection =
    baseInput.reviewThreads && baseInput.reviewThreads.length > 0
      ? `\n\n${buildReviewThreadsSection(baseInput.reviewThreads)}`
      : "";

  const fileList = chunk.files.map((f) => `- ${f.filename}`).join("\n");

  return `# PR Review Request (Chunk ${chunk.index + 1}/${chunk.totalChunks})

## PR Metadata

- Number: #${baseInput.prNumber}
- Title: ${baseInput.prTitle}
- Branch: ${baseInput.branchName} → ${baseInput.baseBranch}
- ${tierLine}
- **Review scope:** This is chunk ${chunk.index + 1} of ${chunk.totalChunks}. Review ONLY the files listed below.

## Files in this chunk

${fileList}

## PR Description

${baseInput.prBody || "(empty)"}

${specSection}${outOfRepoBlock}${migrationBaselineBlock}${priorReviewsSection}${reviewThreadsSection}

## Diff (chunk ${chunk.index + 1}/${chunk.totalChunks})

${chunkDiff}

---

Review the files in this chunk per the Critic Constitution. Focus on the files listed above — other files are reviewed in separate chunks.`;
}

/**
 * Inputs for {@link runChunkedReview}. All pre-computed by the caller
 * (`runReviewBody`) so this stays a pure orchestrator over the chunk math +
 * the per-chunk model call.
 */
export interface RunChunkedReviewInput {
  config: ReviewerConfig;
  systemPrompt: string;
  /** Single-pass user prompt, used only on the empty-file-list fallback path. */
  userPrompt: string;
  /** Prompt input WITHOUT the diff — buildChunkedReviewPrompt adds each chunk's diff. */
  basePromptInput: Omit<ReviewPromptInput, "diff">;
  /** Tool context, already gated by the caller (`toolsActive ? toolContext : undefined`). */
  tools?: ReviewerToolContext;
  outputToolsActive: boolean;
  fileEntries: PrFileEntry[];
  /** Full PR diff, sliced per-chunk by buildChunkDiff. */
  diff: string;
  owner: string;
  repo: string;
  prNumber: number;
  totalDiffLines: number;
  /**
   * Test seam (mt#2739): injectable provider call. Defaults to the real
   * `callReviewer` from `./providers`, so production callers (`runReviewBody`)
   * are unaffected. Mirrors `callReviewerWithRetry`'s `callReviewerFn` seam.
   */
  callReviewerFn?: CallReviewerFn;
}

/**
 * Run a chunked review (mt#2120): split the PR's files into chunks, review each
 * chunk in its own model call, and aggregate the per-chunk tool calls + usage +
 * timing into one ReviewOutput. Falls back to a single-pass call when the file
 * list is empty (chunkFiles returns []). Returns the same shape as
 * callReviewerWithRetry so the caller's post-model-call flow is unchanged.
 *
 * Extracted verbatim from runReviewBody (mt#2731); behavior-preserving.
 */
export async function runChunkedReview(input: RunChunkedReviewInput): Promise<CallWithRetryResult> {
  const {
    config,
    systemPrompt,
    userPrompt,
    basePromptInput,
    tools,
    outputToolsActive,
    fileEntries,
    diff,
    owner,
    repo,
    prNumber,
    totalDiffLines,
    callReviewerFn = callReviewer,
  } = input;

  const chunks = chunkFiles(fileEntries);

  // Fallback: if fileEntries was empty (listFiles error/cap) but diff
  // was large, chunks is []. Fall through to single-pass rather than
  // hard-failing with a skip notice.
  if (chunks.length === 0) {
    log.info("reviewer.chunked_review_fallback_single_pass", {
      event: "reviewer.chunked_review_fallback_single_pass",
      owner,
      repo,
      pr: prNumber,
      reason: "zero_chunks_from_empty_file_entries",
      totalDiffLines,
    });
    return callReviewerWithRetry(
      config,
      systemPrompt,
      userPrompt,
      tools,
      callReviewerFn,
      outputToolsActive
    );
  }

  log.info("reviewer.chunked_review_start", {
    event: "reviewer.chunked_review_start",
    owner,
    repo,
    pr: prNumber,
    totalFiles: fileEntries.length,
    totalDiffLines,
    chunkCount: chunks.length,
    filesPerChunk: chunks.map((c) => c.files.length),
  });

  const allToolCalls: ReviewOutput["toolCalls"] = [];
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalReasoningTokens = 0;
  // mt#2739: accumulate every non-empty chunk's free-text scratch (output.text),
  // not just the last chunk's. This aggregate feeds only the defensive CoT-leak
  // scratch logging (review-worker.ts:960, sanitizeReviewBody(output.text)) — the
  // posted body is composed from tool calls, not this field — so concatenating all
  // chunks lets the sanitizer inspect every chunk's scratch, closing the gap where
  // leaked reasoning in a non-final chunk went undetected.
  const chunkTexts: string[] = [];
  const allRoundLatencies: number[] = [];
  let totalTimeoutCount = 0;
  const allRetryOutcomes: string[] = [];

  for (const chunk of chunks) {
    const chunkDiff = buildChunkDiff(chunk, diff);
    const chunkPrompt = buildChunkedReviewPrompt(basePromptInput, chunk, chunkDiff);

    const chunkResult = await callReviewerWithRetry(
      config,
      systemPrompt,
      chunkPrompt,
      tools,
      callReviewerFn,
      outputToolsActive
    );

    allToolCalls.push(...chunkResult.output.toolCalls);
    totalPromptTokens += chunkResult.output.usage?.promptTokens ?? 0;
    totalCompletionTokens += chunkResult.output.usage?.completionTokens ?? 0;
    totalReasoningTokens += chunkResult.output.usage?.reasoningTokens ?? 0;
    // Trim each chunk's scratch before collecting (mt#2739, PR #1884 R1): skips
    // whitespace-only chunks (which would inject leading/dangling separators) and
    // prevents a chunk's trailing blank lines + the next chunk's leading blank
    // lines from combining into a spurious blank-line run at the "\n\n" join.
    // Internal blank-line runs WITHIN a chunk (the actual leak signal) are kept.
    const chunkText = chunkResult.output.text.trim();
    if (chunkText) chunkTexts.push(chunkText);

    if (chunkResult.output.timing) {
      allRoundLatencies.push(...chunkResult.output.timing.roundLatenciesMs);
      totalTimeoutCount += chunkResult.output.timing.timeoutCount;
      allRetryOutcomes.push(...chunkResult.output.timing.retryOutcomes);
    }

    log.info("reviewer.chunked_review_chunk_complete", {
      event: "reviewer.chunked_review_chunk_complete",
      owner,
      repo,
      pr: prNumber,
      chunkIndex: chunk.index,
      totalChunks: chunk.totalChunks,
      toolCalls: chunkResult.output.toolCalls.length,
      promptTokens: chunkResult.output.usage?.promptTokens ?? 0,
    });
  }

  const totalTokens = totalPromptTokens + totalCompletionTokens;
  const output: ReviewOutput = {
    text: chunkTexts.join("\n\n"),
    tokensUsed: totalTokens,
    usage: {
      promptTokens: totalPromptTokens,
      completionTokens: totalCompletionTokens,
      reasoningTokens: totalReasoningTokens,
      totalTokens,
    },
    provider: config.provider,
    model: config.providerModel,
    toolCalls: allToolCalls,
    timing: {
      roundLatenciesMs: allRoundLatencies,
      timeoutCount: totalTimeoutCount,
      retryOutcomes: allRetryOutcomes,
    },
  };
  return {
    output,
    validation: validateReviewOutput(output, outputToolsActive),
    attempt: "first-attempt-success",
    retryAttempted: false,
  };
}
