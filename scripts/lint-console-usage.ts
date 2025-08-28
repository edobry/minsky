#!/usr/bin/env bun

/**
 * Console Usage Linter
 *
 * Detects and reports console.log/warn/error usage that could pollute test output.
 * Enforces proper logger usage and test-friendly patterns.
 */

import { existsSync, readFileSync } from "fs";
import { glob } from "glob";
import { join, relative } from "path";
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
    "node_modules/",
    "dist/",
    "build/",
    ".git/",
    "coverage/",
    // CLI tools that legitimately need console output
    "scripts/", // Scripts may use console for output
    // Setup files that announce their behavior
    "tests/setup.ts",
  ];

  // Allowed console usage patterns (with context)
  private readonly allowedPatterns = [
    /console\.error\(['"]Failed to import test monitoring data['"]/, // Test monitoring error
    /console\.warn\(['"]⚠️ Failed to load test monitoring data['"]/, // Test monitoring warning
    /console\.log\(['"]🔇 Global test setup['"]/, // Test setup announcement
    /console\.log\(['"]📊 Loaded existing test monitoring data['"]/, // CLI tool output
    // Add more specific allowed patterns as needed
  ];

  /** Determine if a filepath should be excluded */
  private isExcludedPath(file: string): boolean {
    const normalized = file.replace(/\\/g, "/");
    return this.excludePatterns.some((p) => normalized.includes(p));
  }

  /** Check if a console usage is allowed based on context */
  private isAllowedUsage(line: string, file: string): boolean {
    for (const pattern of this.allowedPatterns) {
      if (pattern.test(line)) return true;
    }
    // Allow console in certain file types/paths
    if (this.isExcludedPath(file)) return true;
    return false;
  }

  /** Determine severity based on file location and context */
  private getSeverity(file: string, method: string): ConsoleViolation["severity"] {
    const normalized = file.replace(/\\/g, "/");
    if (normalized.includes("/tests/") && !normalized.endsWith("/setup.ts")) return "error";
    if (normalized.includes("/src/"))
      return method === "log" || method === "info" ? "warning" : "error";
    return "info";
  }

  /** Suggest fix for violation */
  private getSuggestion(method: string, file: string): string {
    const normalized = file.replace(/\\/g, "/");
    if (normalized.includes("/tests/") && !normalized.endsWith("/setup.ts")) {
      return "Use mock logger utilities from tests/setup.ts instead";
    }
    if (normalized.includes("/src/")) {
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

  /** Scan a single file for console usage */
  private scanFile(filePath: string): void {
    if (!existsSync(filePath) || this.isExcludedPath(filePath)) return;
    try {
      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n");
      lines.forEach((line, lineIndex) => {
        const trimmedLine = line.trim();
        if (!trimmedLine || trimmedLine.startsWith("//") || trimmedLine.startsWith("*")) return;
        for (const pattern of this.consolePatterns) {
          pattern.lastIndex = 0;
          let match;
          while ((match = pattern.exec(line)) !== null) {
            const method = match[1];
            const column = match.index;
            if (this.isAllowedUsage(line, filePath)) continue;
            this.violations.push({
              file: relative(process.cwd(), filePath),
              line: lineIndex + 1,
              column: column + 1,
              method,
              content: trimmedLine,
              severity: this.getSeverity(filePath, method),
              suggestion: this.getSuggestion(method, filePath),
            });
          }
        }
      });
    } catch (error) {
      // keep silent in linter to avoid circular violation noise
    }
  }

  /** Prefer scanning staged files (pre-commit friendly). Fallback to full scan. */
  async scanProject(): Promise<void> {
    let stagedFiles: string[] = [];
    try {
      const out = execSync("git diff --name-only --cached", { encoding: "utf-8" }).trim();
      if (out) {
        stagedFiles = out
          .split("\n")
          .map((f) => f.trim())
          .filter((f) => !!f)
          .filter((f) => /\.(ts|js|tsx|jsx)$/.test(f))
          .map((f) => (f.startsWith("/") ? f : join(process.cwd(), f)))
          .filter((f) => !this.isExcludedPath(f));
      }
    } catch (error) {
      // Intentionally ignored: staged file detection failed (e.g., non-git env)
      // Make the block non-empty to satisfy eslint(no-empty)
      void error;
    }

    if (stagedFiles.length > 0) {
      for (const file of stagedFiles) this.scanFile(file);
      return;
    }

    // NEW: Only allow fallback when explicitly requested via flag or env var
    const argv = process.argv.slice(2);
    const allowFullScan =
      argv.includes("--full-scan") || process.env.CONSOLE_LINT_FULL_SCAN === "1";
    if (!allowFullScan) {
      // No staged files and no explicit full scan → treat as clean
      return;
    }

    // Fallback: Find all TS/JS files (CI or when explicitly requested)
    const patterns = ["**/*.ts", "**/*.js", "**/*.tsx", "**/*.jsx"];
    for (const pattern of patterns) {
      const files = await glob(pattern, {
        absolute: true,
        ignore: [
          "**/node_modules/**",
          "**/dist/**",
          "**/build/**",
          "**/.git/**",
          "**/coverage/**",
          "**/scripts/**",
          "**/tests/setup.ts",
        ],
      });
      for (const file of files) this.scanFile(file);
    }
  }

  generateReport() {
    const errorCount = this.violations.filter((v) => v.severity === "error").length;
    const warningCount = this.violations.filter((v) => v.severity === "warning").length;
    const infoCount = this.violations.filter((v) => v.severity === "info").length;
    const sorted = this.violations.sort((a, b) => {
      const order = { error: 3, warning: 2, info: 1 } as const;
      if (order[a.severity] !== order[b.severity]) return order[b.severity] - order[a.severity];
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
      violations: sorted,
      summary,
    };
  }

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
    report.violations.forEach((v) => {
      if (v.file !== currentFile) {
        currentFile = v.file;
        console.log(`\n📁 ${v.file}:`);
      }
      const icon = v.severity === "error" ? "🔴" : v.severity === "warning" ? "🟡" : "🔵";
      console.log(`  ${icon} Line ${v.line}:${v.column} - console.${v.method}()`);
      console.log(`     Code: ${v.content}`);
      if (v.suggestion) console.log(`     Fix:  ${v.suggestion}`);
      console.log("");
    });
    console.log("💡 RECOMMENDATIONS:\n");
    console.log("1. Replace console.* calls with proper logger usage");
    console.log("2. Use mock logger utilities in tests");
    console.log("3. Add allowed patterns for legitimate CLI output");
    console.log("4. Consider structured logging for better observability");
    console.log("\nSee docs/testing/global-test-setup.md for guidance");
  }
}

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
  --full-scan       Scan entire repo (by default only staged files are scanned)
  --help            Show this help message

EXAMPLES:
  bun scripts/lint-console-usage.ts                       # Scan staged files
  bun scripts/lint-console-usage.ts --full-scan           # Scan entire repo
  bun scripts/lint-console-usage.ts --fail-on-error       # Exit 1 if staged violations found
  bun scripts/lint-console-usage.ts --quiet               # Show only summary

PURPOSE:
  Prevents console noise pollution by detecting direct console usage
  that should be replaced with proper logger calls or test utilities.
`);
    process.exit(0);
  }

  const linter = new ConsoleUsageLinter();
  console.log("🔍 Scanning for console usage violations...");
  await linter.scanProject();

  if (!quiet) linter.printReport();
  const report = linter.generateReport();
  if (quiet && report.totalViolations > 0) console.log(report.summary);
  if (failOnError && report.errorCount > 0) {
    console.log("❌ Console usage violations found - failing build");
    process.exit(1);
  }
  if (report.totalViolations === 0) console.log("✅ No console usage violations found!");
}

if (import.meta.main) {
  main().catch(() => process.exit(1));
}
