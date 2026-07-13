/**
 * Tests for MetadataExtractor pure functions.
 *
 * All tests use in-memory fixtures — no DB or file system access.
 * Covers:
 *  - extractTaskIds: basic extraction, deduplication, sorting
 *  - extractPrNumbers: basic extraction, deduplication, sorting
 *  - Distinguished: mt#X references must NOT produce PR numbers for the same X
 *  - extractMetadata: full transcript extraction across multiple turns
 *  - Edge cases: empty, null, mixed content
 *
 * Acceptance criterion from spec:
 *   A transcript referencing `mt#1313` and `#763` produces
 *   related_task_ids = ['mt#1313'] and related_pr_numbers = [763].
 *
 * @see mt#1329 — metadata-extractor.ts
 */

import { describe, test, expect } from "bun:test";

import {
  extractTaskIds,
  extractPrNumbers,
  extractMetadata,
  extractMetadataFromJsonb,
  type TranscriptLine,
} from "./metadata-extractor";
import type { RawTurnLine } from "./transcript-source";

// ── extractTaskIds ────────────────────────────────────────────────────────────

describe("extractTaskIds", () => {
  test("returns empty array for text with no task IDs", () => {
    expect(extractTaskIds("no references here")).toEqual([]);
  });

  test("extracts a single task ID", () => {
    expect(extractTaskIds("working on mt#1313 today")).toEqual(["mt#1313"]);
  });

  test("extracts multiple distinct task IDs", () => {
    const result = extractTaskIds("mt#100 and mt#200 and mt#300");
    expect(result).toEqual(["mt#100", "mt#200", "mt#300"]);
  });

  test("deduplicates repeated task IDs", () => {
    const result = extractTaskIds("mt#42 and mt#42 again mt#42");
    expect(result).toEqual(["mt#42"]);
  });

  test("sorts task IDs lexicographically", () => {
    // Lexicographic sort:
    //   "mt#10" < "mt#2" (because "1" < "2" at position 3)
    //   "mt#2" < "mt#200" (because "mt#2" is a prefix of "mt#200", shorter wins)
    const result = extractTaskIds("mt#200 then mt#10 then mt#2");
    expect(result).toEqual(["mt#10", "mt#2", "mt#200"]);
  });

  test("handles task IDs at start and end of string", () => {
    const result = extractTaskIds("mt#1 middle mt#999");
    expect(result).toEqual(["mt#1", "mt#999"]);
  });

  test("extracts task IDs embedded in longer text (no word boundary required)", () => {
    const result = extractTaskIds("fixedmt#123issue");
    expect(result).toEqual(["mt#123"]);
  });

  test("handles empty string", () => {
    expect(extractTaskIds("")).toEqual([]);
  });

  test("returns sorted unique IDs from a realistic session note", () => {
    const text = `
      Working on mt#1313 transcript search.
      See also mt#1350 and mt#1351.
      mt#1313 was mentioned again.
    `;
    const result = extractTaskIds(text);
    expect(result).toContain("mt#1313");
    expect(result).toContain("mt#1350");
    expect(result).toContain("mt#1351");
    expect(result.filter((id) => id === "mt#1313")).toHaveLength(1); // deduplicated
  });
});

// ── extractPrNumbers ──────────────────────────────────────────────────────────

describe("extractPrNumbers", () => {
  test("returns empty array for text with no PR numbers", () => {
    expect(extractPrNumbers("no hash references here")).toEqual([]);
  });

  test("extracts a single PR number preceded by space", () => {
    expect(extractPrNumbers("see PR #763 for details")).toEqual([763]);
  });

  test("extracts multiple distinct PR numbers", () => {
    const result = extractPrNumbers("PRs #100 #200 #300");
    expect(result).toEqual([100, 200, 300]);
  });

  test("deduplicates repeated PR numbers", () => {
    const result = extractPrNumbers("#42 and #42 again #42");
    expect(result).toEqual([42]);
  });

  test("sorts PR numbers numerically", () => {
    const result = extractPrNumbers("#300 #10 #200 #50");
    expect(result).toEqual([10, 50, 200, 300]);
  });

  test("does NOT extract the number from mt#1313 as PR 1313", () => {
    const result = extractPrNumbers("working on mt#1313");
    expect(result).not.toContain(1313);
    expect(result).toEqual([]);
  });

  test("extracts standalone #N but not mt#N", () => {
    const result = extractPrNumbers("mt#1313 and #763 and mt#400");
    expect(result).toEqual([763]);
    expect(result).not.toContain(1313);
    expect(result).not.toContain(400);
  });

  test("extracts PR number at start of line", () => {
    const text = "#100 is the first PR\n#200 is the second";
    const result = extractPrNumbers(text);
    expect(result).toContain(100);
    expect(result).toContain(200);
  });

  test("extracts PR number preceded by parenthesis", () => {
    const result = extractPrNumbers("see commit (#789)");
    expect(result).toContain(789);
  });

  test("extracts PR number preceded by bracket", () => {
    const result = extractPrNumbers("see [#456]");
    expect(result).toContain(456);
  });

  test("handles empty string", () => {
    expect(extractPrNumbers("")).toEqual([]);
  });
});

// ── extractMetadata ───────────────────────────────────────────────────────────

describe("extractMetadata", () => {
  test("returns empty metadata for empty transcript", () => {
    const result = extractMetadata([]);
    expect(result).toEqual({ task_ids: [], pr_numbers: [] });
  });

  test("extracts from userText fields", () => {
    const transcript: TranscriptLine[] = [{ userText: "implement mt#1313" }];
    const result = extractMetadata(transcript);
    expect(result.task_ids).toContain("mt#1313");
  });

  test("extracts from assistantText fields", () => {
    const transcript: TranscriptLine[] = [{ assistantText: "I will fix #763 in the PR" }];
    const result = extractMetadata(transcript);
    expect(result.pr_numbers).toContain(763);
  });

  test("extracts across multiple turns", () => {
    const transcript: TranscriptLine[] = [
      { userText: "work on mt#100" },
      { assistantText: "opening PR #50 for this" },
      { userText: "also see mt#200" },
    ];
    const result = extractMetadata(transcript);
    expect(result.task_ids).toContain("mt#100");
    expect(result.task_ids).toContain("mt#200");
    expect(result.pr_numbers).toContain(50);
  });

  test("deduplicates task IDs across turns", () => {
    const transcript: TranscriptLine[] = [
      { userText: "mt#1313 is the parent" },
      { assistantText: "as noted in mt#1313, yes" },
    ];
    const result = extractMetadata(transcript);
    expect(result.task_ids).toHaveLength(1);
    expect(result.task_ids).toEqual(["mt#1313"]);
  });

  test("spec acceptance criterion: mt#1313 and #763 produces correct output", () => {
    const transcript: TranscriptLine[] = [
      {
        userText: "implement the feature from mt#1313 spec",
        assistantText: "see PR #763 for the implementation",
      },
    ];
    const result = extractMetadata(transcript);
    expect(result.task_ids).toEqual(["mt#1313"]);
    expect(result.pr_numbers).toEqual([763]);
  });

  test("mt#X does NOT contribute to pr_numbers", () => {
    const transcript: TranscriptLine[] = [{ userText: "mt#1313 mentioned, #50 is the PR" }];
    const result = extractMetadata(transcript);
    expect(result.task_ids).toContain("mt#1313");
    expect(result.pr_numbers).toContain(50);
    expect(result.pr_numbers).not.toContain(1313);
  });

  test("handles turns with null text fields", () => {
    const transcript: TranscriptLine[] = [
      { userText: null, assistantText: "mt#42" },
      { userText: "see #10", assistantText: null },
    ];
    const result = extractMetadata(transcript);
    expect(result.task_ids).toContain("mt#42");
    expect(result.pr_numbers).toContain(10);
  });

  test("handles RawTurnLine arrays (string content)", () => {
    const transcript: RawTurnLine[] = [
      {
        type: "user",
        timestamp: "2026-01-01T00:00:00Z",
        message: { role: "user", content: "implement mt#500 as PR #99" },
      },
    ];
    const result = extractMetadata(transcript);
    expect(result.task_ids).toContain("mt#500");
    expect(result.pr_numbers).toContain(99);
  });

  test("handles RawTurnLine arrays (array content blocks)", () => {
    const transcript: RawTurnLine[] = [
      {
        type: "user",
        timestamp: "2026-01-01T00:00:00Z",
        message: {
          role: "user",
          content: [
            { type: "text", text: "implement mt#600" },
            { type: "tool_result", content: "some result" },
          ],
        },
      },
    ];
    const result = extractMetadata(transcript);
    expect(result.task_ids).toContain("mt#600");
  });
});

// ── extractMetadataFromJsonb ──────────────────────────────────────────────────

describe("extractMetadataFromJsonb", () => {
  test("returns empty metadata for null input", () => {
    const result = extractMetadataFromJsonb(null);
    expect(result).toEqual({ task_ids: [], pr_numbers: [] });
  });

  test("returns empty metadata for non-array input", () => {
    const result = extractMetadataFromJsonb({ not: "an array" });
    expect(result).toEqual({ task_ids: [], pr_numbers: [] });
  });

  test("returns empty metadata for empty array", () => {
    const result = extractMetadataFromJsonb([]);
    expect(result).toEqual({ task_ids: [], pr_numbers: [] });
  });

  test("extracts from jsonb-like array of lines", () => {
    const jsonb = [
      {
        type: "user",
        timestamp: "2026-01-01T00:00:00Z",
        message: { role: "user", content: "mt#1329 was implemented via #847" },
      },
    ];
    const result = extractMetadataFromJsonb(jsonb);
    expect(result.task_ids).toContain("mt#1329");
    expect(result.pr_numbers).toContain(847);
  });
});
