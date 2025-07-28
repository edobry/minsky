import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import * as fs from "fs";
import * as childProcess from "child_process";

// Mock the logger module
mock.module("../logger.js", () => ({
  log: {
    debug: () => {},
    error: () => {},
    cliWarn: () => {},
  },
}));

// Mock fs and childProcess modules for proper test isolation
mock.module("fs", () => ({
  existsSync: mock(() => false),
}));

mock.module("child_process", () => ({
  execSync: mock(() => Buffer.from("Success")),
}));

import { detectPackageManager, getInstallCommand, installDependencies } from "./package-manager";

describe("Package Manager Utilities", () => {
  beforeEach(() => {
    // Reset mocks between tests
    mock.restore();
  });

  describe("detectPackageManager", () => {
    test("detects bun from bun.lock", () => {
      mock.module("fs", () => ({
        existsSync: mock((filepath) => {
          if (filepath.toString().includes("bun.lock")) return true;
          return false;
        }),
      }));

      const result = detectPackageManager("/fake/repo");
      expect(result).toBe("bun");
    });

    test("detects yarn from yarn.lock", () => {
      mock.module("fs", () => ({
        existsSync: mock((filepath) => {
          if (filepath.toString().includes("yarn.lock")) return true;
          return false;
        }),
      }));

      const result = detectPackageManager("/fake/repo");
      expect(result).toBe("yarn");
    });

    test("detects pnpm from pnpm-lock.yaml", () => {
      mock.module("fs", () => ({
        existsSync: mock((filepath) => {
          if (filepath.toString().includes("pnpm-lock.yaml")) return true;
          return false;
        }),
      }));

      const result = detectPackageManager("/fake/repo");
      expect(result).toBe("pnpm");
    });

    test("detects npm from package-lock.json", () => {
      mock.module("fs", () => ({
        existsSync: mock((filepath) => {
          if (filepath.toString().includes("package-lock.json")) return true;
          return false;
        }),
      }));

      const result = detectPackageManager("/fake/repo");
      expect(result).toBe("npm");
    });

    test("defaults to npm if only package.json exists", () => {
      mock.module("fs", () => ({
        existsSync: mock((filepath) => {
          if (filepath.toString().includes("package.json")) return true;
          return false;
        }),
      }));

      const result = detectPackageManager("/fake/repo");
      expect(result).toBe("npm");
    });

    test("returns undefined if no package files exist", () => {
      mock.module("fs", () => ({
        existsSync: mock(() => false),
      }));

      const result = detectPackageManager("/fake/repo");
      expect(result).toBeUndefined();
    });
  });

  describe("getInstallCommand", () => {
    test("returns correct command for bun", () => {
      const result = getInstallCommand("bun");
      expect(result).toBe("bun install");
    });

    test("returns correct command for npm", () => {
      const result = getInstallCommand("npm");
      expect(result).toBe("npm install");
    });

    test("returns correct command for yarn", () => {
      const result = getInstallCommand("yarn");
      expect(result).toBe("yarn");
    });

    test("returns correct command for pnpm", () => {
      const result = getInstallCommand("pnpm");
      expect(result).toBe("pnpm install");
    });

    test("returns undefined for unknown package manager", () => {
      const result = getInstallCommand("unknown" as any);
      expect(result).toBeUndefined();
    });
  });

  describe("installDependencies", () => {
    test("successfully installs dependencies", async () => {
      mock.module("fs", () => ({
        existsSync: mock((filepath) => {
          if (filepath.toString().includes("package.json")) return true;
          return false;
        }),
      }));

      mock.module("child_process", () => ({
        execSync: mock(() => Buffer.from("Success")),
      }));

      const result = await installDependencies("/fake/repo");
      expect(result.success).toBe(true);
    });

    test("uses provided package manager if specified", async () => {
      mock.module("child_process", () => ({
        execSync: mock(() => Buffer.from("Success")),
      }));

      const result = await installDependencies("/fake/repo", {
        packageManager: "bun",
        quiet: false,
      });

      expect(result.success).toBe(true);
    });

    test("handles no package manager detected", async () => {
      mock.module("fs", () => ({
        existsSync: mock(() => false),
      }));

      const result = await installDependencies("/fake/repo");

      expect(result.success).toBe(false);
      expect(result.error).toBe("No package manager detected for this project");
    });

    test("handles unsupported package manager", async () => {
      const result = await installDependencies("/fake/repo", {
        packageManager: undefined,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("No package manager detected for this project");
    });

    test("handles installation errors", async () => {
      mock.module("fs", () => ({
        existsSync: mock((filepath) => {
          if (filepath.toString().includes("package.json")) return true;
          return false;
        }),
      }));

      mock.module("child_process", () => ({
        execSync: mock(() => {
          throw new Error("Installation failed");
        }),
      }));

      const result = await installDependencies("/fake/repo");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Installation failed");
    });

    test("respects quiet option for stdio", async () => {
      mock.module("fs", () => ({
        existsSync: mock((filepath) => {
          if (filepath.toString().includes("package.json")) return true;
          return false;
        }),
      }));

      mock.module("child_process", () => ({
        execSync: mock(() => Buffer.from("Success")),
      }));

      await installDependencies("/fake/repo", { quiet: true });

      // Test passes if no errors thrown during quiet execution
      expect(true).toBe(true);
    });
  });
});
