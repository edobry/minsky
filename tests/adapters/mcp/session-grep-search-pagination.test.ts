/**
 * Tests for session_grep_search pagination/limiting features
 * Tests schema defaults and the new limit/files_only/max_context_lines parameters
 */
import { describe, test, expect } from "bun:test";
import { GrepSearchSchema } from "../../../src/domain/schemas/file-schemas";

describe("GrepSearchSchema — pagination parameters", () => {
  test("default limit is 50", () => {
    const result = GrepSearchSchema.parse({
      sessionId: "test-session",
      query: "foo",
    });
    expect(result.limit).toBe(50);
  });

  test("custom limit is accepted", () => {
    const result = GrepSearchSchema.parse({
      sessionId: "test-session",
      query: "foo",
      limit: 10,
    });
    expect(result.limit).toBe(10);
  });

  test("limit must be a positive integer", () => {
    expect(() => GrepSearchSchema.parse({ sessionId: "s", query: "q", limit: 0 })).toThrow();
    expect(() => GrepSearchSchema.parse({ sessionId: "s", query: "q", limit: -1 })).toThrow();
  });

  test("files_only defaults to false", () => {
    const result = GrepSearchSchema.parse({
      sessionId: "test-session",
      query: "foo",
    });
    expect(result.files_only).toBe(false);
  });

  test("files_only can be set to true", () => {
    const result = GrepSearchSchema.parse({
      sessionId: "test-session",
      query: "foo",
      files_only: true,
    });
    expect(result.files_only).toBe(true);
  });

  test("max_context_lines defaults to 0", () => {
    const result = GrepSearchSchema.parse({
      sessionId: "test-session",
      query: "foo",
    });
    expect(result.max_context_lines).toBe(0);
  });

  test("max_context_lines can be set to a positive number", () => {
    const result = GrepSearchSchema.parse({
      sessionId: "test-session",
      query: "foo",
      max_context_lines: 3,
    });
    expect(result.max_context_lines).toBe(3);
  });

  test("max_context_lines must be non-negative", () => {
    expect(() =>
      GrepSearchSchema.parse({ sessionId: "s", query: "q", max_context_lines: -1 })
    ).toThrow();
  });

  test("all new parameters can be combined", () => {
    const result = GrepSearchSchema.parse({
      sessionId: "test-session",
      query: "pattern",
      limit: 25,
      files_only: false,
      max_context_lines: 2,
    });
    expect(result.limit).toBe(25);
    expect(result.files_only).toBe(false);
    expect(result.max_context_lines).toBe(2);
  });

  test("existing parameters still work", () => {
    const result = GrepSearchSchema.parse({
      sessionId: "test-session",
      query: "pattern",
      case_sensitive: true,
      include_pattern: "*.ts",
      exclude_pattern: "*.test.ts",
    });
    expect(result.case_sensitive).toBe(true);
    expect(result.include_pattern).toBe("*.ts");
    expect(result.exclude_pattern).toBe("*.test.ts");
  });
});

// Unit tests for the result-processing logic extracted from the handler.
// These test the same algorithms used in the grep handler without requiring Bun.spawn.
describe("Grep search result processing logic", () => {
  // Replicate the files_only processing logic
  function processFilesOnly(output: string, limit: number) {
    const allFiles = output.trim() ? output.trim().split("\n").filter(Boolean) : [];
    const totalMatches = allFiles.length;
    const limitedFiles = allFiles.slice(0, limit);
    const truncated = allFiles.length > limit;
    return {
      results: limitedFiles.join("\n"),
      matchCount: limitedFiles.length,
      truncated,
      total_matches: totalMatches,
    };
  }

  // Replicate the normal match processing logic
  function processMatchLines(output: string, limit: number) {
    const results: string[] = [];
    let totalMatches = 0;
    let matchLines = 0;

    if (output.trim()) {
      const lines = output.trim().split("\n");
      let currentFile = "";

      for (const line of lines) {
        if (line === "--") {
          results.push("--");
          continue;
        }
        const match = line.match(/^([^:]+):(\d+):(.*)$/);
        if (match && match[1]) {
          totalMatches++;
          if (matchLines >= limit) continue;

          const filePath = match[1];
          const lineNumber = match[2];
          const content = match[3];

          const fileUrl = `file://${filePath}`;
          if (currentFile !== fileUrl) {
            currentFile = fileUrl;
            results.push(`File: ${fileUrl}`);
          }
          results.push(`Line ${lineNumber}: ${content}`);
          matchLines++;
        }
      }
    }

    return {
      results: results.join("\n"),
      matchCount: matchLines,
      truncated: totalMatches > limit,
      total_matches: totalMatches,
    };
  }

  describe("files_only mode", () => {
    test("returns unique file paths", () => {
      const output = "/a/foo.ts\n/b/bar.ts\n/c/baz.ts";
      const result = processFilesOnly(output, 50);
      expect(result.results).toBe("/a/foo.ts\n/b/bar.ts\n/c/baz.ts");
      expect(result.matchCount).toBe(3);
      expect(result.truncated).toBe(false);
    });

    test("applies limit and sets truncated flag", () => {
      const output = "/a/1.ts\n/a/2.ts\n/a/3.ts\n/a/4.ts\n/a/5.ts";
      const result = processFilesOnly(output, 3);
      expect(result.matchCount).toBe(3);
      expect(result.truncated).toBe(true);
      expect(result.total_matches).toBe(5);
      expect(result.results).toBe("/a/1.ts\n/a/2.ts\n/a/3.ts");
    });

    test("handles empty output", () => {
      const result = processFilesOnly("", 50);
      expect(result.matchCount).toBe(0);
      expect(result.truncated).toBe(false);
      expect(result.results).toBe("");
    });

    test("does not truncate when matches equal limit", () => {
      const output = "/a/1.ts\n/a/2.ts\n/a/3.ts";
      const result = processFilesOnly(output, 3);
      expect(result.truncated).toBe(false);
      expect(result.matchCount).toBe(3);
    });
  });

  describe("normal match mode", () => {
    const sampleOutput = [
      "/repo/src/foo.ts:10:const x = 1;",
      "/repo/src/foo.ts:20:const y = 2;",
      "/repo/src/bar.ts:5:import foo;",
    ].join("\n");

    test("groups matches by file with headers", () => {
      const result = processMatchLines(sampleOutput, 50);
      expect(result.results).toContain("File: file:///repo/src/foo.ts");
      expect(result.results).toContain("Line 10: const x = 1;");
      expect(result.results).toContain("Line 20: const y = 2;");
      expect(result.results).toContain("File: file:///repo/src/bar.ts");
      expect(result.results).toContain("Line 5: import foo;");
    });

    test("applies limit to match lines", () => {
      const result = processMatchLines(sampleOutput, 2);
      expect(result.matchCount).toBe(2);
      expect(result.truncated).toBe(true);
      expect(result.total_matches).toBe(3);
    });

    test("no truncation flag when under limit", () => {
      const result = processMatchLines(sampleOutput, 50);
      expect(result.truncated).toBe(false);
    });

    test("default limit of 50 handles fewer matches without truncation", () => {
      const smallOutput = "/repo/src/a.ts:1:match";
      const result = processMatchLines(smallOutput, 50);
      expect(result.truncated).toBe(false);
      expect(result.matchCount).toBe(1);
    });

    test("handles empty output", () => {
      const result = processMatchLines("", 50);
      expect(result.matchCount).toBe(0);
      expect(result.truncated).toBe(false);
    });

    test("does not truncate when matches exactly equal limit", () => {
      const lines = Array.from(
        { length: 5 },
        (_, i) => `/repo/src/f.ts:${i + 1}:line ${i + 1}`
      ).join("\n");
      const result = processMatchLines(lines, 5);
      expect(result.truncated).toBe(false);
      expect(result.matchCount).toBe(5);
    });

    test("skips duplicate file headers when matches are in same file", () => {
      const output = "/repo/src/foo.ts:1:a\n/repo/src/foo.ts:2:b";
      const result = processMatchLines(output, 50);
      const fileHeaders = result.results.split("\n").filter((l) => l.startsWith("File:"));
      expect(fileHeaders).toHaveLength(1);
    });
  });
});
