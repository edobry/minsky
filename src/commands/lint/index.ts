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

interface LintOptions {
  json?: boolean;
  summary?: boolean;
  quiet?: boolean;
  threshold?: number;
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
 * Run ESLint and parse JSON results
 */
function runESLint(): ESLintResult[] {
  try {
    const output = execSync("bun run lint -- --format json", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    
    return JSON.parse(output);
  } catch (error: any) {
    // ESLint exits with non-zero when issues found, but still outputs JSON
    if (error.stdout) {
      try {
        return JSON.parse(error.stdout);
      } catch {
        // Fall back to empty results if JSON parsing fails
        return [];
      }
    }
    
    log.cliError("Failed to run ESLint");
    log.debug(`ESLint error: ${error.message}`);
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
  return Object.fromEntries(
    Object.entries(ruleCount).sort(([,a], [,b]) => b - a)
  );
}

/**
 * Output results in human-readable format
 */
function outputHumanReadable(results: ESLintResult[], summary: LintSummary, options: LintOptions): void {
  const statusIcon = summary.status === "pass" ? "✅" : "❌";
  const statusText = summary.status === "pass" ? "PASS" : "FAIL";
  
  if (!options.quiet) {
    console.log("🔍 ESLint Results");
    console.log(`├─ Errors: ${summary.errorCount}`);
    console.log(`├─ Warnings: ${summary.warningCount}`);
    console.log(`├─ Files: ${summary.totalFiles}`);
    console.log(`└─ Status: ${statusIcon} ${statusText}`);
    
    if (summary.warningCount > 0) {
      console.log(`   Warning threshold: ${summary.warningCount}/${summary.threshold}`);
    }
    
    // Show top rule violations if not quiet
    const ruleBreakdown = generateRuleBreakdown(results);
    const topRules = Object.entries(ruleBreakdown).slice(0, 5);
    
    if (topRules.length > 0) {
      console.log("\nTop Issues:");
      for (const [rule, count] of topRules) {
        console.log(`  • ${rule}: ${count} violation${count > 1 ? 's' : ''}`);
      }
    }
  } else {
    // Quiet mode: just status
    console.log(`${statusText}: Errors: ${summary.errorCount}, Warnings: ${summary.warningCount}`);
  }
}

/**
 * Output results in JSON format
 */
function outputJson(results: ESLintResult[], summary: LintSummary): void {
  const ruleBreakdown = generateRuleBreakdown(results);
  
  const output = {
    summary,
    rules: ruleBreakdown,
    files: results.map(result => ({
      path: result.filePath,
      errorCount: result.errorCount,
      warningCount: result.warningCount,
      messages: result.messages,
    })),
  };
  
  console.log(JSON.stringify(output, null, 2));
}

/**
 * Create the lint command
 */
export function createLintCommand(): Command {
  const lintCmd = new Command("lint")
    .description("Run ESLint and show structured results with quality gates")
    .option("--json", "Output results in JSON format")
    .option("--summary", "Show only summary counts")
    .option("-q, --quiet", "Minimal output (summary only)")
    .option("--threshold <number>", "Warning threshold (default: 100)", "100")
    .addHelpText(
      "after",
      `
Examples:
  minsky lint                    # Show detailed results
  minsky lint --json             # JSON output for tooling
  minsky lint --summary          # Just the counts
  minsky lint --quiet            # Minimal output
  minsky lint --threshold 50     # Custom warning threshold

Exit Codes:
  0: Clean (no errors, warnings under threshold)
  1: Errors found
  2: Too many warnings (over threshold)

The lint command uses the same quality gates as the pre-commit hook,
with a default threshold of 100 warnings.
`
    )
    .action(async (options: LintOptions) => {
      try {
        const threshold = parseInt(options.threshold?.toString() || "100");
        
        // Run ESLint and get results
        const results = runESLint();
        const summary = calculateSummary(results, threshold);
        
        // Output in requested format
        if (options.json) {
          outputJson(results, summary);
        } else if (options.summary || options.quiet) {
          console.log(`Errors: ${summary.errorCount}, Warnings: ${summary.warningCount}, Status: ${summary.status.toUpperCase()}`);
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
        exit(1);
      }
    });

  return lintCmd;
}
