import { describe, test, expect, spyOn, beforeEach, afterEach, mock } from "bun:test";
import * as fs from "fs";
import * as childProcess from "child_process";
import * as path from "path";

// Mock the logger module
mock.module("../logger.js", () => ({
  log: {
    debug: () => {},
    error: () => {},
    cliWarn: () => {}
  }
}));

import { 
  detectPackageManager, 
  getInstallCommand, 
  installDependencies,
  type PackageManager
} from "../package-manager.js";

describe("Package Manager Utilities", () => {
  // Mock fs.existsSync
  const existsSyncMock = spyOn(fs, "existsSync");
  // Mock childProcess.execSync
  const execSyncMock = spyOn(childProcess, "execSync");

  beforeEach(() => {
    // Reset mocks before each test
    existsSyncMock.mockReset();
    execSyncMock.mockReset();
  });

  afterEach(() => {
    // Reset mocks after each test
    existsSyncMock.mockReset();
    execSyncMock.mockReset();
  });

  describe("detectPackageManager", () => {
    test("detects bun from bun.lockb", () => {
      existsSyncMock.mockImplementation((filepath) => {
        if (filepath.toString().includes("bun.lockb")) return true;
        return false;
      });

      const result = detectPackageManager("/fake/repo");
      expect(result).toBe("bun");
    });

    test("detects yarn from yarn.lock", () => {
      existsSyncMock.mockImplementation((filepath) => {
        if (filepath.toString().includes("yarn.lock")) return true;
        return false;
      });

      const result = detectPackageManager("/fake/repo");
      expect(result).toBe("yarn");
    });

    test("detects pnpm from pnpm-lock.yaml", () => {
      existsSyncMock.mockImplementation((filepath) => {
        if (filepath.toString().includes("pnpm-lock.yaml")) return true;
        return false;
      });

      const result = detectPackageManager("/fake/repo");
      expect(result).toBe("pnpm");
    });

    test("detects npm from package-lock.json", () => {
      existsSyncMock.mockImplementation((filepath) => {
        if (filepath.toString().includes("package-lock.json")) return true;
        return false;
      });

      const result = detectPackageManager("/fake/repo");
      expect(result).toBe("npm");
    });

    test("defaults to npm if only package.json exists", () => {
      existsSyncMock.mockImplementation((filepath) => {
        if (filepath.toString().includes("package.json")) return true;
        return false;
      });

      const result = detectPackageManager("/fake/repo");
      expect(result).toBe("npm");
    });

    test("returns undefined if no package files exist", () => {
      existsSyncMock.mockImplementation(() => false);

      const result = detectPackageManager("/fake/repo");
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
      existsSyncMock.mockImplementation((filepath) => {
        if (filepath.toString().includes("package.json")) return true;
        return false;
      });

      execSyncMock.mockImplementation(() => Buffer.from("Success"));

      const result = await installDependencies("/fake/repo");
      expect(result.success).toBe(true);
      expect(execSyncMock).toHaveBeenCalledWith("npm install", { 
        cwd: "/fake/repo", 
        stdio: "inherit" 
      });
    });

    test("uses provided package manager if specified", async () => {
      execSyncMock.mockImplementation(() => Buffer.from("Success"));

      const result = await installDependencies("/fake/repo", {
        packageManager: "bun"
      });
      
      expect(result.success).toBe(true);
      expect(execSyncMock).toHaveBeenCalledWith("bun install", { 
        cwd: "/fake/repo", 
        stdio: "inherit" 
      });
    });

    test("handles no package manager detected", async () => {
      existsSyncMock.mockImplementation(() => false);

      const result = await installDependencies("/fake/repo");
      
      expect(result.success).toBe(false);
      expect(result.error).toBe("No package manager detected for this project");
      expect(execSyncMock).not.toHaveBeenCalled();
    });

    test("handles unsupported package manager", async () => {
      const result = await installDependencies("/fake/repo", {
        packageManager: undefined
      });
      
      expect(result.success).toBe(false);
      expect(result.error).toBe("No package manager detected for this project");
      expect(execSyncMock).not.toHaveBeenCalled();
    });

    test("handles installation errors", async () => {
      existsSyncMock.mockImplementation((filepath) => {
        if (filepath.toString().includes("package.json")) return true;
        return false;
      });

      execSyncMock.mockImplementation(() => {
        throw new Error("Installation failed");
      });

      const result = await installDependencies("/fake/repo");
      
      expect(result.success).toBe(false);
      expect(result.error).toBe("Installation failed");
    });

    test("respects quiet option for stdio", async () => {
      existsSyncMock.mockImplementation((filepath) => {
        if (filepath.toString().includes("package.json")) return true;
        return false;
      });

      execSyncMock.mockImplementation(() => Buffer.from("Success"));

      await installDependencies("/fake/repo", { quiet: true });
      
      expect(execSyncMock).toHaveBeenCalledWith("npm install", { 
        cwd: "/fake/repo", 
        stdio: "ignore" 
      });
    });
  });
}); 
