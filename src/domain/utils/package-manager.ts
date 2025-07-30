/**
 * Package manager detection and dependency installation utilities
 */
import { join } from "path";
import { existsSync } from "fs";
import { execSync } from "child_process";
import { log } from "./logger";
import { getErrorMessage } from "../errors/index";
import type { PackageManagerDependencies } from "../../utils/package-manager";

/**
 * Supported package manager types
 */
export type PackageManager = "bun" | "npm" | "yarn" | "pnpm" | undefined;

/**
 * Default dependencies using real filesystem and process operations
 */
export const createDefaultPackageManagerDependencies = (): PackageManagerDependencies => ({
  fs: {
    existsSync,
  },
  process: {
    execSync,
  },
  logger: {
    debug: log.debug,
    error: log.error,
  },
});

/**
 * Detects the package manager used in a repository based on lock files
 * @param repoPath Path to the repository
 * @param deps Dependency injection for fs operations
 * @returns Detected package manager or undefined if not detected
 */
export function detectPackageManager(
  repoPath: string,
  deps: PackageManagerDependencies = createDefaultPackageManagerDependencies()
): PackageManager {
  if (deps.fs.existsSync(join(repoPath, "bun.lock"))) {
    return "bun";
  }
  if (deps.fs.existsSync(join(repoPath, "yarn.lock"))) {
    return "yarn";
  }
  if (deps.fs.existsSync(join(repoPath, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (deps.fs.existsSync(join(repoPath, "package-lock.json"))) {
    return "npm";
  }
  if (deps.fs.existsSync(join(repoPath, "package.json"))) {
    return "npm"; // Default to npm if only package.json exists
  }
  return undefined; // Not a Node.js/Bun project
}

/**
 * Returns the install command for a package manager
 * @param packageManager Package manager type
 * @returns Install command string or undefined if not supported
 */
export function getInstallCommand(packageManager: PackageManager): string | undefined {
  switch (packageManager) {
    case "bun":
      return "bun install";
    case "npm":
      return "npm install";
    case "yarn":
      return "yarn";
    case "pnpm":
      return "pnpm install";
    default:
      return undefined;
  }
}

/**
 * Installs dependencies in a repository
 * @param repoPath Path to the repository
 * @param options Installation options
 * @param deps Dependency injection for fs and process operations
 * @returns Installation result
 */
export async function installDependencies(
  repoPath: string,
  options: {
    packageManager?: PackageManager;
    quiet?: boolean;
  } = {},
  deps: PackageManagerDependencies = createDefaultPackageManagerDependencies()
): Promise<{ success: boolean; error?: string }> {
  try {
    const packageManager = options.packageManager || detectPackageManager(repoPath, deps);

    if (!packageManager) {
      return {
        success: false,
        error: "No package manager detected for this project",
      };
    }

    const installCommand = getInstallCommand(packageManager);
    if (!installCommand) {
      return {
        success: false,
        error: "No package manager detected for this project",
      };
    }

    deps.logger?.debug(`Installing dependencies with ${packageManager} in ${repoPath}`);

    const stdio = options.quiet ? "ignore" : "inherit";
    deps.process.execSync(installCommand, {
      cwd: repoPath,
      stdio,
    });

    deps.logger?.debug(`Successfully installed dependencies with ${packageManager}`);
    return { success: true };
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    deps.logger?.error(`Failed to install dependencies: ${errorMessage}`);
    return {
      success: false,
      error: errorMessage,
    };
  }
}
