import { describe, test, expect, mock } from "bun:test";
import {
  detectPackageManager,
  getInstallCommand,
  installDependencies,
  type PackageManagerDependencies,
} from "./package-manager";

describe("Package Manager Utilities", () => {
  describe("detectPackageManager", () => {
    test("detects bun from bun.lock", () => {
      const mockDeps: PackageManagerDependencies = {
        fs: {
          existsSync: mock((filepath: string) => {
            return filepath.includes("bun.lock");
          }),
        },
        process: {
          execSync: mock(() => Buffer.from("Success")),
        },
      };

      const result = detectPackageManager("/fake/repo", mockDeps);
      expect(result).toBe("bun");
    });

    test("detects yarn from yarn.lock", () => {
      const mockDeps: PackageManagerDependencies = {
        fs: {
          existsSync: mock((filepath: string) => {
            return filepath.includes("yarn.lock");
          }),
        },
        process: {
          execSync: mock(() => Buffer.from("Success")),
        },
      };

      const result = detectPackageManager("/fake/repo", mockDeps);
      expect(result).toBe("yarn");
    });

    test("detects pnpm from pnpm-lock.yaml", () => {
      const mockDeps: PackageManagerDependencies = {
        fs: {
          existsSync: mock((filepath: string) => {
            return filepath.includes("pnpm-lock.yaml");
          }),
        },
        process: {
          execSync: mock(() => Buffer.from("Success")),
        },
      };

      const result = detectPackageManager("/fake/repo", mockDeps);
      expect(result).toBe("pnpm");
    });

    test("detects npm from package-lock.json", () => {
      const mockDeps: PackageManagerDependencies = {
        fs: {
          existsSync: mock((filepath: string) => {
            return filepath.includes("package-lock.json");
          }),
        },
        process: {
          execSync: mock(() => Buffer.from("Success")),
        },
      };

      const result = detectPackageManager("/fake/repo", mockDeps);
      expect(result).toBe("npm");
    });

    test("defaults to npm if only package.json exists", () => {
      const mockDeps: PackageManagerDependencies = {
        fs: {
          existsSync: mock((filepath: string) => {
            return filepath.includes("package.json");
          }),
        },
        process: {
          execSync: mock(() => Buffer.from("Success")),
        },
      };

      const result = detectPackageManager("/fake/repo", mockDeps);
      expect(result).toBe("npm");
    });

    test("returns undefined if no package files exist", () => {
      const mockDeps: PackageManagerDependencies = {
        fs: {
          existsSync: mock(() => false),
        },
        process: {
          execSync: mock(() => Buffer.from("Success")),
        },
      };

      const result = detectPackageManager("/fake/repo", mockDeps);
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
      const mockDeps: PackageManagerDependencies = {
        fs: {
          existsSync: mock((filepath: string) => {
            return filepath.includes("package.json");
          }),
        },
        process: {
          execSync: mock(() => Buffer.from("Success")),
        },
        logger: {
          debug: mock(() => {}),
          error: mock(() => {}),
        },
      };

      const result = await installDependencies("/fake/repo", {}, mockDeps);
      expect(result.success).toBe(true);
      expect(mockDeps.process.execSync).toHaveBeenCalledWith("npm install", {
        cwd: "/fake/repo",
        stdio: "inherit",
      });
    });

    test("uses provided package manager if specified", async () => {
      const mockDeps: PackageManagerDependencies = {
        fs: {
          existsSync: mock(() => true),
        },
        process: {
          execSync: mock(() => Buffer.from("Success")),
        },
        logger: {
          debug: mock(() => {}),
          error: mock(() => {}),
        },
      };

      const result = await installDependencies(
        "/fake/repo",
        { packageManager: "yarn" },
        mockDeps
      );
      expect(result.success).toBe(true);
      expect(mockDeps.process.execSync).toHaveBeenCalledWith("yarn", {
        cwd: "/fake/repo",
        stdio: "inherit",
      });
    });

    test("handles installation errors", async () => {
      const mockDeps: PackageManagerDependencies = {
        fs: {
          existsSync: mock((filepath: string) => {
            return filepath.includes("package.json");
          }),
        },
        process: {
          execSync: mock(() => {
            throw new Error("Installation failed");
          }),
        },
        logger: {
          debug: mock(() => {}),
          error: mock(() => {}),
        },
      };

      const result = await installDependencies("/fake/repo", {}, mockDeps);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Installation failed");
    });

    test("respects quiet option for stdio", async () => {
      const mockDeps: PackageManagerDependencies = {
        fs: {
          existsSync: mock((filepath: string) => {
            return filepath.includes("package.json");
          }),
        },
        process: {
          execSync: mock(() => Buffer.from("Success")),
        },
        logger: {
          debug: mock(() => {}),
          error: mock(() => {}),
        },
      };

      const result = await installDependencies("/fake/repo", { quiet: true }, mockDeps);
      expect(result.success).toBe(true);
      expect(mockDeps.process.execSync).toHaveBeenCalledWith("npm install", {
        cwd: "/fake/repo",
        stdio: "ignore",
      });
    });
  });
});
