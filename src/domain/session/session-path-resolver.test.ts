/**
 * Domain tests for SessionPathResolver
 * @migrated Converted from adapter tests to domain tests
 * @refactored Focuses on domain logic using actual class methods
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { SessionPathResolver } from "./session-path-resolver";
import { createTempTestDir } from "../../utils/test-utils";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { InvalidPathError } from "../workspace/workspace-backend";

describe("SessionPathResolver Domain Logic", () => {
  let tempDir: string;
  let sessionWorkspace: string;
  let resolver: SessionPathResolver;

  beforeEach(async () => {
    const tempDirResult = createTempTestDir();
    if (!tempDirResult) {
      throw new Error("Failed to create temporary test directory");
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

  describe("validateAndResolvePath", () => {
    test("should validate and resolve relative paths correctly", () => {
      const result = resolver.validateAndResolvePath(sessionWorkspace, "src/index.ts");
      expect(result).toBe(join(sessionWorkspace, "src", "index.ts"));
    });

    test("should validate and resolve dot paths correctly", () => {
      const result = resolver.validateAndResolvePath(sessionWorkspace, "./src/index.ts");
      expect(result).toBe(join(sessionWorkspace, "src", "index.ts"));
    });

    test("should validate and resolve root path correctly", () => {
      const result = resolver.validateAndResolvePath(sessionWorkspace, ".");
      expect(result).toBe(sessionWorkspace);
    });

    test("should block path traversal attempts", () => {
      expect(() => {
        resolver.validateAndResolvePath(sessionWorkspace, "../../../etc/passwd");
      }).toThrow(InvalidPathError);
    });

    test("should block multiple path traversal attempts", () => {
      expect(() => {
        resolver.validateAndResolvePath(sessionWorkspace, "src/../../../../../../tmp/malicious");
      }).toThrow(InvalidPathError);
    });

    test("should handle absolute paths within session workspace", () => {
      const absolutePath = join(sessionWorkspace, "src", "index.ts");
      const result = resolver.validateAndResolvePath(sessionWorkspace, absolutePath);
      expect(result).toBe(absolutePath);
    });

    test("should block absolute paths outside session workspace", () => {
      expect(() => {
        resolver.validateAndResolvePath(sessionWorkspace, "/etc/passwd");
      }).toThrow(InvalidPathError);
    });
  });

  describe("getRelativePathFromSession", () => {
    test("should return relative path from session root", () => {
      const result = resolver.getRelativePathFromSession(sessionWorkspace, "src/index.ts");
      expect(result).toBe(join("src", "index.ts"));
    });

    test("should return dot for session root", () => {
      const result = resolver.getRelativePathFromSession(sessionWorkspace, ".");
      expect(result).toBe(".");
    });

    test("should handle nested paths", () => {
      const result = resolver.getRelativePathFromSession(sessionWorkspace, "src/components/Button.tsx");
      expect(result).toBe(join("src", "components", "Button.tsx"));
    });
  });

  describe("createSafePath", () => {
    test("should create safe path from components", () => {
      const result = resolver.createSafePath(sessionWorkspace, "src", "components", "Button.tsx");
      expect(result).toBe(join(sessionWorkspace, "src", "components", "Button.tsx"));
    });

    test("should prevent unsafe path creation", () => {
      expect(() => {
        resolver.createSafePath(sessionWorkspace, "..", "..", "etc", "passwd");
      }).toThrow(InvalidPathError);
    });
  });

  describe("validateMultiplePaths", () => {
    test("should validate multiple valid paths", () => {
      const paths = ["src/index.ts", "package.json", "src/components"];
      const result = resolver.validateMultiplePaths(sessionWorkspace, paths);
      expect(result).toEqual([
        join(sessionWorkspace, "src", "index.ts"),
        join(sessionWorkspace, "package.json"),
        join(sessionWorkspace, "src", "components")
      ]);
    });

    test("should throw error when any path is invalid", () => {
      const paths = ["src/index.ts", "../../../etc/passwd", "package.json"];
      expect(() => {
        resolver.validateMultiplePaths(sessionWorkspace, paths);
      }).toThrow(InvalidPathError);
    });
  });

  describe("normalizeRelativePath", () => {
    test("should normalize relative path correctly", () => {
      const result = resolver.normalizeRelativePath(sessionWorkspace, "src/index.ts");
      expect(result).toBe(join("src", "index.ts"));
    });

    test("should prevent directory traversal in relative paths", () => {
      expect(() => {
        resolver.normalizeRelativePath(sessionWorkspace, "../../../etc/passwd");
      }).toThrow(InvalidPathError);
    });
  });

  describe("absoluteToRelative", () => {
    test("should convert absolute path to relative", () => {
      const absolutePath = join(sessionWorkspace, "src", "index.ts");
      const result = resolver.absoluteToRelative(sessionWorkspace, absolutePath);
      expect(result).toBe(join("src", "index.ts"));
    });

    test("should return null for paths outside session", () => {
      const result = resolver.absoluteToRelative(sessionWorkspace, "/etc/passwd");
      expect(result).toBe(null);
    });

    test("should return dot for session root", () => {
      const result = resolver.absoluteToRelative(sessionWorkspace, sessionWorkspace);
      expect(result).toBe(".");
    });
  });
}); 
