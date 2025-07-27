/**
 * Package manager detection and dependency installation utilities
 */
import { join } from "path";
import { existsSync } from "fs";
import { execSync } from "child_process";
import { log } from "./logger";
import { getErrorMessage } from "../errors/index";

/**
 * Supported package manager types
 */
export type PackageManager = "bun" | "npm" | "yarn" | "pnpm" | undefined;

/**
 * Dependencies interface for package manager operations
 */
export interface PackageManagerDependencies {
  fs: {
    existsSync: (path: string) => boolean;
  };
  process: {
    execSync: (
      command: string,
      options?: { cwd?: string; stdio?: string | string[] }
    ) => Buffer | null;
  };
  logger?: {
    debug: (message: string) => void;
    error: (message: string) => void;
  };
}

/**
 * Default dependencies using actual fs and child_process
 */
export const defaultPackageManagerDependencies: PackageManagerDependencies = {
  fs: {
    existsSync,
  },
  process: {
    execSync,
  },
  logger: log,
};

/**
 * Detects the package manager used in a repository based on lock files
 * @param repoPath Path to the repository
 * @param deps Dependencies for filesystem operations
 * @returns Detected package manager or undefined if not detected
 */
export function detectPackageManager(
  repoPath: string,
  deps: PackageManagerDependencies = defaultPackageManagerDependencies
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
 * @param options Configuration options
 * @param deps Dependencies for filesystem and process operations
 * @returns Result object with success status and output/error messages
 */
export async function installDependencies(
  repoPath: string,
  options: {
    packageManager?: PackageManager;
    quiet?: boolean;
  } = {},
  deps: PackageManagerDependencies = defaultPackageManagerDependencies
): Promise<{ success: boolean; output?: string; error?: string }> {
  try {
    // Detect or use provided package manager
    const detectedPackageManager = options.packageManager || detectPackageManager(repoPath, deps);

    if (!detectedPackageManager) {
      return {
        success: false,
        error: "No package manager detected for this project",
      };
    }

    const installCmd = getInstallCommand(detectedPackageManager);

    if (!installCmd) {
      return {
        success: false,
        error: `Unsupported package manager: ${detectedPackageManager}`,
      };
    }

    // Log installation start unless quiet
    if (!options.quiet && deps.logger) {
      deps.logger.debug(`Installing dependencies using ${detectedPackageManager}...`);
    }

    // Execute the install command
    const result = deps.process.execSync(installCmd, {
      cwd: repoPath,
      stdio: options.quiet ? "ignore" : "inherit",
    });

    // Handle the case where execSync returns null when stdio is "ignore"
    const output = result ? result.toString() : "";

    return { success: true, output };
  } catch (error) {
    const errorMessage = getErrorMessage(error as any);

    if (!options.quiet && deps.logger) {
      deps.logger.error(`Failed to install dependencies: ${errorMessage}`);
    }

    return {
      success: false,
      error: errorMessage,
    };
  }
}
