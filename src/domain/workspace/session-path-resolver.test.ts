import { describe, it, expect } from "bun:test";
import { SessionPathResolver } from "../session/session-path-resolver";
import { InvalidPathError } from "./workspace-backend";

describe("SessionPathResolver", () => {
  const resolver = new SessionPathResolver();
  const sessionDir = "/test/session/workspace";

  describe("validateAndResolvePath", () => {
    it("should resolve relative paths within session", () => {
      const result = resolver.validateAndResolvePath(sessionDir, "src/file.ts");
      expect(result).toBe("/test/session/workspace/src/file.ts");
    });

    it("should resolve current directory reference", () => {
      const result = resolver.validateAndResolvePath(sessionDir, "./src/file.ts");
      expect(result).toBe("/test/session/workspace/src/file.ts");
    });

    it("should throw error for path traversal outside session", () => {
      expect(() => {
        resolver.validateAndResolvePath(sessionDir, "../outside/file.ts");
      }).toThrow(InvalidPathError);
    });

    it("should throw error for absolute paths outside session", () => {
      expect(() => {
        resolver.validateAndResolvePath(sessionDir, "/outside/file.ts");
      }).toThrow(InvalidPathError);
    });

    it("should handle complex path traversal attempts", () => {
      expect(() => {
        resolver.validateAndResolvePath(sessionDir, "src/../../outside/file.ts");
      }).toThrow(InvalidPathError);
    });

    it("should allow absolute paths within session", () => {
      const result = resolver.validateAndResolvePath(sessionDir, "/test/session/workspace/src/file.ts");
      expect(result).toBe("/test/session/workspace/src/file.ts");
    });
  });

  describe("isPathWithinSession", () => {
    it("should return true for paths within session", () => {
      const result = resolver.isPathWithinSession(sessionDir, "/test/session/workspace/src/file.ts");
      expect(result).toBe(true);
    });

    it("should return false for paths outside session", () => {
      const result = resolver.isPathWithinSession(sessionDir, "/outside/file.ts");
      expect(result).toBe(false);
    });

    it("should return true for session root", () => {
      const result = resolver.isPathWithinSession(sessionDir, "/test/session/workspace");
      expect(result).toBe(true);
    });
  });

  describe("absoluteToRelative", () => {
    it("should convert absolute path to relative", () => {
      const result = resolver.absoluteToRelative(sessionDir, "/test/session/workspace/src/file.ts");
      expect(result).toBe("src/file.ts");
    });

    it("should return null for paths outside session", () => {
      const result = resolver.absoluteToRelative(sessionDir, "/outside/file.ts");
      expect(result).toBe(null);
    });

    it("should return '.' for session root", () => {
      const result = resolver.absoluteToRelative(sessionDir, "/test/session/workspace");
      expect(result).toBe(".");
    });
  });

  describe("getRelativePathFromSession", () => {
    it("should get relative path from user input", () => {
      const result = resolver.getRelativePathFromSession(sessionDir, "src/file.ts");
      expect(result).toBe("src/file.ts");
    });

    it("should normalize relative path from user input", () => {
      const result = resolver.getRelativePathFromSession(sessionDir, "./src/../src/file.ts");
      expect(result).toBe("src/file.ts");
    });

    it("should return '.' for session root reference", () => {
      const result = resolver.getRelativePathFromSession(sessionDir, ".");
      expect(result).toBe(".");
    });
  });

  describe("validateMultiplePaths", () => {
    it("should validate multiple valid paths", () => {
      const paths = ["src/file1.ts", "src/file2.ts", "docs/readme.md"];
      const result = resolver.validateMultiplePaths(sessionDir, paths);
      expect(result).toEqual([
        "/test/session/workspace/src/file1.ts",
        "/test/session/workspace/src/file2.ts",
        "/test/session/workspace/docs/readme.md",
      ]);
    });

    it("should throw error if any path is invalid", () => {
      const paths = ["src/file1.ts", "../outside/file.ts", "docs/readme.md"];
      expect(() => {
        resolver.validateMultiplePaths(sessionDir, paths);
      }).toThrow(InvalidPathError);
    });
  });

  describe("createSafePath", () => {
    it("should create safe path from components", () => {
      const result = resolver.createSafePath(sessionDir, "src", "components", "file.ts");
      expect(result).toBe("/test/session/workspace/src/components/file.ts");
    });

    it("should throw error for unsafe path components", () => {
      expect(() => {
        resolver.createSafePath(sessionDir, "..", "outside", "file.ts");
      }).toThrow(InvalidPathError);
    });
  });
}); 
