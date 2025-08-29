/**
 * Lint command implementation
 *
 * Provides structured access to ESLint results with JSON output,
 * warning/error counts, and quality gate reporting.
 */

import { Command } from "commander";
import { execSync } from "child_process";
import { log } from "../../utils/logger";
import { exit } from "../../utils/process";
import { ProjectConfigReader } from "../../domain/project/config-reader";

interface LintOptions {
  json?: boolean;
  summary?: boolean;
  quiet?: boolean;
  threshold?: number;
  detect?: boolean;
  config?: string;
}

interface ESLintResult {
  filePath: string;
  messages: Array<{
    ruleId: string | null;
    severity: number;
    message: string;
    line: number;
    column: number;
  }>;
  errorCount: number;
  warningCount: number;
}

interface LintSummary {
  errorCount: number;
  warningCount: number;
  status: "pass" | "fail";
  threshold: number;
  totalFiles: number;
}

/**
 * Run linter and parse JSON results using project configuration
 */
async function runLinter(configReader: ProjectConfigReader): Promise<ESLintResult[]> {
  try {
    const lintJsonCommand = await configReader.getLintJsonCommand();
    log.debug(`Running lint command: ${lintJsonCommand}`);

    const output = execSync(lintJsonCommand, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      cwd: configReader["projectRoot"] || process.cwd(),
    });

    return JSON.parse(output);
  } catch (error: any) {
    // Linter exits with non-zero when issues found, but still outputs JSON
    if (error.stdout) {
      try {
        return JSON.parse(error.stdout);
      } catch {
        // Fall back to empty results if JSON parsing fails
        return [];
      }
    }

    log.cliError("Failed to run linter");
    log.debug(`Linter error: ${error.message}`);
    exit(1);
  }
}

/**
 * Calculate summary statistics from ESLint results
 */
function calculateSummary(results: ESLintResult[], threshold: number): LintSummary {
  const totalErrors = results.reduce((sum, result) => sum + result.errorCount, 0);
  const totalWarnings = results.reduce((sum, result) => sum + result.warningCount, 0);
  const totalFiles = results.length;

  // Status determination: fail if errors > 0 OR warnings > threshold
  const status = totalErrors > 0 || totalWarnings > threshold ? "fail" : "pass";

  return {
    errorCount: totalErrors,
    warningCount: totalWarnings,
    status,
    threshold,
    totalFiles,
  };
}

/**
 * Generate rule breakdown from results
 */
function generateRuleBreakdown(results: ESLintResult[]): Record<string, number> {
  const ruleCount: Record<string, number> = {};

  for (const result of results) {
    for (const message of result.messages) {
      if (message.ruleId) {
        ruleCount[message.ruleId] = (ruleCount[message.ruleId] || 0) + 1;
      }
    }
  }

  // Sort by count (descending)
  return Object.fromEntries(Object.entries(ruleCount).sort(([, a], [, b]) => b - a));
}

/**
 * Output results in human-readable format
 */
function outputHumanReadable(
  results: ESLintResult[],
  summary: LintSummary,
  options: LintOptions
): void {
  const statusIcon = summary.status === "pass" ? "✅" : "❌";
  const statusText = summary.status === "pass" ? "PASS" : "FAIL";

  if (!options.quiet) {
    log.cli("🔍 ESLint Results");
    log.cli(`├─ Errors: ${summary.errorCount}`);
    log.cli(`├─ Warnings: ${summary.warningCount}`);
    log.cli(`├─ Files: ${summary.totalFiles}`);
    log.cli(`└─ Status: ${statusIcon} ${statusText}`);

    if (summary.warningCount > 0) {
      log.cli(`   Warning threshold: ${summary.warningCount}/${summary.threshold}`);
    }

    // Show top rule violations if not quiet
    const ruleBreakdown = generateRuleBreakdown(results);
    const topRules = Object.entries(ruleBreakdown).slice(0, 5);

    if (topRules.length > 0) {
      log.cli("\nTop Issues:");
      for (const [rule, count] of topRules) {
        log.cli(`  • ${rule}: ${count} violation${count > 1 ? "s" : ""}`);
      }
    }
  } else {
    // Quiet mode: just status
    log.cli(`${statusText}: Errors: ${summary.errorCount}, Warnings: ${summary.warningCount}`);
  }
}

/**
 * Output configuration detection results
 */
async function outputConfigDetection(configReader: ProjectConfigReader): Promise<void> {
  const config = await configReader.getConfiguration();

  log.cli("🔍 Detected Configuration:");
  log.cli(`├─ Config Source: ${config.configSource}`);
  log.cli(`├─ Package Manager: ${config.runtime.packageManager || "unknown"}`);
  log.cli(`├─ Language: ${config.runtime.language || "unknown"}`);
  log.cli(`├─ Lint Command: ${config.workflows.lint || "none"}`);
  log.cli(`├─ Lint JSON Command: ${config.workflows.lintJson || "none"}`);
  log.cli(`└─ Lint Fix Command: ${config.workflows.lintFix || "none"}`);
}

/**
 * Output results in JSON format
 */
function outputJson(results: ESLintResult[], summary: LintSummary): void {
  const ruleBreakdown = generateRuleBreakdown(results);

  const output = {
    summary,
    rules: ruleBreakdown,
    files: results.map((result) => ({
      path: result.filePath,
      errorCount: result.errorCount,
      warningCount: result.warningCount,
      messages: result.messages,
    })),
  };

  log.cli(JSON.stringify(output, null, 2));
}

/**
 * Create the lint command
 */
export function createLintCommand(): Command {
  const lintCmd = new Command("lint")
    .description("Run linter and show structured results with quality gates (runtime-independent)")
    .option("--json", "Output results in JSON format")
    .option("--summary", "Show only summary counts")
    .option("-q, --quiet", "Minimal output (summary only)")
    .option("--threshold <number>", "Warning threshold (default: 100)", "100")
    .option("--detect", "Show detected configuration and exit")
    .option("--config <path>", "Override project root path for configuration detection")
    .addHelpText(
      "after",
      `
Examples:
  minsky lint                    # Show detailed results using auto-detected config
  minsky lint --json             # JSON output for tooling
  minsky lint --summary          # Just the counts
  minsky lint --quiet            # Minimal output
  minsky lint --threshold 50     # Custom warning threshold
  minsky lint --detect           # Show detected configuration
  minsky lint --config /path     # Use specific project path

Configuration Detection:
  1. minsky.json or .minsky/config.json (explicit workflows)
  2. package.json scripts (npm/yarn/pnpm/bun projects)
  3. Language-specific detection (Rust: cargo clippy, Go: golangci-lint)
  4. Generic defaults (eslint .)

Exit Codes:
  0: Clean (no errors, warnings under threshold)
  1: Errors found
  2: Too many warnings (over threshold)

The lint command automatically detects the appropriate linting tool
for each project, making it universal across different runtimes.
`
    )
    .action(async (options: LintOptions) => {
      try {
        // Initialize project configuration reader
        const projectRoot = options.config || process.cwd();
        const configReader = new ProjectConfigReader(projectRoot);

        // Handle --detect mode
        if (options.detect) {
          await outputConfigDetection(configReader);
          return; // Exit without running linter
        }

        const threshold = parseInt(options.threshold?.toString() || "100");

        // Run linter with auto-detected configuration
        const results = await runLinter(configReader);
        const summary = calculateSummary(results, threshold);

        // Output in requested format
        if (options.json) {
          outputJson(results, summary);
        } else if (options.summary || options.quiet) {
          log.cli(
            `Errors: ${summary.errorCount}, Warnings: ${summary.warningCount}, Status: ${summary.status.toUpperCase()}`
          );
        } else {
          outputHumanReadable(results, summary, options);
        }

        // Set exit code based on results
        if (summary.errorCount > 0) {
          exit(1); // Errors found
        } else if (summary.warningCount > threshold) {
          exit(2); // Too many warnings
        }
        // else: exit 0 (success)
      } catch (error: any) {
        log.cliError(`Lint command failed: ${error.message}`);
        log.debug(`Error details: ${error.stack}`);
        exit(1);
      }
    });

  return lintCmd;
}
