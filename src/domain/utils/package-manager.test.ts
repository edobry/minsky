import { describe, test, expect, beforeEach } from "bun:test";
import { detectPackageManager, getInstallCommand, installDependencies } from "./package-manager";
import type { PackageManagerDependencies } from "../../utils/package-manager";
import { createPartialMock } from "../../utils/test-utils/mocking";

describe("Package Manager Utilities with Dependency Injection", () => {
  let mockDeps: PackageManagerDependencies;

  beforeEach(() => {
    // Use established createPartialMock pattern instead of manual mock creation
    mockDeps = createPartialMock<PackageManagerDependencies>({
      fs: {
        existsSync: () => false, // Default: no files exist
      },
      process: {
        execSync: () => Buffer.from("Success"),
      },
      logger: {
        debug: () => {},
        error: () => {},
      },
    });
  });

  describe("detectPackageManager", () => {
    test("detects bun from bun.lock", () => {
      // Override specific method using established pattern
      mockDeps = createPartialMock<PackageManagerDependencies>({
        ...mockDeps,
        fs: {
          existsSync: (filepath: string) => filepath.includes("bun.lock"),
        },
      });

      const result = detectPackageManager("/fake/repo", mockDeps);
      expect(result).toBe("bun");
    });

    test("detects yarn from yarn.lock", () => {
      mockDeps = createPartialMock<PackageManagerDependencies>({
        ...mockDeps,
        fs: {
          existsSync: (filepath: string) => filepath.includes("yarn.lock"),
        },
      });

      const result = detectPackageManager("/fake/repo", mockDeps);
      expect(result).toBe("yarn");
    });

    test("detects pnpm from pnpm-lock.yaml", () => {
      mockDeps = createPartialMock<PackageManagerDependencies>({
        ...mockDeps,
        fs: {
          existsSync: (filepath: string) => filepath.includes("pnpm-lock.yaml"),
        },
      });

      const result = detectPackageManager("/fake/repo", mockDeps);
      expect(result).toBe("pnpm");
    });

    test("detects npm from package-lock.json", () => {
      mockDeps = createPartialMock<PackageManagerDependencies>({
        ...mockDeps,
        fs: {
          existsSync: (filepath: string) => filepath.includes("package-lock.json"),
        },
      });

      const result = detectPackageManager("/fake/repo", mockDeps);
      expect(result).toBe("npm");
    });

    test("defaults to npm if only package.json exists", () => {
      mockDeps = createPartialMock<PackageManagerDependencies>({
        ...mockDeps,
        fs: {
          existsSync: (filepath: string) => filepath.includes("package.json"),
        },
      });

      const result = detectPackageManager("/fake/repo", mockDeps);
      expect(result).toBe("npm");
    });

    test("returns undefined if no package files exist", () => {
      // Uses default mock that returns false for all files
      const result = detectPackageManager("/fake/repo", mockDeps);
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
      mockDeps = createPartialMock<PackageManagerDependencies>({
        ...mockDeps,
        fs: {
          existsSync: (filepath: string) => filepath.includes("package.json"),
        },
        process: {
          execSync: () => Buffer.from("Success"),
        },
      });

      const result = await installDependencies("/fake/repo", {}, mockDeps);
      expect(result.success).toBe(true);
    });

    test("uses provided package manager if specified", async () => {
      const result = await installDependencies(
        "/fake/repo",
        {
          packageManager: "bun",
          quiet: false,
        },
        mockDeps
      );

      expect(result.success).toBe(true);
    });

    test("handles no package manager detected", async () => {
      // Uses default mock that returns false for all files
      const result = await installDependencies("/fake/repo", {}, mockDeps);

      expect(result.success).toBe(false);
      expect(result.error).toBe("No package manager detected for this project");
    });

    test("handles unsupported package manager", async () => {
      const result = await installDependencies(
        "/fake/repo",
        {
          packageManager: "unknown" as any,
        },
        mockDeps
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("No package manager detected for this project");
    });

    test("handles installation errors", async () => {
      mockDeps = createPartialMock<PackageManagerDependencies>({
        ...mockDeps,
        fs: {
          existsSync: (filepath: string) => filepath.includes("package.json"),
        },
        process: {
          execSync: () => {
            throw new Error("Installation failed");
          },
        },
      });

      const result = await installDependencies("/fake/repo", {}, mockDeps);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Installation failed");
    });

    test("respects quiet option for stdio", async () => {
      let executedOptions: any = null;

      mockDeps = createPartialMock<PackageManagerDependencies>({
        ...mockDeps,
        fs: {
          existsSync: (filepath: string) => filepath.includes("package.json"),
        },
        process: {
          execSync: (command: string, options: any) => {
            executedOptions = options;
            return Buffer.from("Success");
          },
        },
      });

      await installDependencies("/fake/repo", { quiet: true }, mockDeps);

      expect(executedOptions.stdio).toBe("ignore");
    });

    test("uses inherit stdio when not quiet", async () => {
      let executedOptions: any = null;

      mockDeps = createPartialMock<PackageManagerDependencies>({
        ...mockDeps,
        fs: {
          existsSync: (filepath: string) => filepath.includes("package.json"),
        },
        process: {
          execSync: (command: string, options: any) => {
            executedOptions = options;
            return Buffer.from("Success");
          },
        },
      });

      await installDependencies("/fake/repo", { quiet: false }, mockDeps);

      expect(executedOptions.stdio).toBe("inherit");
    });
  });
});
