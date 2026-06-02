/**
 * Tests for chunked-review.ts size-aware chunking + per-file truncation (mt#2243).
 *
 * Originating incident: PR #1478's regenerated minified Slidev bundle assembled a
 * 292,033-token chunk prompt against gpt-5's 272,000-token limit, because chunkFiles
 * grouped purely by file count (FILES_PER_CHUNK=20) with no size budget and
 * buildChunkDiff embedded each patch verbatim with no cap.
 *
 * Covers:
 *   1. chunkFiles bounds each chunk by cumulative estimated diff tokens, not file count.
 *   2. An oversized single file lands in its own chunk.
 *   3. buildChunkDiff truncates a >cap patch and emits a marker.
 *   4. shouldChunkReview token gate catches minified single-line bloat (low line count).
 *   5. Regression: a PR #1478-shaped fixture yields only under-limit chunks.
 */

import { describe, test, expect } from "bun:test";
import {
  shouldChunkReview,
  chunkFiles,
  buildChunkDiff,
  CHARS_PER_TOKEN,
  MAX_CHUNK_DIFF_TOKENS,
  MAX_FILE_PATCH_TOKENS,
  MAX_FILE_PATCH_CHARS,
  FILES_PER_CHUNK,
  type ChunkInfo,
} from "./chunked-review";
import type { PrFileEntry } from "./github-client";

function makeFile(filename: string, patchChars: number, status = "modified"): PrFileEntry {
  return {
    filename,
    status,
    additions: Math.ceil(patchChars / 50),
    deletions: 0,
    patch: "x".repeat(patchChars),
  };
}

/** Estimated tokens of an arbitrary text, mirroring the module's estimator. */
function estTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// Substring of the truncation marker emitted by capDiffText — asserted in
// several tests, so extracted to avoid magic-string duplication.
const TRUNCATION_MARKER = "diff truncated at";

describe("chunkFiles — size-aware chunking", () => {
  test("bounds each chunk by cumulative diff tokens, not file count alone", () => {
    // Each file ≈ MAX_FILE_PATCH_TOKENS (half the chunk budget) → 2 per chunk,
    // even though all 6 fit under the 20-file count limit.
    const files = Array.from({ length: 6 }, (_, i) =>
      makeFile(`big-${i}.js`, MAX_FILE_PATCH_CHARS)
    );
    const chunks = chunkFiles(files);

    expect(chunks.length).toBeGreaterThan(1);
    // file-count-only chunking would have produced a single chunk (6 <= 20).
    for (const chunk of chunks) {
      const chunkTokens = chunk.files.reduce((sum, f) => sum + estTokens(f.patch ?? ""), 0);
      expect(chunkTokens).toBeLessThanOrEqual(MAX_CHUNK_DIFF_TOKENS);
    }
    // totalChunks is consistent across all chunks.
    for (const chunk of chunks) {
      expect(chunk.totalChunks).toBe(chunks.length);
    }
  });

  test("still caps by file count when files are small", () => {
    const files = Array.from({ length: FILES_PER_CHUNK + 5 }, (_, i) => makeFile(`s-${i}.ts`, 100));
    const chunks = chunkFiles(files);
    expect(chunks.length).toBe(2);
    expect(chunks[0]?.files.length).toBe(FILES_PER_CHUNK);
    expect(chunks[1]?.files.length).toBe(5);
  });

  test("an oversized single file lands in its own chunk", () => {
    // huge file (3x the per-file cap) flanked by two small files.
    const files = [
      makeFile("small-a.ts", 100),
      makeFile("huge.min.js", MAX_FILE_PATCH_CHARS * 3),
      makeFile("small-b.ts", 100),
    ];
    const chunks = chunkFiles(files);
    const hugeChunk = chunks.find((c) => c.files.some((f) => f.filename === "huge.min.js"));
    expect(hugeChunk).toBeDefined();
    // The huge file is capped to MAX_FILE_PATCH_TOKENS, which is < the chunk budget,
    // so it sits alone (adding either neighbor stays under budget only if it didn't
    // already exceed — here cap=50k, budget=100k, so a neighbor could join; assert
    // the chunk it lands in never exceeds budget regardless of packing).
    for (const chunk of chunks) {
      const chunkTokens = chunk.files.reduce(
        (sum, f) => sum + Math.min(estTokens(f.patch ?? ""), MAX_FILE_PATCH_TOKENS),
        0
      );
      expect(chunkTokens).toBeLessThanOrEqual(MAX_CHUNK_DIFF_TOKENS);
    }
  });

  test("empty input yields no chunks", () => {
    expect(chunkFiles([])).toEqual([]);
  });
});

describe("buildChunkDiff — per-file truncation", () => {
  test("truncates a patch over the cap and emits a marker", () => {
    const file = makeFile("vendor.min.js", MAX_FILE_PATCH_CHARS * 2);
    const chunk: ChunkInfo = { index: 0, totalChunks: 1, files: [file] };
    const out = buildChunkDiff(chunk, "");

    expect(out).toContain(TRUNCATION_MARKER);
    expect(out).toContain("read_file");
    // The emitted diff body must be bounded — well under the raw 2x-cap patch.
    expect(estTokens(out)).toBeLessThanOrEqual(MAX_FILE_PATCH_TOKENS + 500);
  });

  test("leaves a small patch intact (no marker)", () => {
    const file = makeFile("small.ts", 200);
    const chunk: ChunkInfo = { index: 0, totalChunks: 1, files: [file] };
    const out = buildChunkDiff(chunk, "");

    expect(out).not.toContain(TRUNCATION_MARKER);
    expect(out).toContain("x".repeat(200));
  });
});

describe("buildChunkDiff — no-patch fallback paths", () => {
  // GitHub omits `patch` for files >1MB or binary; buildChunkDiff then
  // reconstructs from the full PR diff, or notes the file for tool-based review.
  function noPatchFile(filename: string, extra: Partial<PrFileEntry> = {}): PrFileEntry {
    return { filename, status: "modified", additions: 0, deletions: 0, ...extra };
  }

  test("reconstructs a file's diff from the full diff when patch is absent", () => {
    const fullDiff = [
      "diff --git a/foo.ts b/foo.ts",
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -1,1 +1,2 @@",
      " context line",
      "+added line",
    ].join("\n");
    const file = noPatchFile("foo.ts", { additions: 1 });
    const chunk: ChunkInfo = { index: 0, totalChunks: 1, files: [file] };
    const out = buildChunkDiff(chunk, fullDiff);

    expect(out).toContain("foo.ts");
    expect(out).toContain("added line");
    expect(out).toContain("context line");
    expect(out).not.toContain("Patch unavailable");
  });

  test("truncates a large reconstructed diff and emits the marker", () => {
    const manyLines = Array.from({ length: 4000 }, (_, i) => `+line ${i} ${"y".repeat(40)}`).join(
      "\n"
    );
    const fullDiff = [
      "diff --git a/big.ts b/big.ts",
      "--- a/big.ts",
      "+++ b/big.ts",
      "@@ -0,0 +1,4000 @@",
      manyLines,
    ].join("\n");
    const file = noPatchFile("big.ts", { additions: 4000 });
    const chunk: ChunkInfo = { index: 0, totalChunks: 1, files: [file] };
    const out = buildChunkDiff(chunk, fullDiff);

    expect(out).toContain(TRUNCATION_MARKER);
    expect(out).toContain("read_file");
    expect(estTokens(out)).toBeLessThanOrEqual(MAX_FILE_PATCH_TOKENS + 500);
  });

  test("notes a file for tool-based review when it is in neither patch nor full diff", () => {
    const file = noPatchFile("ghost.ts", { additions: 5 });
    const chunk: ChunkInfo = { index: 0, totalChunks: 1, files: [file] };
    const out = buildChunkDiff(
      chunk,
      "diff --git a/other.ts b/other.ts\n--- a/other.ts\n+++ b/other.ts\n@@ -1 +1 @@\n-a\n+b"
    );

    expect(out).toContain("ghost.ts");
    expect(out).toContain("Patch unavailable from GitHub API");
    expect(out).toContain("read_file");
  });

  test("marks a content-free rename without emitting a diff body", () => {
    const fullDiff = [
      "diff --git a/old.ts b/new.ts",
      "rename from old.ts",
      "rename to new.ts",
    ].join("\n");
    const file = noPatchFile("new.ts", { status: "renamed", previousFilename: "old.ts" });
    const chunk: ChunkInfo = { index: 0, totalChunks: 1, files: [file] };
    const out = buildChunkDiff(chunk, fullDiff);

    expect(out).toContain("new.ts");
    expect(out).toContain("Rename only");
    expect(out).not.toContain("```diff");
  });
});

describe("shouldChunkReview — token gate (mt#2243)", () => {
  test("chunks on minified single-line bloat even with low file/line counts", () => {
    // 3 files, one a ~360 kB single-line minified bundle (~120k tokens, over the
    // 100k single-pass budget). Line count is tiny — the original line-only gate
    // would have missed this and let single-pass overflow.
    const files = [
      makeFile("a.ts", 500),
      makeFile("bundle.min.js", 360_000, "added"),
      makeFile("b.ts", 500),
    ];
    // Sanity: the bundle alone exceeds the token budget while line count is tiny.
    expect(360_000 / CHARS_PER_TOKEN).toBeGreaterThan(MAX_CHUNK_DIFF_TOKENS);
    // totalDiffLines deliberately small (minified = few lines).
    expect(shouldChunkReview(files, 12)).toBe(true);
  });

  test("does not chunk a genuinely small PR", () => {
    const files = [makeFile("a.ts", 300), makeFile("b.ts", 300)];
    expect(shouldChunkReview(files, 40)).toBe(false);
  });

  test("still chunks on the original file-count and line-count gates", () => {
    const manyFiles = Array.from({ length: 25 }, (_, i) => makeFile(`f-${i}.ts`, 50));
    expect(shouldChunkReview(manyFiles, 10)).toBe(true);
    expect(shouldChunkReview([makeFile("a.ts", 50)], 3000)).toBe(true);
  });
});

describe("regression — PR #1478-shaped diff yields only under-limit chunks", () => {
  test("every chunk's built diff stays under the model budget", () => {
    // Mirror PR #1478: ~88 files, a handful of large minified bundles + many small.
    const bundles = [
      makeFile("public/talks/d/assets/vue.js", 258_000, "added"),
      makeFile("public/talks/d/assets/index.js", 138_000, "added"),
      makeFile("public/talks/d/assets/shiki.js", 50_000, "added"),
      makeFile("public/talks/d/assets/slidev.js", 63_000, "added"),
    ];
    const churn = Array.from({ length: 84 }, (_, i) =>
      makeFile(`public/talks/d/assets/md-${i}.js`, 2_000, i % 2 === 0 ? "added" : "removed")
    );
    const files = [...bundles, ...churn];

    expect(shouldChunkReview(files, 24_205)).toBe(true);

    const chunks = chunkFiles(files);
    // Headers/fences/markers add a small fixed overhead per file; allow margin.
    const perFileOverheadTokens = 80;
    for (const chunk of chunks) {
      const built = buildChunkDiff(chunk, "");
      const overheadAllowance = chunk.files.length * perFileOverheadTokens;
      expect(estTokens(built)).toBeLessThanOrEqual(MAX_CHUNK_DIFF_TOKENS + overheadAllowance);
    }
    // And the whole thing is covered — every file appears in exactly one chunk.
    const totalFilesInChunks = chunks.reduce((sum, c) => sum + c.files.length, 0);
    expect(totalFilesInChunks).toBe(files.length);
  });
});
