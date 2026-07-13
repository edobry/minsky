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
  type ChunkInfo,
} from "./chunked-review";
import type { PrFileEntry } from "./github-client";
import type { ReviewPromptInput } from "./prompt";
import type { ReviewOutput } from "./providers";
import type { CallReviewerFn } from "./review-output-validation";
import type { ReviewerConfig } from "./config";
import { sanitizeReviewBody } from "./sanitize";

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

// ---------------------------------------------------------------------------
// runChunkedReview — output.text aggregation across chunks (mt#2739)
//
// The aggregate ReviewOutput.text is the model's free-text scratch channel,
// consumed ONLY by the defensive CoT-leak scratch logging on the output-tools
// path (review-worker.ts:960, sanitizeReviewBody(output.text)) — the posted
// body is composed from tool calls, not this field. Before mt#2739, aggregation
// kept only the LAST non-empty chunk's text (`lastText = output.text || lastText`),
// so leaked reasoning in an EARLIER chunk was never inspected. mt#2739
// concatenates every non-empty chunk's text with a blank-line separator so the
// sanitizer sees all chunks' scratch.
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

  test("skips empty chunk texts when concatenating (no leading/dangling separator)", async () => {
    const files = twoChunkFiles();
    const result = await runChunkedReview(
      inputWith(fakeReviewerReturningTexts(["", "only second"]), files)
    );
    // Empty first chunk contributes nothing; no leading "\n\n".
    expect(result.output.text).toBe("only second");
  });

  test("CoT-leak signal fires on an EARLIER chunk's scratch — the gap mt#2739 closes", async () => {
    // Earlier chunk leaks raw reasoning; last chunk is a clean structured review.
    const earlierLeak = [
      "I will review the auth module now.",
      "Calling read_file on src/auth/session.ts.",
      "Go.",
      "This time for sure.",
      "Let's try again.",
    ].join("\n");
    const lastClean =
      "## Findings\n\n- [BLOCKING] src/auth/session.ts:10 — missing guard.\n\nAPPROVE";

    // Baseline: sanitizing ONLY the last chunk passes through — last-chunk-only
    // aggregation (pre-mt#2739) would have MISSED the earlier leak.
    expect(sanitizeReviewBody(lastClean).action).toBe("passthrough");

    const result = await runChunkedReview(
      inputWith(fakeReviewerReturningTexts([earlierLeak, lastClean]), twoChunkFiles())
    );

    // The aggregate now includes the earlier chunk's scratch...
    expect(result.output.text).toContain("Calling read_file on src/auth/session.ts.");
    // ...so the defensive sanitizer (review-worker.ts:960) detects the leak.
    expect(sanitizeReviewBody(result.output.text).action).not.toBe("passthrough");
  });

  test("concatenating two clean chunk texts does not introduce a false positive", async () => {
    // Two independently-clean structured reviews (each passes through on its own).
    const cleanA = "## Findings\n\n- [NON-BLOCKING] src/a.ts:1 — nit.\n\nAPPROVE";
    const cleanB = "## Findings\n\n- [BLOCKING] src/b.ts:2 — bug.\n\nEvent: REQUEST_CHANGES";
    expect(sanitizeReviewBody(cleanA).action).toBe("passthrough");
    expect(sanitizeReviewBody(cleanB).action).toBe("passthrough");

    const result = await runChunkedReview(
      inputWith(fakeReviewerReturningTexts([cleanA, cleanB]), twoChunkFiles())
    );

    // The concatenated scratch is what the sanitizer would see on the chunked
    // path; two clean chunks must not trip it (SC #2).
    expect(sanitizeReviewBody(result.output.text).action).toBe("passthrough");
  });
});
