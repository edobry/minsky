/**
 * Chunked review orchestration for large PRs (mt#2120).
 *
 * When a PR's total diff exceeds the size gate, files are grouped into
 * chunks of ~20-25 and each chunk gets a separate model call with only
 * its files' patches in the prompt. Findings are aggregated across
 * chunks before composition.
 */

import type { PrFileEntry } from "./github-client";
import type { ReviewPromptInput } from "./prompt";
import { parseUnifiedDiff } from "@minsky/domain/utils/parse-diff";

export const CHUNKED_REVIEW_FILE_THRESHOLD = 20;
export const CHUNKED_REVIEW_LINE_THRESHOLD = 2000;
export const FILES_PER_CHUNK = 20;

export interface ChunkInfo {
  index: number;
  totalChunks: number;
  files: PrFileEntry[];
}

/**
 * Determine whether a PR should be reviewed in chunked mode.
 */
export function shouldChunkReview(fileEntries: PrFileEntry[], totalDiffLines: number): boolean {
  return (
    fileEntries.length > CHUNKED_REVIEW_FILE_THRESHOLD ||
    totalDiffLines > CHUNKED_REVIEW_LINE_THRESHOLD
  );
}

/**
 * Group files into chunks of ~FILES_PER_CHUNK.
 */
export function chunkFiles(fileEntries: PrFileEntry[]): ChunkInfo[] {
  const chunks: ChunkInfo[] = [];
  const totalChunks = Math.ceil(fileEntries.length / FILES_PER_CHUNK);

  for (let i = 0; i < fileEntries.length; i += FILES_PER_CHUNK) {
    chunks.push({
      index: chunks.length,
      totalChunks,
      files: fileEntries.slice(i, i + FILES_PER_CHUNK),
    });
  }

  return chunks;
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
      sections.push(`${header}\n\`\`\`diff\n${file.patch}\n\`\`\``);
      continue;
    }

    // Fallback: extract from full diff
    if (!parsedFullDiff) {
      parsedFullDiff = parseUnifiedDiff(fullDiff);
    }
    const diffFile = parsedFullDiff.find(
      (df) => df.path === file.filename || df.oldPath === file.filename
    );
    if (diffFile) {
      const reconstructed = reconstructFileDiff(diffFile);
      sections.push(`${header}\n\`\`\`diff\n${reconstructed}\n\`\`\``);
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

${specSection}${priorReviewsSection}

## Diff (chunk ${chunk.index + 1}/${chunk.totalChunks})

${chunkDiff}

---

Review the files in this chunk per the Critic Constitution. Focus on the files listed above — other files are reviewed in separate chunks.`;
}
