import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Project, SourceFile } from "ts-morph";
import * as fs from "fs";
import * as path from "path";

/**
 * Tests for directory-aware import path calculation
 *
 * This test validates that we correctly calculate relative import paths
 * based on the actual directory structure, not pattern matching.
 */

describe("Directory-Aware Import Path Calculation", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(import.meta.dir, "temp-"));

    // Create a realistic directory structure
    const dirs = [
      "src/errors",
      "src/schemas",
      "src/utils",
      "src/commands/config",        // 2 levels deep -> ../../
      "src/commands/mcp",           // 2 levels deep -> ../../
      "src/mcp/tools",              // 2 levels deep -> ../../
      "src/domain/session/commands", // 3 levels deep -> ../../../
             "src/domain/session",         // 2 levels deep -> ../../
       "src/domain/git",             // 2 levels deep -> ../../
       "src/domain/storage",         // 2 levels deep -> ../../
       "src/adapters/mcp",           // 2 levels deep -> ../../
       "src/adapters/shared"         // 2 levels deep -> ../../
    ];

    dirs.forEach(dir => {
      fs.mkdirSync(path.join(tempDir, dir), { recursive: true });
    });
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("calculateRelativePath function", () => {
    function calculateRelativePath(fromFile: string, toDirectory: string): string {
      const fromDir = path.dirname(fromFile);
      const relativePath = path.relative(fromDir, toDirectory);

      // Convert backslashes to forward slashes for consistency
      return relativePath.replace(/\\/g, '/');
    }

    it("should calculate correct paths for commands directory (2 levels deep)", () => {
      const result1 = calculateRelativePath("src/commands/config/list.ts", "src/errors");
      expect(result1).toBe("../../errors");

      const result2 = calculateRelativePath("src/commands/mcp/index.ts", "src/utils");
      expect(result2).toBe("../../utils");

      const result3 = calculateRelativePath("src/mcp/tools/session.ts", "src/errors");
      expect(result3).toBe("../../errors");
    });

         it("should calculate correct paths for domain session commands (3 levels deep)", () => {
       const result1 = calculateRelativePath("src/domain/session/commands/get-command.ts", "src/errors");
       expect(result1).toBe("../../../errors");

       const result2 = calculateRelativePath("src/domain/session/commands/start-command.ts", "src/utils");
       expect(result2).toBe("../../../utils");

       const result3 = calculateRelativePath("src/domain/session/commands/update-command.ts", "src/schemas");
       expect(result3).toBe("../../../schemas");
     });

     it("should calculate correct paths for domain subdirectories (2 levels deep)", () => {
       const result1 = calculateRelativePath("src/domain/git/clone-operations.ts", "src/utils");
       expect(result1).toBe("../../utils");

       const result2 = calculateRelativePath("src/domain/storage/json-file-storage.ts", "src/schemas");
       expect(result2).toBe("../../schemas");

       const result3 = calculateRelativePath("src/domain/session/session-operations.ts", "src/errors");
       expect(result3).toBe("../../errors");
     });

     it("should calculate correct paths for adapters directory (2 levels deep)", () => {
       const result1 = calculateRelativePath("src/adapters/mcp/session.ts", "src/errors");
       expect(result1).toBe("../../errors");

       const result2 = calculateRelativePath("src/adapters/shared/error-handling.ts", "src/utils");
       expect(result2).toBe("../../utils");
     });
  });

  describe("Import path detection and correction", () => {
    function shouldFixImportPath(filePath: string, currentImport: string): { shouldFix: boolean; correctPath?: string } {
      // Target directories that need fixing
      const targetDirs = ['errors', 'schemas', 'utils'];

                  // Check if this is an import we need to fix
      const importPattern = new RegExp('^(\\.\\./)+([a-zA-Z]+)(?:/.*)?$');
      const match = currentImport.match(importPattern);
      if (!match) return { shouldFix: false };

      const [, , targetDir] = match;
      if (!targetDirs.includes(targetDir)) return { shouldFix: false };

      // Calculate correct path based on directory structure
      const fromDir = path.dirname(filePath);
      const toDir = path.join('src', targetDir);
      const correctRelativePath = path.relative(fromDir, toDir).replace(/\\/g, '/');

      // Preserve any subpath from the original import
      const subPathPattern = new RegExp('^(\\.\\./)+[a-zA-Z]+');
      const subPath = currentImport.replace(subPathPattern, '');
      const correctPath = correctRelativePath + subPath;

      return {
        shouldFix: currentImport !== correctPath,
        correctPath: correctPath
      };
    }

    it("should detect incorrect import paths and suggest corrections", () => {
      // Test commands directory files (should use ../../)
      const cmd1 = shouldFixImportPath("src/commands/mcp/index.ts", "../../../utils/logger");
      expect(cmd1.shouldFix).toBe(true);
      expect(cmd1.correctPath).toBe("../../utils/logger");

      const cmd2 = shouldFixImportPath("src/commands/config/list.ts", "../../../utils/process");
      expect(cmd2.shouldFix).toBe(true);
      expect(cmd2.correctPath).toBe("../../utils/process");

             // Test domain session commands (3 levels deep - should use ../../../)
       const domain1 = shouldFixImportPath("src/domain/session/commands/get-command.ts", "../../errors/index");
       expect(domain1.shouldFix).toBe(true);
       expect(domain1.correctPath).toBe("../../../errors/index");

       // Test domain 2-level files (should use ../../)
       const domain2 = shouldFixImportPath("src/domain/git/clone-operations.ts", "../../../utils/logger");
       expect(domain2.shouldFix).toBe(true);
       expect(domain2.correctPath).toBe("../../utils/logger");

       // Test adapters directory files (2 levels deep - should use ../../)
       const adapter1 = shouldFixImportPath("src/adapters/mcp/session.ts", "../../../errors/index");
       expect(adapter1.shouldFix).toBe(true);
       expect(adapter1.correctPath).toBe("../../errors/index");
    });

    it("should not suggest changes for already correct paths", () => {
      const correct1 = shouldFixImportPath("src/commands/mcp/index.ts", "../../utils/logger");
      expect(correct1.shouldFix).toBe(false);

      const correct2 = shouldFixImportPath("src/domain/session/commands/get-command.ts", "../../../errors/index");
      expect(correct2.shouldFix).toBe(false);

             const correct3 = shouldFixImportPath("src/adapters/shared/error-handling.ts", "../../utils/logger");
       expect(correct3.shouldFix).toBe(false);
    });

    it("should not suggest changes for non-target imports", () => {
      const nonTarget1 = shouldFixImportPath("src/domain/session/commands/get-command.ts", "../types");
      expect(nonTarget1.shouldFix).toBe(false);

      const nonTarget2 = shouldFixImportPath("src/commands/mcp/index.ts", "../../mcp/server");
      expect(nonTarget2.shouldFix).toBe(false);

      const external = shouldFixImportPath("src/domain/session/commands/get-command.ts", "external-library");
      expect(external.shouldFix).toBe(false);
    });
  });

  describe("Real-world example verification", () => {
    it("should correctly fix the problematic files from our codebase", () => {
      // These are the actual problematic cases we just encountered
      const testCases = [
        {
          file: "src/commands/mcp/index.ts",
          incorrectImport: "../../../utils/logger",
          expectedCorrect: "../../utils/logger"
        },
        {
          file: "src/commands/config/list.ts",
          incorrectImport: "../../../utils/process",
          expectedCorrect: "../../utils/process"
        },
        {
          file: "src/mcp/tools/session.ts",
          incorrectImport: "../../../utils/logger",
          expectedCorrect: "../../utils/logger"
        },
        {
          file: "src/domain/session/commands/get-command.ts",
          incorrectImport: "../../errors/index",
          expectedCorrect: "../../../errors/index"
        },
                 {
           file: "src/domain/git/clone-operations.ts",
           incorrectImport: "../../../utils/logger",
           expectedCorrect: "../../utils/logger"
         }
      ];

      testCases.forEach(({ file, incorrectImport, expectedCorrect }) => {
        const fromDir = path.dirname(file);
                        const importPattern = new RegExp('^(\\.\\./)+([a-zA-Z]+)(?:/.*)?$');
        const targetMatch = incorrectImport.match(importPattern);
        expect(targetMatch).toBeTruthy();

        const [, , targetDir] = targetMatch!;
        const toDir = path.join('src', targetDir);
        const correctRelativePath = path.relative(fromDir, toDir).replace(/\\/g, '/');

        const subPathPattern = new RegExp('^(\\.\\./)+[a-zA-Z]+');
        const subPath = incorrectImport.replace(subPathPattern, '');
        const actualCorrect = correctRelativePath + subPath;

        expect(actualCorrect).toBe(expectedCorrect);
      });
    });
  });
});
