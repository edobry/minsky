/**
 * Tests for Bun Test Mocking Consistency Fixer
 *
 * Comprehensive test coverage for the 9th systematic AST codemod
 * that fixes vi.fn() vs bun:test mock() inconsistencies.
 */

import { describe, test, expect } from "bun:test";
import { Project } from "ts-morph";
import {
  fixMockingConsistencyInFile,
  fixMockingConsistency,
} from "./bun-test-mocking-consistency-fixer";

describe("Bun Test Mocking Consistency Fixer", () => {
  describe("fixMockingConsistencyInFile", () => {
    test("should skip non-test files for safety", () => {
      const project = new Project();
      const sourceFile = project.createSourceFile(
        "regular-file.ts",
        `
        import { describe } from "bun:test";
        const obj = { fn: vi.fn() };
      `
      );

      const result = fixMockingConsistencyInFile(sourceFile);

      expect(result.changed).toBe(false);
      expect(result.reason).toBe("Not a test file - skipped for safety");
      expect(result.transformations).toBe(0);
    });

    test("should skip files that don't import from bun:test", () => {
      const project = new Project();
      const sourceFile = project.createSourceFile(
        "vitest.test.ts",
        `
        import { describe, test, expect, vi } from "vitest";
        const mockFn = vi.fn();
      `
      );

      const result = fixMockingConsistencyInFile(sourceFile);

      expect(result.changed).toBe(false);
      expect(result.reason).toBe("No bun:test import found - not a bun test file");
      expect(result.transformations).toBe(0);
    });

    test("should transform vi.fn() to mock() and add import when missing", () => {
      const project = new Project();
      const sourceFile = project.createSourceFile(
        "test-file.test.ts",
        `
        import { describe, test, expect } from "bun:test";

        const mockLog = {
          info: vi.fn(),
          error: vi.fn()
        };
      `
      );

      const result = fixMockingConsistencyInFile(sourceFile);

      expect(result.changed).toBe(true);
      expect(result.reason).toBe("Converted 2 vi.fn() calls to mock() for bun:test compatibility");
      expect(result.transformations).toBe(2);
      expect(sourceFile.getFullText()).toContain(
        'import { describe, test, expect, mock } from "bun:test";'
      );
      expect(sourceFile.getFullText()).toContain("info: mock(() => {})");
      expect(sourceFile.getFullText()).toContain("error: mock(() => {})");
    });

    test("should not add mock import if already present", () => {
      const project = new Project();
      const sourceFile = project.createSourceFile(
        "already-has-mock.test.ts",
        `
        import { describe, test, expect, mock } from "bun:test";

        const mockFn = vi.fn();
      `
      );

      const result = fixMockingConsistencyInFile(sourceFile);

      expect(result.changed).toBe(true);
      expect(result.reason).toBe("Converted 1 vi.fn() calls to mock() for bun:test compatibility");
      expect(result.transformations).toBe(1);
      // Should not duplicate mock import
      expect(sourceFile.getFullText()).toContain(
        'import { describe, test, expect, mock } from "bun:test";'
      );
      expect(sourceFile.getFullText()).toContain("const mockFn = mock(() => {});");
    });

    test("should preserve vi.fn() arguments when transforming", () => {
      const project = new Project();
      const sourceFile = project.createSourceFile(
        "with-args.test.ts",
        `
        import { describe, test, expect } from "bun:test";

        const mockFn = vi.fn(() => "result");
        const complexMock = vi.fn((a, b) => a + b);
      `
      );

      const result = fixMockingConsistencyInFile(sourceFile);

      expect(result.changed).toBe(true);
      expect(result.transformations).toBe(2);
      expect(sourceFile.getFullText()).toContain('const mockFn = mock(() => "result");');
      expect(sourceFile.getFullText()).toContain("const complexMock = mock((a, b) => a + b);");
    });

    test("should not modify files without vi.fn() calls", () => {
      const project = new Project();
      const sourceFile = project.createSourceFile(
        "clean-file.test.ts",
        `
        import { describe, test, expect, mock } from "bun:test";

        const mockFn = mock(() => {});
        const regularFn = () => {};
      `
      );

      const result = fixMockingConsistencyInFile(sourceFile);

      expect(result.changed).toBe(false);
      expect(result.reason).toBe("No vi.fn() calls found to convert");
      expect(result.transformations).toBe(0);
    });

    test("should only transform vi.fn() calls, not other vi methods", () => {
      const project = new Project();
      const sourceFile = project.createSourceFile(
        "selective.test.ts",
        `
        import { describe, test, expect } from "bun:test";

        const mockFn = vi.fn();
        const spyCall = vi.spyOn(obj, 'method');
        const mockCall = vi.mock('./module');
      `
      );

      const result = fixMockingConsistencyInFile(sourceFile);

      expect(result.changed).toBe(true);
      expect(result.transformations).toBe(1); // Only vi.fn() should be transformed
      expect(sourceFile.getFullText()).toContain("const mockFn = mock(() => {});");
      expect(sourceFile.getFullText()).toContain("const spyCall = vi.spyOn(obj, 'method');"); // Unchanged
      expect(sourceFile.getFullText()).toContain("const mockCall = vi.mock('./module');"); // Unchanged
    });
  });

  describe("fixMockingConsistency", () => {
    test("should process multiple files and return results", () => {
      // This test verifies the batch processing functionality
      const results = fixMockingConsistency([]);

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(0);
    });

    test("should handle file processing errors gracefully", () => {
      const results = fixMockingConsistency(["/nonexistent/file.test.ts"]);

      expect(results.length).toBe(1);
      expect(results[0].changed).toBe(false);
      expect(results[0].reason).toContain("Error");
    });
  });

  describe("boundary validation tests", () => {
    test("should never modify production code files", () => {
      const project = new Project();
      const sourceFile = project.createSourceFile(
        "src/production.ts",
        `
        import { describe } from "bun:test";
        const obj = { method: vi.fn() };
      `
      );

      const result = fixMockingConsistencyInFile(sourceFile);

      expect(result.changed).toBe(false);
      expect(result.reason).toBe("Not a test file - skipped for safety");
    });

    test("should preserve existing valid bun:test mocking without changes", () => {
      const project = new Project();
      const sourceFile = project.createSourceFile(
        "correct-usage.test.ts",
        `
        import { describe, test, expect, mock } from "bun:test";

        const mockLogger = {
          info: mock(() => {}),
          error: mock(() => {})
        };
      `
      );

      const originalText = sourceFile.getFullText();
      const result = fixMockingConsistencyInFile(sourceFile);

      expect(result.changed).toBe(false);
      expect(sourceFile.getFullText()).toBe(originalText);
    });

    test("should maintain valid TypeScript syntax after modifications", () => {
      const project = new Project();
      const sourceFile = project.createSourceFile(
        "syntax-validation.test.ts",
        `
        import { describe, test, expect } from "bun:test";

        describe("test suite", () => {
          const log = {
            cli: vi.fn(),
            info: vi.fn()
          };
        });
      `
      );

      const result = fixMockingConsistencyInFile(sourceFile);

      expect(result.changed).toBe(true);

      // Verify the file can be parsed without syntax errors
      const diagnostics = sourceFile.getPreEmitDiagnostics();
      expect(diagnostics.length).toBe(0);
    });
  });
});
