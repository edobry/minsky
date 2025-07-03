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
 * Detects the package manager used in a repository based on lock files
 * @param repoPath Path to the repository
 * @returns Detected package manager or undefined if not detected
 */
export function detectPackageManager(repoPath: string): PackageManager {
  if (existsSync(join(repoPath, "bun.lock"))) {
    return "bun";
  }
  if (existsSync(join(repoPath, "yarn.lock"))) {
    return "yarn";
  }
  if (existsSync(join(repoPath, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (existsSync(join(repoPath, "package-lock.json"))) {
    return "npm";
  }
  if (existsSync(join(repoPath, "package.json"))) {
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
 * @returns Result object with success status and output/error messages
 */
export async function installDependencies(
  repoPath: string,
  options: {
    packageManager?: PackageManager;
    quiet?: boolean;
  } = {}
): Promise<{ success: boolean; output?: string; error?: string }> {
  try {
    // Detect or use provided package manager
    const detectedPackageManager = options.packageManager || detectPackageManager(repoPath);

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
    if (!options.quiet) {
      log.debug(`Installing dependencies using ${detectedPackageManager}...`);
    }

    // Execute the install command
    const result = execSync(installCmd, {
      cwd: repoPath,
      stdio: options.quiet ? "ignore" : "inherit",
    });

    // Handle the case where execSync returns null when stdio is "ignore"
    const output = result?.toString() || "";

    return { success: true, output };
  } catch (error) {
    const errorMessage = getErrorMessage(error);

    if (!options.quiet) {
      log.error(`Failed to install dependencies: ${errorMessage}`);
    }

    return {
      success: false,
      error: errorMessage,
    };
  }
}
