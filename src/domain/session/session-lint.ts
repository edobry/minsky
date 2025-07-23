/**
 * Session Lint Command
 *
 * Simple linting command that works with common project setups
 */

import { execAsync } from "../../utils/exec";
import { log } from "../../utils/logger";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

export interface SessionLintParams {
  fix?: boolean;
  quiet?: boolean;
  changed?: boolean;
  json?: boolean;
}

export interface SessionLintResult {
  success: boolean;
  output: string;
  errors: number;
  warnings: number;
  duration: number;
  command: string; // Include the actual command that was run
}

/**
 * Run lint command in the given workspace directory
 */
export async function sessionLint(
  workspaceDir: string,
  params: SessionLintParams = {}
): Promise<SessionLintResult> {
  const startTime = Date.now();

  log.debug("Running session lint", { workspaceDir, params });

  try {
    // Determine the best lint command to use
    const baseLintCommand = await determineLintCommand(workspaceDir);

    // Build full command with parameters
    const fullCommand = buildLintCommand(baseLintCommand, params);

    log.debug("Using lint command", { baseLintCommand, fullCommand });

    let output = "";
    let exitCode = 0;

    try {
      // Run lint command
      const result = await execAsync(fullCommand, {
        cwd: workspaceDir,
      });
      output = result.stdout + result.stderr;
      exitCode = 0;
    } catch (error: any) {
      // execAsync throws on non-zero exit codes, but we want to capture the output
      if (error.stdout || error.stderr) {
        output = (error.stdout || "") + (error.stderr || "");
        exitCode = error.code || 1;
      } else {
        throw error; // Re-throw if it's not a lint exit code error
      }
    }

    // Parse lint output for error/warning counts
    const { errors, warnings } = parseLintOutput(output);

    const duration = Date.now() - startTime;
    const success = exitCode === 0;

    log.debug("Session lint completed", {
      success,
      errors,
      warnings,
      duration,
      exitCode,
      command: fullCommand,
    });

    return {
      success,
      output,
      errors,
      warnings,
      duration,
      command: fullCommand,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    log.error("Session lint execution error", {
      error: error instanceof Error ? error.message : String(error),
      duration,
    });

    return {
      success: false,
      output: `Command execution failed: ${error instanceof Error ? error.message : String(error)}`,
      errors: 1,
      warnings: 0,
      duration,
      command: "unknown",
    };
  }
}

/**
 * Determine the best lint command for the project
 */
async function determineLintCommand(workspaceDir: string): Promise<string> {
  // First, check if package.json has a lint script
  const packageJsonPath = join(workspaceDir, "package.json");
  if (existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));

      // Check for common lint script names
      if (packageJson.scripts?.lint) {
        return "bun run lint";
      }
      if (packageJson.scripts?.["lint:check"]) {
        return "bun run lint:check";
      }
      if (packageJson.scripts?.eslint) {
        return "bun run eslint";
      }

      // Check if ESLint is available as a dependency
      const hasDeps = packageJson.dependencies || {};
      const hasDevDeps = packageJson.devDependencies || {};

      if (hasDevDeps.eslint || hasDeps.eslint) {
        // Project has ESLint, use it directly
        return "bunx eslint .";
      }
    } catch (error) {
      log.debug("Failed to parse package.json", { error });
    }
  }

  // Fallback: try common lint commands
  return "bunx eslint .";
}

/**
 * Build full lint command with parameters
 */
function buildLintCommand(baseLintCommand: string, params: SessionLintParams): string {
  let command = baseLintCommand;

  // Handle different command formats
  if (
    command.startsWith("bun run ") ||
    command.startsWith("npm run ") ||
    command.startsWith("yarn ")
  ) {
    // For npm/bun/yarn scripts, append flags after the script name
    if (params.fix) {
      command += " --fix";
    }
    if (params.quiet) {
      command += " --quiet";
    }
  } else {
    // For direct commands (like "eslint ." or "bunx eslint ."), append flags directly
    if (params.fix) {
      command += " --fix";
    }
    if (params.quiet) {
      command += " --quiet";
    }
  }

  return command;
}

/**
 * Parse lint output to extract error and warning counts
 * Works with ESLint and other common linters
 */
function parseLintOutput(output: string): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;

  // ESLint format: "✖ 35 problems (35 errors, 0 warnings)"
  const eslintSummaryMatch = output.match(/✖ (\d+) problems? \((\d+) errors?, (\d+) warnings?\)/);
  if (eslintSummaryMatch) {
    errors = parseInt(eslintSummaryMatch[2], 10);
    warnings = parseInt(eslintSummaryMatch[3], 10);
    return { errors, warnings };
  }

  // TSLint format: "ERROR: (typescript) ..."
  const tslintMatches = output.match(/ERROR:/g);
  if (tslintMatches) {
    errors = tslintMatches.length;
  }

  const tslintWarnings = output.match(/WARNING:/g);
  if (tslintWarnings) {
    warnings = tslintWarnings.length;
  }

  // If we found TSLint format, return early
  if (errors > 0 || warnings > 0) {
    return { errors, warnings };
  }

  // Standard format: count individual error/warning lines
  const lines = output.split("\n");
  for (const line of lines) {
    if (line.match(/^\s+\d+:\d+\s+error\s+/)) {
      errors++;
    } else if (line.match(/^\s+\d+:\d+\s+warning\s+/)) {
      warnings++;
    }
  }

  return { errors, warnings };
}

/**
 * Format lint results for display
 */
export function formatLintResults(result: SessionLintResult): string {
  const lines: string[] = [];

  lines.push("🔍 Session Lint Results");
  lines.push("");

  if (result.success) {
    lines.push("✅ All checks passed!");
  } else {
    lines.push(`❌ Found ${result.errors} errors and ${result.warnings} warnings`);
    lines.push("");

    if (result.output.trim()) {
      lines.push(result.output.trim());
    }
  }

  lines.push("");
  lines.push(`⚙️  Command: ${result.command}`);
  lines.push(`⏱️  Completed in ${result.duration}ms`);

  return lines.join("\n");
}
