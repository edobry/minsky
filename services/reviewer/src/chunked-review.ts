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
import { buildReviewThreadsSection } from "./prompt";
import { parseUnifiedDiff } from "@minsky/domain/utils/parse-diff";
import { safeTruncate } from "@minsky/shared/safe-truncate";

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

// Per-chunk diff token budget. Sized well under the model input limit to leave
// room for the system prompt (Critic Constitution), task spec, prior reviews,
// review threads, and the completion. An earlier chunk that fit on PR #1478 was
// ~112k tokens total; this caps the variable (diff) portion at 100k.
export const MAX_CHUNK_DIFF_TOKENS = 100_000;

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
 * Chunks on file count, line count, OR estimated total diff tokens. The
 * token gate (mt#2243) closes the minified-single-line gap: line count is
 * blind to a 258 kB one-line vendored bundle (~1 "line" but tens of thousands
 * of tokens), which would overflow a single-pass prompt. The token estimate
 * here is UNCAPPED (single-pass review does not truncate), so a large-byte
 * diff forces chunked mode where per-file truncation applies.
 */
export function shouldChunkReview(fileEntries: PrFileEntry[], totalDiffLines: number): boolean {
  if (
    fileEntries.length > CHUNKED_REVIEW_FILE_THRESHOLD ||
    totalDiffLines > CHUNKED_REVIEW_LINE_THRESHOLD
  ) {
    return true;
  }
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

${specSection}${priorReviewsSection}${reviewThreadsSection}

## Diff (chunk ${chunk.index + 1}/${chunk.totalChunks})

${chunkDiff}

---

Review the files in this chunk per the Critic Constitution. Focus on the files listed above — other files are reviewed in separate chunks.`;
}
