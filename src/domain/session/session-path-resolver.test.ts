/**
 * Domain tests for SessionPathResolver
 * @migrated Converted from adapter tests to domain tests
 * @refactored Focuses on domain logic using actual class methods
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SessionPathResolver } from "./session-path-resolver";
import { createRobustTempDir } from "../../utils/tempdir";
import { writeFile, mkdir, rm } from "fs/promises";
import { join } from "path";
import { InvalidPathError } from "../workspace/workspace-backend";

describe("SessionPathResolver Domain Logic", () => {
  let tempDir: string;
  let sessionWorkspace: string;
  let resolver: SessionPathResolver;

  beforeEach(async () => {
    const tempDirResult = createRobustTempDir("minsky-test-", { softFail: true });
    if (!tempDirResult) {
      // Skip tests if temp directory creation fails
      console.warn("Skipping SessionPathResolver tests due to temp directory creation failure");
      return;
    }
    tempDir = tempDirResult;
    sessionWorkspace = join(tempDir, "session-workspace");
    await mkdir(sessionWorkspace, { recursive: true });

    // Create some test files and directories
    await mkdir(join(sessionWorkspace, "src"), { recursive: true });
    await mkdir(join(sessionWorkspace, "src", "components"), { recursive: true });
    await writeFile(join(sessionWorkspace, "package.json"), "{\"name\": \"test\"}");
    await writeFile(join(sessionWorkspace, "src", "index.ts"), "export default {};");

    resolver = new SessionPathResolver();
  });

  afterEach(async () => {
    // Clean up temporary directories to prevent resource leaks in full suite
    if (tempDir) {
      try {
        await rm(tempDir, { recursive: true, force: true });
      } catch (error) {
        // Ignore cleanup errors in tests
        console.warn("Failed to clean up temp directory:", error);
      }
    }
  });

  describe("validateAndResolvePath", () => {
    test("should validate and resolve relative paths correctly", () => {
      if (!tempDir) {
        console.warn("Skipping test due to temp directory creation failure");
        return;
      }
      const result = resolver.validateAndResolvePath(sessionWorkspace, "src/index.ts");
      expect(result).toBe(join(sessionWorkspace, "src", "index.ts"));
    });

    test("should validate and resolve dot paths correctly", () => {
      if (!tempDir) {
        console.warn("Skipping test due to temp directory creation failure");
        return;
      }
      const result = resolver.validateAndResolvePath(sessionWorkspace, "./src/index.ts");
      expect(result).toBe(join(sessionWorkspace, "src", "index.ts"));
    });

    test("should validate and resolve root path correctly", () => {
      if (!tempDir) {
        console.warn("Skipping test due to temp directory creation failure");
        return;
      }
      const result = resolver.validateAndResolvePath(sessionWorkspace, ".");
      expect(result).toBe(sessionWorkspace);
    });

    test("should block path traversal attempts", () => {
      if (!tempDir) {
        console.warn("Skipping test due to temp directory creation failure");
        return;
      }
      expect(() => {
        resolver.validateAndResolvePath(sessionWorkspace, "../../../etc/passwd");
      }).toThrow(InvalidPathError);
    });

    test("should block multiple path traversal attempts", () => {
      if (!tempDir) {
        console.warn("Skipping test due to temp directory creation failure");
        return;
      }
      expect(() => {
        resolver.validateAndResolvePath(sessionWorkspace, "src/../../../../../../tmp/malicious");
      }).toThrow(InvalidPathError);
    });

    test("should handle absolute paths within session workspace", () => {
      if (!tempDir) {
        console.warn("Skipping test due to temp directory creation failure");
        return;
      }
      const absolutePath = join(sessionWorkspace, "src", "index.ts");
      const result = resolver.validateAndResolvePath(sessionWorkspace, absolutePath);
      expect(result).toBe(absolutePath);
    });

    test("should block absolute paths outside session workspace", () => {
      if (!tempDir) {
        console.warn("Skipping test due to temp directory creation failure");
        return;
      }
      expect(() => {
        resolver.validateAndResolvePath(sessionWorkspace, "/etc/passwd");
      }).toThrow(InvalidPathError);
    });
  });

  describe("getRelativePathFromSession", () => {
    test("should return relative path from session root", () => {
      if (!tempDir) {
        console.warn("Skipping test due to temp directory creation failure");
        return;
      }
      const result = resolver.getRelativePathFromSession(sessionWorkspace, "src/index.ts");
      expect(result).toBe(join("src", "index.ts"));
    });

    test("should return dot for session root", () => {
      if (!tempDir) {
        console.warn("Skipping test due to temp directory creation failure");
        return;
      }
      const result = resolver.getRelativePathFromSession(sessionWorkspace, ".");
      expect(result).toBe(".");
    });

    test("should handle nested paths", () => {
      if (!tempDir) {
        console.warn("Skipping test due to temp directory creation failure");
        return;
      }
      const result = resolver.getRelativePathFromSession(sessionWorkspace, "src/components/Button.tsx");
      expect(result).toBe(join("src", "components", "Button.tsx"));
    });
  });

  describe("createSafePath", () => {
    test("should create safe path from components", () => {
      if (!tempDir) {
        console.warn("Skipping test due to temp directory creation failure");
        return;
      }
      const result = resolver.createSafePath(sessionWorkspace, "src", "components", "Button.tsx");
      expect(result).toBe(join(sessionWorkspace, "src", "components", "Button.tsx"));
    });

    test("should prevent unsafe path creation", () => {
      if (!tempDir) {
        console.warn("Skipping test due to temp directory creation failure");
        return;
      }
      expect(() => {
        resolver.createSafePath(sessionWorkspace, "..", "..", "etc", "passwd");
      }).toThrow(InvalidPathError);
    });
  });

  describe("validateMultiplePaths", () => {
    test("should validate multiple valid paths", () => {
      if (!tempDir) {
        console.warn("Skipping test due to temp directory creation failure");
        return;
      }
      const paths = ["src/index.ts", "package.json", "src/components"];
      const result = resolver.validateMultiplePaths(sessionWorkspace, paths);
      expect(result).toEqual([
        join(sessionWorkspace, "src", "index.ts"),
        join(sessionWorkspace, "package.json"),
        join(sessionWorkspace, "src", "components")
      ]);
    });

    test("should throw error when any path is invalid", () => {
      if (!tempDir) {
        console.warn("Skipping test due to temp directory creation failure");
        return;
      }
      const paths = ["src/index.ts", "../../../etc/passwd", "package.json"];
      expect(() => {
        resolver.validateMultiplePaths(sessionWorkspace, paths);
      }).toThrow(InvalidPathError);
    });
  });

  describe("normalizeRelativePath", () => {
    test("should normalize relative path correctly", () => {
      if (!tempDir) {
        console.warn("Skipping test due to temp directory creation failure");
        return;
      }
      const result = resolver.normalizeRelativePath(sessionWorkspace, "src/index.ts");
      expect(result).toBe(join("src", "index.ts"));
    });

    test("should prevent directory traversal in relative paths", () => {
      if (!tempDir) {
        console.warn("Skipping test due to temp directory creation failure");
        return;
      }
      expect(() => {
        resolver.normalizeRelativePath(sessionWorkspace, "../../../etc/passwd");
      }).toThrow(InvalidPathError);
    });
  });

  describe("absoluteToRelative", () => {
    test("should convert absolute path to relative", () => {
      if (!tempDir) {
        console.warn("Skipping test due to temp directory creation failure");
        return;
      }
      const absolutePath = join(sessionWorkspace, "src", "index.ts");
      const result = resolver.absoluteToRelative(sessionWorkspace, absolutePath);
      expect(result).toBe(join("src", "index.ts"));
    });

    test("should return null for paths outside session", () => {
      if (!tempDir) {
        console.warn("Skipping test due to temp directory creation failure");
        return;
      }
      const result = resolver.absoluteToRelative(sessionWorkspace, "/etc/passwd");
      expect(result).toBe(null);
    });

    test("should return dot for session root", () => {
      if (!tempDir) {
        console.warn("Skipping test due to temp directory creation failure");
        return;
      }
      const result = resolver.absoluteToRelative(sessionWorkspace, sessionWorkspace);
      expect(result).toBe(".");
    });
  });
}); 
