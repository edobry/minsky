/**
 * Package manager detection and dependency installation utilities
 */
import { join } from "path";
import { existsSync, readdirSync, readFileSync } from "fs";
import { execSync } from "child_process";
import { log } from "./logger";
import { getErrorMessage } from "../errors/index";

/**
 * Supported package manager types
 */
export type PackageManager = "bun" | "npm" | "yarn" | "pnpm" | undefined;

/**
 * Dependencies interface for package manager operations.
 *
 * `readdirSync` and `readFileSync` are used by `discoverNestedPackages`
 * (mt#1379) for nested-workspace install. They are optional on the
 * interface so existing callers of `installDependencies` /
 * `detectPackageManager` don't need to update — discovery falls back to
 * "no nested packages found" when either is absent.
 */
export interface PackageManagerDependencies {
  fs: {
    existsSync: (path: string) => boolean;
    readdirSync?: (path: string) => string[];
    readFileSync?: (path: string, encoding: BufferEncoding) => string;
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
    readdirSync,
    readFileSync,
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
    const errorMessage = getErrorMessage(error);

    if (!options.quiet && deps.logger) {
      deps.logger.error(`Failed to install dependencies: ${errorMessage}`);
    }

    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Parent directories scanned by `discoverNestedPackages`. Conservative on
 * purpose — limits the discovery surface and keeps `session_start` fast.
 * Adding a new monorepo layout (e.g., `apps/`, `tools/`) is a one-line
 * change here.
 *
 * Exported for tests and for monorepo configuration discoverability.
 */
export const NESTED_PACKAGE_PARENTS: readonly string[] = ["services", "packages"];

/**
 * Read the `workspaces` declarations from a root `package.json`. Returns
 * an empty array when the file is missing, malformed, or has no workspaces
 * field. Both the array form (`"workspaces": [...]`) and the object form
 * (`"workspaces": { "packages": [...] }`) are supported.
 *
 * Used by `discoverNestedPackages` to skip directories that the root
 * already manages — re-installing them would be a no-op at best and
 * potentially conflict with hoisted lockfiles at worst.
 *
 * Exported for tests.
 */
export function readRootWorkspacePatterns(
  repoPath: string,
  deps: PackageManagerDependencies = defaultPackageManagerDependencies
): string[] {
  const rootPackageJson = join(repoPath, "package.json");
  if (!deps.fs.existsSync(rootPackageJson) || !deps.fs.readFileSync) {
    return [];
  }
  try {
    const content = deps.fs.readFileSync(rootPackageJson, "utf-8");
    const parsed = JSON.parse(content) as {
      workspaces?: string[] | { packages?: string[] };
    };
    if (Array.isArray(parsed.workspaces)) {
      return parsed.workspaces;
    }
    if (
      parsed.workspaces &&
      typeof parsed.workspaces === "object" &&
      Array.isArray(parsed.workspaces.packages)
    ) {
      return parsed.workspaces.packages;
    }
    return [];
  } catch {
    // Malformed JSON or read failure: assume no workspaces declared.
    return [];
  }
}

/**
 * Check whether a directory path (relative to repoPath) is covered by any
 * of the workspace patterns declared in the root `package.json`. Supports
 * literal matches and trailing-`*` glob form (`services/*`).
 *
 * Exported for tests.
 */
export function isCoveredByWorkspacePattern(
  relativePath: string,
  patterns: readonly string[]
): boolean {
  for (const pattern of patterns) {
    if (pattern === relativePath) return true;
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -2);
      if (relativePath.startsWith(`${prefix}/`)) return true;
    }
  }
  return false;
}

/**
 * Discover nested package directories that should be installed alongside
 * the root. Scans `NESTED_PACKAGE_PARENTS` (`services/`, `packages/`) for
 * any immediate-child directory that contains its own `package.json` and
 * is NOT covered by a `workspaces` pattern in the root `package.json`.
 *
 * Returns absolute paths for each discovered nested package, in
 * deterministic order (parent-by-parent, alphabetical within each).
 *
 * Discovery is non-fatal: if `readdirSync` is unavailable on the deps
 * (e.g., a stripped-down test bundle) or if reading a parent throws, the
 * function returns whatever it has found so far rather than throwing.
 *
 * Exported for tests.
 */
export function discoverNestedPackages(
  repoPath: string,
  deps: PackageManagerDependencies = defaultPackageManagerDependencies
): string[] {
  if (!deps.fs.readdirSync) {
    return [];
  }

  const declaredPatterns = readRootWorkspacePatterns(repoPath, deps);
  const found: string[] = [];

  for (const parent of NESTED_PACKAGE_PARENTS) {
    const parentPath = join(repoPath, parent);
    if (!deps.fs.existsSync(parentPath)) continue;

    let entries: string[];
    try {
      entries = deps.fs.readdirSync(parentPath);
    } catch {
      continue;
    }

    for (const entry of [...entries].sort()) {
      const candidatePath = join(parentPath, entry);
      const candidatePackageJson = join(candidatePath, "package.json");
      if (!deps.fs.existsSync(candidatePackageJson)) continue;
      const relPath = `${parent}/${entry}`;
      if (isCoveredByWorkspacePattern(relPath, declaredPatterns)) continue;
      found.push(candidatePath);
    }
  }

  return found;
}

/**
 * Install dependencies in every nested package discovered by
 * `discoverNestedPackages`. Best-effort: a failure in one nested install
 * is logged with the directory path and the orchestration continues to
 * the next package. Never throws — returns a structured summary instead
 * so the caller (`session_start`) can decide how to surface it.
 *
 * The package manager for each nested package is detected from its own
 * lockfile (or `packages.json`) — a nested package may use a different
 * package manager than the root, though this is unusual.
 *
 * Filed under mt#1379: prior to this helper, `services/reviewer/`'s deps
 * were silently uninstalled after `session_start`, causing the first
 * `bun test services/reviewer` to fail with `Cannot find module
 * '@octokit/auth-app'` until the agent ran a manual install.
 */
export async function installNestedDependencies(
  repoPath: string,
  options: {
    quiet?: boolean;
  } = {},
  deps: PackageManagerDependencies = defaultPackageManagerDependencies
): Promise<{
  attempted: number;
  succeeded: number;
  failed: number;
  results: Array<{ path: string; success: boolean; error?: string }>;
}> {
  const nested = discoverNestedPackages(repoPath, deps);
  const results: Array<{ path: string; success: boolean; error?: string }> = [];

  for (const nestedPath of nested) {
    // Best-effort: do NOT fail the parent flow if one nested package fails.
    let result: { success: boolean; output?: string; error?: string };
    try {
      result = await installDependencies(nestedPath, { quiet: options.quiet }, deps);
    } catch (err) {
      // installDependencies should already swallow errors and return them
      // in the result, but defend against future changes that might let
      // exceptions escape — the contract here is "never throws".
      result = { success: false, error: getErrorMessage(err) };
    }
    results.push({ path: nestedPath, success: result.success, error: result.error });
    if (!result.success && deps.logger) {
      const message = `[mt#1379] Nested install failed for ${nestedPath}: ${result.error ?? "unknown error"}`;
      // Use error level rather than debug — a failed nested install means
      // tests in that package will fail with misleading "Cannot find
      // module" errors until the user runs install manually.
      deps.logger.error(message);
    }
  }

  const succeeded = results.filter((r) => r.success).length;
  return {
    attempted: results.length,
    succeeded,
    failed: results.length - succeeded,
    results,
  };
}
