/**
 * Session Lint Command
 *
 * Simple linting command that uses existing ESLint setup
 */

import { execAsync } from "../../utils/exec";
import { log } from "../../utils/logger";
import { MinskyError } from "../../errors";
import { existsSync } from "fs";
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
}

/**
 * Run ESLint in the given workspace directory
 */
export async function sessionLint(
  workspaceDir: string,
  params: SessionLintParams = {}
): Promise<SessionLintResult> {
  const startTime = Date.now();

  log.debug("Running session lint", { workspaceDir, params });

  // Check if ESLint config exists
  const eslintConfig = join(workspaceDir, ".eslintrc.json");
  if (!existsSync(eslintConfig)) {
    throw new MinskyError("No ESLint configuration found in session workspace");
  }

  try {
    // Build ESLint command
    const eslintCmd = buildESLintCommand(params);

    let output = "";
    let exitCode = 0;

    try {
      // Run ESLint
      const result = await execAsync(eslintCmd, {
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
        throw error; // Re-throw if it's not an ESLint exit code error
      }
    }

    // Parse ESLint output for error/warning counts
    const { errors, warnings } = parseESLintOutput(output);

    const duration = Date.now() - startTime;
    const success = exitCode === 0;

    log.debug("Session lint completed", {
      success,
      errors,
      warnings,
      duration,
      exitCode,
    });

    return {
      success,
      output,
      errors,
      warnings,
      duration,
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
    };
  }
}

/**
 * Build ESLint command based on parameters
 */
function buildESLintCommand(params: SessionLintParams): string {
  const parts = ["bun", "run", "lint"];

  if (params.fix) {
    parts.push("--fix");
  }

  if (params.quiet) {
    parts.push("--quiet");
  }

  return parts.join(" ");
}

/**
 * Parse ESLint output to extract error and warning counts
 */
function parseESLintOutput(output: string): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;

  // Look for ESLint summary line like "✖ 35 problems (35 errors, 0 warnings)"
  const summaryMatch = output.match(/✖ (\d+) problems? \((\d+) errors?, (\d+) warnings?\)/);
  if (summaryMatch) {
    errors = parseInt(summaryMatch[2], 10);
    warnings = parseInt(summaryMatch[3], 10);
    return { errors, warnings };
  }

  // Count individual error/warning lines
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
  lines.push(`⏱️  Completed in ${result.duration}ms`);

  return lines.join("\n");
}
