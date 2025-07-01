/**
 * PathResolver Service Tests
 * 
 * Tests for the extracted path resolution domain logic that was previously
 * embedded in the configuration system.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { PathResolver } from "../path-resolver";

describe("PathResolver", () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    // Save original environment
    originalEnv = {
      HOME: process.env.HOME,
      PROJECT_NAME: process.env.PROJECT_NAME,
    };
  });

  afterEach(() => {
    // Restore original environment
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  describe("expandPath", () => {
    test("should expand tilde paths", () => {
      const testDir = tmpdir();
      process.env.HOME = testDir;

      const result = PathResolver.expandPath("~/custom/sessions.db");
      expect(result).toBe(join(testDir, "custom", "sessions.db"));
    });

    test("should expand $HOME paths", () => {
      const testDir = tmpdir();
      process.env.HOME = testDir;

      const result = PathResolver.expandPath("$HOME/custom/sessions.db");
      expect(result).toBe(join(testDir, "custom", "sessions.db"));
    });

    test("should handle relative paths with base directory", () => {
      const baseDir = "/test/base";
      const result = PathResolver.expandPath("./sessions", baseDir);
      expect(result).toBe(join(baseDir, "sessions"));
    });

    test("should leave absolute paths unchanged", () => {
      const absolutePath = "/absolute/path/sessions.db";
      const result = PathResolver.expandPath(absolutePath);
      expect(result).toBe(absolutePath);
    });

    test("should expand environment variables in paths", () => {
      const testDir = tmpdir();
      process.env.HOME = testDir;
      process.env.PROJECT_NAME = "test-project";

      const result = PathResolver.expandPath("${HOME}/projects/${PROJECT_NAME}/sessions");
      expect(result).toBe(join(testDir, "projects", "test-project", "sessions"));
    });
  });

  describe("expandEnvironmentVariables", () => {
    test("should expand ${VAR} syntax", () => {
      process.env.HOME = "/home/user";
      process.env.PROJECT_NAME = "myproject";

      const result = PathResolver.expandEnvironmentVariables("${HOME}/projects/${PROJECT_NAME}/config");
      expect(result).toBe("/home/user/projects/myproject/config");
    });

    test("should expand $VAR syntax", () => {
      process.env.HOME = "/home/user";

      const result = PathResolver.expandEnvironmentVariables("$HOME/config");
      expect(result).toBe("/home/user/config");
    });

    test("should leave unexpanded variables as-is when not found", () => {
      delete process.env.NONEXISTENT_VAR;

      const result = PathResolver.expandEnvironmentVariables("${NONEXISTENT_VAR}/config");
      expect(result).toBe("${NONEXISTENT_VAR}/config");
    });

    test("should handle mixed expansion", () => {
      process.env.HOME = "/home/user";
      process.env.CONFIG_DIR = "configs";

      const result = PathResolver.expandEnvironmentVariables("${HOME}/$CONFIG_DIR/app.yaml");
      expect(result).toBe("/home/user/configs/app.yaml");
    });
  });

  describe("resolveConfigPath", () => {
    test("should resolve path with base directory", () => {
      const baseDir = "/test/base";
      const result = PathResolver.resolveConfigPath("sessions.db", baseDir);
      expect(result).toBe(join(baseDir, "sessions.db"));
    });

    test("should return fallback when path is undefined", () => {
      const baseDir = "/test/base";
      const fallback = "default.db";
      const result = PathResolver.resolveConfigPath(undefined, baseDir, fallback);
      expect(result).toBe(join(baseDir, "default.db"));
    });

    test("should return undefined when no path or fallback", () => {
      const baseDir = "/test/base";
      const result = PathResolver.resolveConfigPath(undefined, baseDir);
      expect(result).toBeUndefined();
    });

    test("should expand environment variables in path", () => {
      const testDir = tmpdir();
      process.env.HOME = testDir;
      const baseDir = "/test/base";

      const result = PathResolver.resolveConfigPath("${HOME}/sessions.db", baseDir);
      expect(result).toBe(join(testDir, "sessions.db"));
    });
  });
}); 
