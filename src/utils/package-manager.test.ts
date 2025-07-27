import { describe, test, expect, spyOn, beforeEach, afterEach, mock } from "bun:test";
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

import { detectPackageManager, getInstallCommand, installDependencies } from "./package-manager";

describe("Package Manager Utilities", () => {
  // Mock fs.existsSync
  let existsSyncMock = spyOn(fs, "existsSync");
  // Mock childProcess.execSync
  let execSyncMock = spyOn(childProcess, "execSync");

  beforeEach(() => {
    // Reset mocks before each test
    existsSyncMock = spyOn(fs, "existsSync");
    execSyncMock = spyOn(childProcess, "execSync");
  });

  afterEach(() => {
    // Clear mock calls after each test
    existsSyncMock.mockClear();
    execSyncMock.mockClear();
  });

  describe("detectPackageManager", () => {
    test("detects bun from bun.lock", () => {
      existsSyncMock = mock((filepath) => {
        if (filepath.toString().includes("bun.lock")) return true;
        return false;
      });

      const result = detectPackageManager("/fake/repo", {
        fs: { existsSync: existsSyncMock },
        process: { execSync: execSyncMock },
      });
      expect(result).toBe("bun");
    });

    test("detects yarn from yarn.lock", () => {
      existsSyncMock = mock((filepath) => {
        if (filepath.toString().includes("yarn.lock")) return true;
        return false;
      });

      const result = detectPackageManager("/fake/repo", {
        fs: { existsSync: existsSyncMock },
        process: { execSync: execSyncMock },
      });
      expect(result).toBe("yarn");
    });

    test("detects pnpm from pnpm-lock.yaml", () => {
      existsSyncMock = mock((filepath) => {
        if (filepath.toString().includes("pnpm-lock.yaml")) return true;
        return false;
      });

      const result = detectPackageManager("/fake/repo", {
        fs: { existsSync: existsSyncMock },
        process: { execSync: execSyncMock },
      });
      expect(result).toBe("pnpm");
    });

    test("detects npm from package-lock.json", () => {
      existsSyncMock = mock((filepath) => {
        if (filepath.toString().includes("package-lock.json")) return true;
        return false;
      });

      const result = detectPackageManager("/fake/repo", {
        fs: { existsSync: existsSyncMock },
        process: { execSync: execSyncMock },
      });
      expect(result).toBe("npm");
    });

    test("defaults to npm if only package.json exists", () => {
      existsSyncMock = mock((filepath) => {
        if (filepath.toString().includes("package.json")) return true;
        return false;
      });

      const result = detectPackageManager("/fake/repo", {
        fs: { existsSync: existsSyncMock },
        process: { execSync: execSyncMock },
      });
      expect(result).toBe("npm");
    });

    test("returns undefined if no package files exist", () => {
      existsSyncMock = mock(() => false);

      const result = detectPackageManager("/fake/repo", {
        fs: { existsSync: existsSyncMock },
        process: { execSync: execSyncMock },
      });
      expect(result).toBeUndefined();
    });
  });

  describe("getInstallCommand", () => {
    test("returns correct command for bun", () => {
      expect(getInstallCommand("bun")).toBe("bun install");
    });

    test("returns correct command for npm", () => {
      expect(getInstallCommand("npm")).toBe("npm install");
    });

    test("returns correct command for yarn", () => {
      expect(getInstallCommand("yarn")).toBe("yarn");
    });

    test("returns correct command for pnpm", () => {
      expect(getInstallCommand("pnpm")).toBe("pnpm install");
    });

    test("returns undefined for unknown package manager", () => {
      expect(getInstallCommand(undefined)).toBeUndefined();
    });
  });

  describe("installDependencies", () => {
    test("successfully installs dependencies", async () => {
      existsSyncMock = mock((filepath) => {
        if (filepath.toString().includes("package.json")) return true;
        return false;
      });

      execSyncMock = mock(() => Buffer.from("Success"));

      const result = await installDependencies(
        "/fake/repo",
        {},
        {
          fs: { existsSync: existsSyncMock },
          process: { execSync: execSyncMock },
        }
      );
      expect(result.success).toBe(true);
      expect(execSyncMock).toHaveBeenCalledWith("npm install", {
        cwd: "/fake/repo",
        stdio: "inherit",
      });
    });

    test("uses provided package manager if specified", async () => {
      execSyncMock = mock(() => Buffer.from("Success"));

      const result = await installDependencies(
        "/fake/repo",
        {
          packageManager: "bun",
        },
        {
          fs: { existsSync: existsSyncMock },
          process: { execSync: execSyncMock },
        }
      );

      expect(result.success).toBe(true);
      expect(execSyncMock).toHaveBeenCalledWith("bun install", {
        cwd: "/fake/repo",
        stdio: "inherit",
      });
    });

    test("handles no package manager detected", async () => {
      existsSyncMock = mock(() => false);

      const result = await installDependencies(
        "/fake/repo",
        {},
        {
          fs: { existsSync: existsSyncMock },
          process: { execSync: execSyncMock },
        }
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("No package manager detected for this project");
      expect(execSyncMock).not.toHaveBeenCalled();
    });

    test("handles unsupported package manager", async () => {
      const result = await installDependencies(
        "/fake/repo",
        {
          packageManager: undefined,
        },
        {
          fs: { existsSync: existsSyncMock },
          process: { execSync: execSyncMock },
        }
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("No package manager detected for this project");
      expect(execSyncMock).not.toHaveBeenCalled();
    });

    test("handles installation errors", async () => {
      existsSyncMock = mock((filepath) => {
        if (filepath.toString().includes("package.json")) return true;
        return false;
      });

      execSyncMock = mock(() => {
        throw new Error("Installation failed");
      });

      const result = await installDependencies(
        "/fake/repo",
        {},
        {
          fs: { existsSync: existsSyncMock },
          process: { execSync: execSyncMock },
        }
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("Installation failed");
    });

    test("respects quiet option for stdio", async () => {
      existsSyncMock = mock((filepath) => {
        if (filepath.toString().includes("package.json")) return true;
        return false;
      });

      execSyncMock = mock(() => Buffer.from("Success"));

      await installDependencies(
        "/fake/repo",
        { quiet: true },
        {
          fs: { existsSync: existsSyncMock },
          process: { execSync: execSyncMock },
        }
      );

      expect(execSyncMock).toHaveBeenCalledWith("npm install", {
        cwd: "/fake/repo",
        stdio: "ignore",
      });
    });
  });
});
