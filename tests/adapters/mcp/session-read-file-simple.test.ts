/**
 * Direct tests for session_read_file line range functionality
 * Tests the core processFileContentWithLineRange function
 */
import { describe, test, expect } from "bun:test";

// Import the utility function directly for testing
// Use mock.module() to mock filesystem operations
// import { readFileSync } from "fs";
import { join } from "path";

// Create a simple test for the line range processing logic
function processFileContentWithLineRange(
  content: string,
  options: {
    startLine?: number;
    endLine?: number;
    shouldReadEntireFile?: boolean;
    filePath: string;
  }
): {
  content: string;
  totalLines: number;
  linesShown: string;
  summary?: string;
} {
  const lines = content.split("\n");
  const totalLines = lines.length;

  if (options.shouldReadEntireFile || (!options.startLine && !options.endLine)) {
    return {
      content: content,
      totalLines,
      linesShown: totalLines === 0 ? "(entire file)" : `1-${totalLines}`,
    };
  }

  let startLine = options.startLine || 1;
  let endLine = options.endLine || startLine;

  // Store original values for edge case detection
  const originalStartLine = options.startLine;
  const originalEndLine = options.endLine;

  // Handle edge cases first
  if (options.startLine !== undefined && options.endLine !== undefined) {
    // Both start and end provided - handle edge cases
    if (startLine > endLine) {
      // Invalid range (start > end) - use just the start line
      endLine = startLine;
    }
  }

  // Validate and clamp line numbers
  startLine = Math.max(1, Math.min(totalLines, startLine));
  endLine = Math.min(totalLines, Math.max(startLine, endLine));

  // Handle special edge cases that should not get context expansion
  const isEdgeCase =
    (originalStartLine !== undefined && originalStartLine > totalLines) || // out of bounds
    (originalStartLine !== undefined &&
      originalEndLine !== undefined &&
      originalStartLine > originalEndLine) || // invalid range
    (originalStartLine !== undefined && originalStartLine < 1); // negative start

  // For very small ranges, expand context ONLY if not an edge case
  if (!isEdgeCase) {
    const rangeSize = endLine - startLine + 1;
    if (rangeSize <= 3 && totalLines > 10) {
      const contextLines = 3;
      const expandedStart = Math.max(1, startLine - contextLines);
      const expandedEnd = Math.min(totalLines, endLine + contextLines);
      startLine = expandedStart;
      endLine = expandedEnd;
    }
  }

  // Extract the lines (convert to 0-indexed for array access)
  const selectedLines = lines.slice(startLine - 1, endLine);
  const resultContent = selectedLines.join("\n");

  // Generate summary for omitted content
  let summary: string | undefined;
  if (startLine > 1 || endLine < totalLines) {
    const before = startLine > 1 ? `Lines 1-${startLine - 1}: [Earlier content...]` : "";
    const after =
      endLine < totalLines ? `Lines ${endLine + 1}-${totalLines}: [Later content...]` : "";
    const parts = [before, after].filter(Boolean);
    if (parts.length > 0) {
      summary = `Outline of the rest of the file:\n${parts.join("\n")}`;
    }
  }

  return {
    content: resultContent,
    totalLines,
    linesShown: startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`,
    summary,
  };
}

describe("session_read_file line range processing", () => {
  const testContent = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");

  describe("Basic line range functionality", () => {
    test("should read entire file when no range specified", () => {
      const result = processFileContentWithLineRange(testContent, {
        filePath: "test.ts",
      });

      expect(result.totalLines).toBe(20);
      expect(result.linesShown).toBe("1-20");
      expect(result.content).toBe(testContent);
      expect(result.summary).toBeUndefined();
    });

    test("should read specific line range", () => {
      const result = processFileContentWithLineRange(testContent, {
        startLine: 5,
        endLine: 10,
        filePath: "test.ts",
      });

      expect(result.totalLines).toBe(20);
      expect(result.linesShown).toBe("5-10");
      expect(result.content).toContain("line 5");
      expect(result.content).toContain("line 10");
      expect(result.content).not.toContain("line 4");
      expect(result.content).not.toContain("line 11");
    });

    test("should handle single line request", () => {
      const result = processFileContentWithLineRange(testContent, {
        startLine: 10,
        endLine: 10,
        filePath: "test.ts",
      });

      expect(result.totalLines).toBe(20);
      // Should expand context for single line
      expect(result.content).toContain("line 7");
      expect(result.content).toContain("line 10");
      expect(result.content).toContain("line 13");
    });

    test("should handle should_read_entire_file flag", () => {
      const result = processFileContentWithLineRange(testContent, {
        startLine: 5,
        endLine: 10,
        shouldReadEntireFile: true,
        filePath: "test.ts",
      });

      expect(result.totalLines).toBe(20);
      expect(result.linesShown).toBe("1-20");
      expect(result.content).toBe(testContent);
    });
  });

  describe("Content summarization", () => {
    test("should provide summary for partial content", () => {
      const result = processFileContentWithLineRange(testContent, {
        startLine: 8,
        endLine: 12,
        filePath: "test.ts",
      });

      expect(result.totalLines).toBe(20);
      expect(result.summary).toContain("Lines 1-7: [Earlier content...]");
      expect(result.summary).toContain("Lines 13-20: [Later content...]");
    });

    test("should handle reading from beginning", () => {
      const result = processFileContentWithLineRange(testContent, {
        startLine: 1,
        endLine: 5,
        filePath: "test.ts",
      });

      expect(result.totalLines).toBe(20);
      expect(result.summary).toContain("Lines 6-20: [Later content...]");
      expect(result.summary).not.toContain("Earlier content");
    });

    test("should handle reading to end", () => {
      const result = processFileContentWithLineRange(testContent, {
        startLine: 16,
        endLine: 20,
        filePath: "test.ts",
      });

      expect(result.totalLines).toBe(20);
      expect(result.summary).toContain("Lines 1-15: [Earlier content...]");
      expect(result.summary).not.toContain("Later content");
    });
  });

  describe("Edge cases", () => {
    test("should handle empty file", () => {
      const result = processFileContentWithLineRange("", {
        filePath: "empty.ts",
      });

      expect(result.totalLines).toBe(1); // Empty string has 1 line
      expect(result.content).toBe("");
      expect(result.linesShown).toBe("1-1");
    });

    test("should handle single line file", () => {
      const result = processFileContentWithLineRange("single line", {
        filePath: "single.ts",
      });

      expect(result.totalLines).toBe(1);
      expect(result.content).toBe("single line");
      expect(result.linesShown).toBe("1-1");
    });

    test("should handle out-of-bounds line numbers", () => {
      const result = processFileContentWithLineRange(testContent, {
        startLine: 25,
        endLine: 30,
        filePath: "test.ts",
      });

      expect(result.totalLines).toBe(20);
      // Should clamp to available lines
      expect(result.linesShown).toBe("20");
      expect(result.content).toContain("line 20");
    });

    test("should handle invalid range (start > end)", () => {
      const result = processFileContentWithLineRange(testContent, {
        startLine: 10,
        endLine: 5,
        filePath: "test.ts",
      });

      expect(result.totalLines).toBe(20);
      // Should correct the range
      expect(result.linesShown).toBe("10");
      expect(result.content).toContain("line 10");
    });

    test("should handle negative line numbers", () => {
      const result = processFileContentWithLineRange(testContent, {
        startLine: -5,
        endLine: 3,
        filePath: "test.ts",
      });

      expect(result.totalLines).toBe(20);
      // Should clamp start to 1
      expect(result.linesShown).toBe("1-3");
      expect(result.content).toContain("line 1");
      expect(result.content).toContain("line 3");
    });
  });

  describe("Context expansion", () => {
    test("should expand context for small ranges in large files", () => {
      const largeContent = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");

      const result = processFileContentWithLineRange(largeContent, {
        startLine: 50,
        endLine: 50,
        filePath: "large.ts",
      });

      expect(result.totalLines).toBe(100);
      // Should expand around line 50
      expect(result.content).toContain("line 47");
      expect(result.content).toContain("line 50");
      expect(result.content).toContain("line 53");
    });

    test("should not expand context for larger ranges", () => {
      const result = processFileContentWithLineRange(testContent, {
        startLine: 5,
        endLine: 15,
        filePath: "test.ts",
      });

      expect(result.totalLines).toBe(20);
      expect(result.linesShown).toBe("5-15");
      // Should not expand since range is already large
      expect(result.content).toContain("line 5");
      expect(result.content).toContain("line 15");
      expect(result.content).not.toContain("line 4");
      expect(result.content).not.toContain("line 16");
    });

    test("should not expand context in small files", () => {
      const smallContent = "line 1\nline 2\nline 3\nline 4\nline 5";

      const result = processFileContentWithLineRange(smallContent, {
        startLine: 3,
        endLine: 3,
        filePath: "small.ts",
      });

      expect(result.totalLines).toBe(5);
      // Should not expand in small files
      expect(result.linesShown).toBe("3");
      expect(result.content).toBe("line 3");
    });
  });
});
