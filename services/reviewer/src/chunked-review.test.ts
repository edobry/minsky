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
  buildChunkedReviewPrompt,
  runChunkedReview,
  CHARS_PER_TOKEN,
  MAX_CHUNK_DIFF_TOKENS,
  MAX_FILE_PATCH_TOKENS,
  MAX_FILE_PATCH_CHARS,
  FILES_PER_CHUNK,
  capSinglePassDiff,
  MAX_SINGLE_PASS_DIFF_CHARS,
  type ChunkInfo,
} from "./chunked-review";
import type { PrFileEntry } from "./github-client";
import type { ReviewPromptInput } from "./prompt";
import type { ReviewOutput, ReviewUsage } from "./providers";
import { timingTokenFields } from "./token-cost";
import type { CallReviewerFn } from "./review-output-validation";
import type { ReviewerConfig } from "./config";

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

/** Sum of the per-file patch lengths — what `promptDiff.length` approximates. */
function totalChars(files: PrFileEntry[]): number {
  return files.reduce((sum, f) => sum + (f.patch?.length ?? 0), 0);
}

/**
 * A file whose `patch` GitHub withheld while still reporting changed lines —
 * i.e. a text file over 1MB. This is the shape mt#4879 turns on.
 */
function omittedPatchFile(filename: string, changedLines: number): PrFileEntry {
  return { filename, status: "modified", additions: changedLines, deletions: 0 };
}

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
    expect(shouldChunkReview(files, 12, totalChars(files))).toBe(true);
  });

  test("does not chunk a genuinely small PR", () => {
    const files = [makeFile("a.ts", 300), makeFile("b.ts", 300)];
    expect(shouldChunkReview(files, 40, totalChars(files))).toBe(false);
  });

  test("still chunks on the original file-count and line-count gates", () => {
    const manyFiles = Array.from({ length: 25 }, (_, i) => makeFile(`f-${i}.ts`, 50));
    expect(shouldChunkReview(manyFiles, 10, totalChars(manyFiles))).toBe(true);
    const one = [makeFile("a.ts", 50)];
    expect(shouldChunkReview(one, 3000, totalChars(one))).toBe(true);
  });

  test("per-file cap still fires when the TOTAL is under budget (mt#2243 gate, isolated)", () => {
    // One 200 kB file among small ones: total ~67k tokens is UNDER the 100k
    // budget, so the whole-diff guard does not fire — only the per-file cap
    // (200k/3 ≈ 66.7k > 50k) routes this to chunked mode, where it gets
    // truncated. Isolates mt#2243's guard from mt#4879's whole-diff guard.
    const files = [makeFile("a.ts", 500), makeFile("big.json", 200_000), makeFile("b.ts", 500)];
    const chars = totalChars(files);
    expect(Math.ceil(chars / CHARS_PER_TOKEN)).toBeLessThan(MAX_CHUNK_DIFF_TOKENS);
    expect(Math.ceil(200_000 / CHARS_PER_TOKEN)).toBeGreaterThan(MAX_FILE_PATCH_TOKENS);
    expect(shouldChunkReview(files, 40, chars)).toBe(true);
  });
});

describe("shouldChunkReview — whole-diff payload gate (mt#4879)", () => {
  test("chunks a few-lines/many-megabytes diff whose per-file patches GitHub withheld", () => {
    // peezombie.me PR #2's exact shape: ~10 files; the one carrying the volume
    // replaced a single 4,216,869-character JSON line, so GitHub omitted its
    // `patch` (>1MB) and the newline count stayed tiny. Every DERIVED input
    // reads small; only the payload measurement sees 4.2MB.
    const huge = omittedPatchFile("site/index.html", 1_000);
    const files = [huge, ...Array.from({ length: 9 }, (_, i) => makeFile(`f-${i}.ts`, 300))];
    const promptDiffChars = 4_216_869;

    // The derived inputs are all under their thresholds — this is the premise.
    expect(files.length).toBeLessThanOrEqual(20);
    // Newline count is small because the change is one enormous line.
    const totalDiffLines = 900;
    expect(totalDiffLines).toBeLessThan(2000);

    expect(shouldChunkReview(files, totalDiffLines, promptDiffChars)).toBe(true);
  });

  test("a withheld patch with changed lines is scored over the per-file cap, not at 50 chars/line", () => {
    // The old fallback scored this at 1_000 * 50 = 50k chars ≈ 16.7k tokens,
    // comfortably under the 50k per-file cap. GitHub only withholds a patch
    // above 1MB, so the floor is the honest reading.
    const files = [omittedPatchFile("site/index.html", 1_000)];
    // Passing a SMALL totalDiffChars isolates the per-file scoring: if the fix
    // were only the whole-diff guard, this would return false.
    expect(shouldChunkReview(files, 10, 5_000)).toBe(true);
  });

  test("capSinglePassDiff leaves an under-cap diff byte-identical", () => {
    // The common case must not be perturbed: no marker, no copy, same string.
    const diff = "diff --git a/a.ts b/a.ts\n+one line\n";
    expect(capSinglePassDiff(diff)).toBe(diff);
  });

  test("capSinglePassDiff bounds an over-cap diff and says so in the prompt", () => {
    // SC2's floor under the routing decision: even if the router mis-sizes (or
    // the outputToolsActive conjunct suppresses chunking), the prompt is bounded
    // rather than 400ing. SC4: the truncation must be VISIBLE, because a review
    // that silently saw a prefix is a quiet false-negative.
    const oversized = "x".repeat(MAX_SINGLE_PASS_DIFF_CHARS + 50_000);
    const capped = capSinglePassDiff(oversized);

    expect(capped.length).toBeLessThan(oversized.length);
    expect(capped).toContain("diff truncated at");
    expect(capped).toContain(String(oversized.length));
    // The model is told not to treat the missing tail as absence-evidence.
    expect(capped).toContain("do not report their absence");
  });

  test("capSinglePassDiff's cap matches a single chunk's diff budget", () => {
    // Single-pass carries the same non-diff overhead a chunk does, so it gets
    // the same budget. Pins the relationship rather than the literal.
    expect(MAX_SINGLE_PASS_DIFF_CHARS).toBe(MAX_CHUNK_DIFF_TOKENS * CHARS_PER_TOKEN);
  });

  test("a binary file (no patch, no changed lines) does not force chunking", () => {
    // Binary files also arrive with `patch` omitted, but report 0 additions and
    // 0 deletions and contribute no diff text — flooring them would over-fire
    // chunked review on any PR touching an image.
    const files = [
      { filename: "site/og.png", status: "modified", additions: 0, deletions: 0 },
      makeFile("a.ts", 300),
    ];
    expect(shouldChunkReview(files, 40, totalChars(files))).toBe(false);
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

    expect(shouldChunkReview(files, 24_205, totalChars(files))).toBe(true);

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

// ---------------------------------------------------------------------------
// buildChunkedReviewPrompt — migration baseline awareness wiring (mt#2655 SC2)
//
// Originating incident: the mt#2304 migration PR (#1812) WAS a chunked
// review — each chunk only sees its own files' patches, so the migration-
// baseline instruction has to be injected into every chunk's prompt
// independently (mirroring how buildReviewPrompt injects it for the
// single-pass path), not just the aggregate PR-level prompt.
// ---------------------------------------------------------------------------
describe("buildChunkedReviewPrompt — out-of-repo references section parity (mt#2655)", () => {
  const OUT_OF_REPO_HEADING = "## Out-of-repo references observed";

  const outOfRepoBaseInput: Omit<ReviewPromptInput, "diff"> = {
    prNumber: 1825,
    prTitle: "Reviewer hardening",
    prBody: "",
    taskSpec: null,
    authorshipTier: 3,
    branchName: "task/mt-2655",
    baseBranch: "main",
  };

  const outOfRepoChunk: ChunkInfo = {
    index: 0,
    totalChunks: 2,
    files: [makeFile("services/reviewer/src/prompt.ts", 500)],
  };

  test("injects the out-of-repo section into the chunk prompt when the PR body references an out-of-repo path", () => {
    const prompt = buildChunkedReviewPrompt(
      {
        ...outOfRepoBaseInput,
        prBody: "Grant state is persisted at ~/.local/state/minsky/merge-grants.json for auditing.",
      },
      outOfRepoChunk,
      "some chunk diff"
    );
    expect(prompt).toContain(OUT_OF_REPO_HEADING);
  });

  test("omits the out-of-repo section when nothing references out-of-repo paths", () => {
    const prompt = buildChunkedReviewPrompt(
      { ...outOfRepoBaseInput, prBody: "Plain change, no external paths." },
      outOfRepoChunk,
      "some chunk diff"
    );
    expect(prompt).not.toContain(OUT_OF_REPO_HEADING);
  });
});

describe("buildChunkedReviewPrompt — migration baseline section (mt#2655)", () => {
  const MIGRATION_BASELINE_HEADING = "## Migration / move PR — baseline awareness";

  const baseInput: Omit<ReviewPromptInput, "diff"> = {
    prNumber: 1812,
    prTitle: "Migrate reviewer prompts to new module layout",
    prBody: "",
    taskSpec: null,
    authorshipTier: 3,
    branchName: "task/mt-2304",
    baseBranch: "main",
  };

  const chunk: ChunkInfo = {
    index: 0,
    totalChunks: 2,
    files: [makeFile("services/reviewer/src/prompt.ts", 500)],
  };

  test("injects the migration baseline section into the chunk prompt when the PR body declares a byte-equivalence move", () => {
    const prompt = buildChunkedReviewPrompt(
      { ...baseInput, prBody: "This module was moved verbatim into its new home." },
      chunk,
      "some chunk diff"
    );
    expect(prompt).toContain(MIGRATION_BASELINE_HEADING);
    expect(prompt).toContain("[PRE-EXISTING]");
  });

  test("omits the section when no byte-equivalence claim is present", () => {
    const prompt = buildChunkedReviewPrompt(
      { ...baseInput, prBody: "This PR adds a new feature." },
      chunk,
      "some chunk diff"
    );
    expect(prompt).not.toContain(MIGRATION_BASELINE_HEADING);
  });

  test("section appears between Task Specification and the chunk Diff heading", () => {
    const prompt = buildChunkedReviewPrompt(
      { ...baseInput, prBody: "Content moved verbatim.", taskSpec: "Spec content." },
      chunk,
      "some chunk diff"
    );
    const specIdx = prompt.indexOf("## Task Specification");
    const migrationIdx = prompt.indexOf(MIGRATION_BASELINE_HEADING);
    const diffIdx = prompt.indexOf(`## Diff (chunk ${chunk.index + 1}/${chunk.totalChunks})`);
    expect(specIdx).toBeGreaterThan(-1);
    expect(migrationIdx).toBeGreaterThan(specIdx);
    expect(diffIdx).toBeGreaterThan(migrationIdx);
  });
});

describe("buildChunkedReviewPrompt — referenced task specs section parity (mt#3919)", () => {
  const REFERENCED_SPECS_HEADING = "## Referenced Task Specs";

  const baseInput: Omit<ReviewPromptInput, "diff"> = {
    prNumber: 2761,
    prTitle: "Scope the npm package",
    prBody: "",
    taskSpec: "## Success Criteria\n\n- [ ] mt#3874's spec must be updated.",
    authorshipTier: 3,
    branchName: "task/mt-3915",
    baseBranch: "main",
  };

  const chunk: ChunkInfo = {
    index: 0,
    totalChunks: 2,
    files: [makeFile("package.json", 10)],
  };

  test("injects the referenced-task-specs section when referencedTaskSpecs is populated — a chunked PR gets the same context as the single-pass path", () => {
    const prompt = buildChunkedReviewPrompt(
      {
        ...baseInput,
        referencedTaskSpecs: [
          {
            taskId: "mt#3874",
            content: "## Success Criteria\n\n- [ ] scoped package name.",
            updatedAt: "2026-08-10T17:53:58.889Z",
            fetchResult: { status: "found", taskId: "mt#3874", specLength: 42 },
            truncated: false,
            omittedChars: 0,
          },
        ],
      },
      chunk,
      "some chunk diff"
    );

    expect(prompt).toContain(REFERENCED_SPECS_HEADING);
    expect(prompt).toContain("scoped package name.");
  });

  test("omits the section when referencedTaskSpecs is undefined", () => {
    const prompt = buildChunkedReviewPrompt(baseInput, chunk, "some chunk diff");
    expect(prompt).not.toContain(REFERENCED_SPECS_HEADING);
  });

  test("section appears between Task Specification and the chunk Diff heading", () => {
    const prompt = buildChunkedReviewPrompt(
      {
        ...baseInput,
        referencedTaskSpecs: [
          {
            taskId: "mt#3874",
            content: "content",
            updatedAt: null,
            fetchResult: { status: "found", taskId: "mt#3874", specLength: 7 },
            truncated: false,
            omittedChars: 0,
          },
        ],
      },
      chunk,
      "some chunk diff"
    );
    const specIdx = prompt.indexOf("## Task Specification");
    const referencedIdx = prompt.indexOf(REFERENCED_SPECS_HEADING);
    const diffIdx = prompt.indexOf(`## Diff (chunk ${chunk.index + 1}/${chunk.totalChunks})`);
    expect(specIdx).toBeGreaterThan(-1);
    expect(referencedIdx).toBeGreaterThan(specIdx);
    expect(diffIdx).toBeGreaterThan(referencedIdx);
  });
});

// ---------------------------------------------------------------------------
// runChunkedReview — output.text aggregation across chunks (mt#2739)
//
// The aggregate ReviewOutput.text is the model's free-text scratch channel,
// consumed ONLY by the defensive CoT-leak scratch logging on the output-tools
// path (review-worker.ts:960) — the posted body is composed from tool calls, not
// this field. Before mt#2739, aggregation kept only the LAST non-empty chunk's
// text (`lastText = output.text || lastText`), so leaked reasoning in an EARLIER
// chunk was never inspected. mt#2739 concatenates every non-empty chunk's text
// with a blank-line separator. These tests assert the AGGREGATION output directly
// (all chunks present, single-blank-line separator, empty/whitespace skipped);
// the leak-detection heuristics are covered by sanitize.test.ts, kept decoupled.
//
// Tests use provider "google" so an empty chunk output returns as final without
// the OpenAI empty-output retry (review-output-validation.ts:158), keeping the
// per-chunk call count deterministic.
// ---------------------------------------------------------------------------
describe("runChunkedReview — output.text aggregation (mt#2739)", () => {
  const fakeConfig = {
    provider: "google",
    providerApiKey: "fake",
    providerModel: "gemini-2.5-pro",
  } as unknown as ReviewerConfig;

  const basePromptInput: Omit<ReviewPromptInput, "diff"> = {
    prNumber: 2739,
    prTitle: "Aggregation test",
    prBody: "",
    taskSpec: null,
    authorshipTier: 3,
    branchName: "task/mt-2739",
    baseBranch: "main",
  };

  /** A CallReviewerFn that returns each queued text in sequence (one per chunk). */
  function fakeReviewerReturningTexts(texts: string[]): CallReviewerFn {
    let i = 0;
    return async (_config, _sys, _user, _tools) => {
      const text = texts[i] ?? "";
      i++;
      const out: ReviewOutput = {
        text,
        provider: "google",
        model: "gemini-2.5-pro",
        toolCalls: [],
      };
      return out;
    };
  }

  /** FILES_PER_CHUNK + 1 small files → chunkFiles yields exactly 2 chunks ([20, 1]). */
  function twoChunkFiles(): PrFileEntry[] {
    return Array.from({ length: FILES_PER_CHUNK + 1 }, (_, i) => makeFile(`f-${i}.ts`, 100));
  }

  function inputWith(callReviewerFn: CallReviewerFn, fileEntries: PrFileEntry[]) {
    return {
      config: fakeConfig,
      systemPrompt: "sys",
      userPrompt: "user",
      basePromptInput,
      tools: undefined,
      outputToolsActive: false,
      fileEntries,
      diff: "",
      owner: "edobry",
      repo: "minsky",
      prNumber: 2739,
      totalDiffLines: 42,
      callReviewerFn,
    };
  }

  test("concatenates every non-empty chunk's output.text with a blank-line separator", async () => {
    const files = twoChunkFiles();
    // Sanity: this fixture really produces >1 chunk (else the assertion is vacuous).
    expect(chunkFiles(files).length).toBeGreaterThan(1);

    const result = await runChunkedReview(
      inputWith(fakeReviewerReturningTexts(["scratch one", "scratch two"]), files)
    );

    // Both chunks represented, not just the last — the mt#2739 behavior change.
    expect(result.output.text).toBe("scratch one\n\nscratch two");
  });

  test("skips empty or whitespace-only chunk texts (no leading/dangling separator)", async () => {
    // Whitespace-only is the stronger case flagged in PR #1884 R1; a genuinely
    // empty "" trims to the same "" and is covered by the same guard.
    const result = await runChunkedReview(
      inputWith(fakeReviewerReturningTexts(["  \n  ", "only second"]), twoChunkFiles())
    );
    expect(result.output.text).toBe("only second");
  });

  test("includes an EARLIER (non-last) chunk's scratch in the aggregate — the gap mt#2739 closes", async () => {
    // Pre-mt#2739 kept only the LAST chunk, dropping earlier chunks' scratch, so
    // the CoT-leak sanitizer (review-worker.ts:960) never saw it. The aggregator's
    // job is to surface EVERY chunk's free-text into the channel the sanitizer
    // consumes; whether the sanitizer then fires on given content is owned by
    // sanitize.test.ts (kept decoupled here to avoid brittle cross-module coupling).
    const earlierScratch = "Calling read_file on src/auth/session.ts.\nGo.";
    const lastScratch = "Reviewed; findings submitted via tools.";

    const result = await runChunkedReview(
      inputWith(fakeReviewerReturningTexts([earlierScratch, lastScratch]), twoChunkFiles())
    );

    // Earlier chunk is no longer dropped — its scratch reaches the aggregate,
    // joined with the last chunk by exactly one blank line.
    expect(result.output.text).toContain("Calling read_file on src/auth/session.ts.");
    expect(result.output.text).toBe(`${earlierScratch}\n\n${lastScratch}`);
  });

  test("joins chunks with exactly one blank line, even when chunks carry surrounding blank lines", async () => {
    // A chunk with trailing blank lines followed by one with leading blank lines
    // must NOT combine into a 3+-newline run at the join (which could read as the
    // PR #743 blank-line-run leak pattern). The per-chunk trim keeps it a single
    // "\n\n" — this is the structural FP-avoidance guarantee at the aggregation
    // layer; the sanitizer's own FP/TP behavior is owned by sanitize.test.ts.
    const a = "chunk A body\n\n\n";
    const b = "\n\nchunk B body";
    const result = await runChunkedReview(
      inputWith(fakeReviewerReturningTexts([a, b]), twoChunkFiles())
    );
    expect(result.output.text).toBe("chunk A body\n\nchunk B body");
    expect(result.output.text).not.toMatch(/\n{3,}/);
  });
});

// runChunkedReview — usage aggregation across chunks (mt#3665)
//
// The aggregator sums promptTokens/completionTokens/reasoningTokens across
// chunks. It did NOT sum cachedTokens, and omitted the field from the aggregate
// `usage` entirely — so `timingTokenFields` read undefined, persisted NULL, and
// `computeCostUsd` priced the whole prompt at the full uncached rate. Because
// chunking is size-triggered, this mis-priced exactly the largest reviews:
// ~50% of all recorded reviewer spend over 16 days sat in that class, at roughly
// 4x its true cost. These tests assert the aggregation directly.
// ---------------------------------------------------------------------------
describe("runChunkedReview — usage aggregation (mt#3665)", () => {
  const fakeConfig = {
    provider: "google",
    providerApiKey: "fake",
    providerModel: "gemini-2.5-pro",
  } as unknown as ReviewerConfig;

  const basePromptInput: Omit<ReviewPromptInput, "diff"> = {
    prNumber: 3665,
    prTitle: "Usage aggregation test",
    prBody: "",
    taskSpec: null,
    authorshipTier: 3,
    branchName: "task/mt-3665",
    baseBranch: "main",
  };

  /** A CallReviewerFn returning one queued usage record per chunk. */
  function fakeReviewerReturningUsage(usages: ReviewUsage[]): CallReviewerFn {
    let i = 0;
    return async (_config, _sys, _user, _tools) => {
      const usage = usages[i] ?? { cachedTokens: 0 };
      i++;
      const out: ReviewOutput = {
        text: "",
        provider: "google",
        model: "gemini-2.5-pro",
        toolCalls: [],
        usage,
      };
      return out;
    };
  }

  function twoChunkFiles(): PrFileEntry[] {
    return Array.from({ length: FILES_PER_CHUNK + 1 }, (_, i) => makeFile(`f-${i}.ts`, 100));
  }

  function inputWith(callReviewerFn: CallReviewerFn, fileEntries: PrFileEntry[]) {
    return {
      config: fakeConfig,
      systemPrompt: "sys",
      userPrompt: "user",
      basePromptInput,
      tools: undefined,
      outputToolsActive: false,
      fileEntries,
      diff: "",
      owner: "edobry",
      repo: "minsky",
      prNumber: 3665,
      totalDiffLines: 42,
      callReviewerFn,
    };
  }

  test("sums cachedTokens across chunks into the aggregate usage", async () => {
    const files = twoChunkFiles();
    // Sanity: the fixture really produces >1 chunk (else the assertion is vacuous).
    expect(chunkFiles(files).length).toBeGreaterThan(1);

    const result = await runChunkedReview(
      inputWith(
        fakeReviewerReturningUsage([
          { promptTokens: 400_000, completionTokens: 1_000, cachedTokens: 340_000 },
          { promptTokens: 300_000, completionTokens: 500, cachedTokens: 250_000 },
        ]),
        files
      )
    );

    expect(result.output.usage?.cachedTokens).toBe(590_000);
    // The siblings that already worked must keep working — this is an addition,
    // not a re-shaping of the aggregate.
    expect(result.output.usage?.promptTokens).toBe(700_000);
    expect(result.output.usage?.completionTokens).toBe(1_500);
  });

  test("emits a real 0 rather than an absent field when no chunk cached anything", async () => {
    // The distinction this whole task rests on: 0 is an observation and prices
    // at the full rate correctly; absent/NULL is unpriceable. The aggregate must
    // never be the latter.
    const result = await runChunkedReview(
      inputWith(
        fakeReviewerReturningUsage([
          { promptTokens: 1_000, completionTokens: 10, cachedTokens: 0 },
          { promptTokens: 2_000, completionTokens: 20, cachedTokens: 0 },
        ]),
        twoChunkFiles()
      )
    );

    expect(result.output.usage?.cachedTokens).toBe(0);
    expect(result.output.usage).toHaveProperty("cachedTokens");
  });

  test("the aggregate prices at the cached rate end-to-end, not the full one", async () => {
    // Guards the actual defect: a correct field that never reaches the cost
    // computation would still overstate the bill. 700k prompt / 590k cached on
    // gpt-5 = 110k*$1.25 + 590k*$0.125 = (137500 + 73750)/1e6 = $0.21125,
    // versus $0.875 if the cached count were dropped — a 4.1x overstatement.
    const result = await runChunkedReview(
      inputWith(
        fakeReviewerReturningUsage([
          { promptTokens: 400_000, completionTokens: 0, cachedTokens: 340_000 },
          { promptTokens: 300_000, completionTokens: 0, cachedTokens: 250_000 },
        ]),
        twoChunkFiles()
      )
    );

    const usage = result.output.usage;
    expect(usage).toBeDefined();
    const fields = timingTokenFields({ model: "gpt-5", usage });
    expect(fields.cachedTokens).toBe(590_000);
    expect(fields.costUsd).toBe(0.21125);
  });
});
