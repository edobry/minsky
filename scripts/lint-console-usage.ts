#!/usr/bin/env bun

/**
 * Console Usage Linter
 *
 * Detects and reports console.log/warn/error usage that could pollute test output.
 * Enforces proper logger usage and test-friendly patterns.
 */

import { existsSync, readFileSync } from "fs";
import { glob } from "glob";
import { join, relative, isAbsolute } from "path";
import { execSync } from "child_process";

interface ConsoleViolation {
  file: string;
  line: number;
  column: number;
  method: string;
  content: string;
  severity: "error" | "warning" | "info";
  suggestion?: string;
}

class ConsoleUsageLinter {
  private violations: ConsoleViolation[] = [];

  // Patterns that detect console usage
  private readonly consolePatterns = [
    /console\.(log|info|warn|error|debug|trace|dir|table|time|timeEnd|assert|count|group|groupEnd)\s*\(/g,
  ];

  // Files/directories to exclude from checking
  private readonly excludePatterns = [
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/.git/**",
    "**/coverage/**",
    // CLI tools that legitimately need console output
    "**/test-quality-cli.ts",
    "**/scripts/**", // Scripts may use console for output
    // Setup files that announce their behavior
    "**/tests/setup.ts",
    // Integration tests and test utilities - appropriate console usage for debugging
    "**/tests/integration/**",
    "**/tests/utils/**",
    "**/test-runner.ts",
    "**/test-monitor.ts",
    // Commands that legitimately need console output
    "**/src/commands/**",
    // Test utilities and test examples
    "**/session-test-utilities.ts",
    "**/variable-naming-fixer.test.ts",
    "**/consolidated-utilities/**",
    // MCP session tests with string literals containing console calls
    "**/session-edit-tools.test.ts",
  ];

  // Allowed console usage patterns (with context)
  private readonly allowedPatterns = [
    /console\.error\(['"]Failed to import test monitoring data['"]/, // Test monitoring error
    /console\.warn\(['"]⚠️ Failed to load test monitoring data['"]/, // Test monitoring warning
    // Console usage within string literals in tests (not actual console calls)
    /console\.log\(['"]old['"]/, // Test string literals
    /console\.log\(['"]new['"]/, // Test string literals
    /Mock cleanup for directory/, // Test utility cleanup logging
    /console\.log\(['"]🔇 Global test setup['"]/, // Test setup announcement
    /console\.log\(['"]📊 Loaded existing test monitoring data['"]/, // CLI tool output
    // Add more specific allowed patterns as needed
  ];

  /**
   * Check if a console usage is allowed based on context
   */
  private isAllowedUsage(line: string, file: string): boolean {
    // Check specific allowed patterns
    for (const pattern of this.allowedPatterns) {
      if (pattern.test(line)) {
        return true;
      }
    }

    // Allow console in certain file types
    if (file.includes("/scripts/") || file.endsWith("-cli.ts")) {
      return true;
    }

    // Allow in test setup file for announcing behavior
    if (file.endsWith("/tests/setup.ts")) {
      return true;
    }

    return false;
  }

  /**
   * Determine severity based on file location and context
   */
  private getSeverity(file: string, method: string): ConsoleViolation["severity"] {
    // Tests should NEVER use console directly - highest severity
    if (file.includes("/tests/") && !file.endsWith("/setup.ts")) {
      return "error";
    }

    // Application code should use logger - medium severity
    if (file.includes("/src/")) {
      return method === "log" || method === "info" ? "warning" : "error";
    }

    // Other files - low severity
    return "info";
  }

  /**
   * Get suggestion for fixing the violation
   */
  private getSuggestion(method: string, file: string): string {
    if (file.includes("/tests/") && !file.endsWith("/setup.ts")) {
      return "Use mock logger utilities from tests/setup.ts instead";
    }

    if (file.includes("/src/")) {
      const loggerMap: Record<string, string> = {
        log: "logger.info()",
        info: "logger.info()",
        warn: "logger.warn()",
        error: "logger.error()",
        debug: "logger.debug()",
      };

      return `Use ${loggerMap[method] || "logger.error()"} instead`;
    }

    return "Consider using structured logging instead";
  }

  /**
   * Scan a single file for console usage
   */
  private scanFile(filePath: string): void {
    if (!existsSync(filePath)) {
      return;
    }

    try {
      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n");

      lines.forEach((line, lineIndex) => {
        const trimmedLine = line.trim();

        // Skip empty lines and comments
        if (!trimmedLine || trimmedLine.startsWith("//") || trimmedLine.startsWith("*")) {
          return;
        }

        // Check for console usage
        for (const pattern of this.consolePatterns) {
          pattern.lastIndex = 0; // Reset regex state
          let match;

          while ((match = pattern.exec(line)) !== null) {
            const method = match[1];
            const column = match.index;

            // Check if this usage is allowed
            if (this.isAllowedUsage(line, filePath)) {
              continue;
            }

            const violation: ConsoleViolation = {
              file: relative(process.cwd(), filePath),
              line: lineIndex + 1,
              column: column + 1,
              method,
              content: trimmedLine,
              severity: this.getSeverity(filePath, method),
              suggestion: this.getSuggestion(method, filePath),
            };

            this.violations.push(violation);
          }
        }
      });
    } catch (error) {
      console.error(`Failed to scan file ${filePath}:`, error);
    }
  }

  /**
   * Scan all files in the project
   */
  async scanProject(): Promise<void> {
    // Prefer scanning ONLY staged files in git (pre-commit friendly)
    const stagedFiles = this.getStagedSourceFiles();

    if (stagedFiles.length > 0) {
      for (const file of stagedFiles) {
        this.scanFile(file);
      }
      return;
    }

    // Fallback: scan entire project when no staged files detected (CI or manual runs)
    const patterns = ["**/*.ts", "**/*.js", "**/*.tsx", "**/*.jsx"];
    for (const pattern of patterns) {
      const files = await glob(pattern, {
        ignore: this.excludePatterns,
        absolute: true,
      });
      for (const file of files) {
        this.scanFile(file);
      }
    }
  }

  /**
   * Get staged source files from git (ts/js/tsx/jsx), absolute paths
   */
  private getStagedSourceFiles(): string[] {
    try {
      const output = execSync("git diff --cached --name-only --diff-filter=ACMRTUXB", {
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      })
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);

      const exts = new Set([".ts", ".js", ".tsx", ".jsx"]);

      const files = output
        .filter((p) => exts.has(p.slice(p.lastIndexOf("."))))
        .map((p) => (isAbsolute(p) ? p : join(process.cwd(), p)));

      return files;
    } catch {
      return [];
    }
  }

  /**
   * Generate report of violations
   */
  generateReport(): {
    totalViolations: number;
    errorCount: number;
    warningCount: number;
    infoCount: number;
    violations: ConsoleViolation[];
    summary: string;
  } {
    const errorCount = this.violations.filter((v) => v.severity === "error").length;
    const warningCount = this.violations.filter((v) => v.severity === "warning").length;
    const infoCount = this.violations.filter((v) => v.severity === "info").length;

    // Sort by severity, then by file
    const sortedViolations = this.violations.sort((a, b) => {
      const severityOrder = { error: 3, warning: 2, info: 1 };
      if (severityOrder[a.severity] !== severityOrder[b.severity]) {
        return severityOrder[b.severity] - severityOrder[a.severity];
      }
      return a.file.localeCompare(b.file);
    });

    let summary = `Found ${this.violations.length} console usage violations:\n`;
    summary += `  🔴 ${errorCount} errors (must fix)\n`;
    summary += `  🟡 ${warningCount} warnings (should fix)\n`;
    summary += `  🔵 ${infoCount} info (consider fixing)\n`;

    return {
      totalViolations: this.violations.length,
      errorCount,
      warningCount,
      infoCount,
      violations: sortedViolations,
      summary,
    };
  }

  /**
   * Print detailed report
   */
  printReport(): void {
    const report = this.generateReport();

    console.log("\n🔍 CONSOLE USAGE LINT REPORT\n");
    console.log(report.summary);

    if (report.violations.length === 0) {
      console.log("✅ No console usage violations found!");
      return;
    }

    console.log("\nDETAILS:\n");

    let currentFile = "";
    report.violations.forEach((violation) => {
      if (violation.file !== currentFile) {
        currentFile = violation.file;
        console.log(`\n📁 ${violation.file}:`);
      }

      const icon =
        violation.severity === "error" ? "🔴" : violation.severity === "warning" ? "🟡" : "🔵";

      console.log(
        `  ${icon} Line ${violation.line}:${violation.column} - console.${violation.method}()`
      );
      console.log(`     Code: ${violation.content}`);
      if (violation.suggestion) {
        console.log(`     Fix:  ${violation.suggestion}`);
      }
      console.log("");
    });

    // Show recommendations
    console.log("💡 RECOMMENDATIONS:\n");
    console.log("1. Replace console.* calls with proper logger usage");
    console.log("2. Use mock logger utilities in tests");
    console.log("3. Add allowed patterns for legitimate CLI output");
    console.log("4. Consider structured logging for better observability");
    console.log("\nSee docs/testing/global-test-setup.md for guidance");
  }
}

/**
 * Main CLI function
 */
async function main() {
  const args = process.argv.slice(2);
  const isCI = process.env.CI === "true";
  const failOnError = args.includes("--fail-on-error") || isCI;
  const quiet = args.includes("--quiet");

  if (args.includes("--help")) {
    console.log(`
🔍 Console Usage Linter

USAGE:
  bun scripts/lint-console-usage.ts [options]

OPTIONS:
  --fail-on-error    Exit with error code if violations found (default in CI)
  --quiet           Only show summary, not detailed violations
  --help            Show this help message

EXAMPLES:
  bun scripts/lint-console-usage.ts                    # Show all violations
  bun scripts/lint-console-usage.ts --fail-on-error   # Exit 1 if violations found
  bun scripts/lint-console-usage.ts --quiet           # Show only summary

PURPOSE:
  Prevents console noise pollution by detecting direct console usage
  that should be replaced with proper logger calls or test utilities.
`);
    process.exit(0);
  }

  const linter = new ConsoleUsageLinter();

  console.log("🔍 Scanning for console usage violations...");
  await linter.scanProject();

  if (!quiet) {
    linter.printReport();
  }

  const report = linter.generateReport();

  if (quiet && report.totalViolations > 0) {
    console.log(report.summary);
  }

  // Exit with error code if violations found and fail-on-error is set
  if (failOnError && report.errorCount > 0) {
    console.log("❌ Console usage violations found - failing build");
    process.exit(1);
  }

  if (report.totalViolations === 0) {
    console.log("✅ No console usage violations found!");
  }
}

// Run if called directly
if (import.meta.main) {
  main().catch((error) => {
    console.error("❌ Linter failed:", error);
    process.exit(1);
  });
}
