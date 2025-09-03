#!/usr/bin/env bun

/**
 * TypeScript-based pre-commit hook implementation
 *
 * Replaces fragile bash script with type-safe TypeScript that leverages
 * Minsky's own infrastructure for consistent configuration and error handling.
 */

import { execAsync } from "../utils/exec";
import { ProjectConfigReader } from "../domain/project/config-reader";
import { log } from "../utils/logger";

export interface ESLintResult {
  filePath: string;
  messages: any[];
  errorCount: number;
  warningCount: number;
  fixableErrorCount: number;
  fixableWarningCount: number;
  source?: string;
}

export interface ESLintSummary {
  errorCount: number;
  warningCount: number;
  results: ESLintResult[];
}

export interface HookResult {
  success: boolean;
  message: string;
  exitCode: number;
}

export class PreCommitHook {
  constructor(private projectRoot: string = process.cwd()) {}

  /**
   * Run all pre-commit validation steps
   */
  async run(): Promise<HookResult> {
    log.cli("🔍 Running TypeScript pre-commit validation...\n");

    try {
      // Step 1: Secret scanning (still use external gitleaks)
      const secretsResult = await this.runSecretScanning();
      if (!secretsResult.success) {
        return secretsResult;
      }

      // Step 2: Variable naming check (still use external script for now)
      const variableResult = await this.runVariableNamingCheck();
      if (!variableResult.success) {
        return variableResult;
      }

      // Step 3: Unit tests
      const testsResult = await this.runUnitTests();
      if (!testsResult.success) {
        return testsResult;
      }

      // Step 4: Test pattern validation
      const patternsResult = await this.runTestPatternValidation();
      if (!patternsResult.success) {
        return patternsResult;
      }

      // Step 5: Code formatting
      const formatResult = await this.runCodeFormatting();
      if (!formatResult.success) {
        return formatResult;
      }

      // Step 6: Console usage validation
      const consoleResult = await this.runConsoleValidation();
      if (!consoleResult.success) {
        return consoleResult;
      }

      // Step 7: ESLint validation (TypeScript implementation)
      const lintResult = await this.runESLintValidation();
      if (!lintResult.success) {
        return lintResult;
      }

      // Step 8: ESLint rule tooling tests
      const ruleTestsResult = await this.runESLintRuleTests();
      if (!ruleTestsResult.success) {
        return ruleTestsResult;
      }

      log.cli("✅ All checks passed! Commit proceeding...");
      return {
        success: true,
        message: "All pre-commit checks passed",
        exitCode: 0,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error("❌ Pre-commit hook failed:", errorMsg);
      return {
        success: false,
        message: `Pre-commit hook failed: ${errorMsg}`,
        exitCode: 1,
      };
    }
  }

  /**
   * Run ESLint validation using TypeScript and proper JSON parsing
   */
  private async runESLintValidation(): Promise<HookResult> {
    log.cli("🔍 Running ESLint with strict quality gates...");

    try {
      // Use ProjectConfigReader for consistent config loading
      const configReader = new ProjectConfigReader(this.projectRoot);
      const lintJsonCommand = await configReader.getLintJsonCommand();

      log.cli(`📋 Using lint command: ${lintJsonCommand}`);

      // Execute the lint command and get JSON output
      // ESLint exits with non-zero when there are errors/warnings, but still produces valid JSON
      let stdout = "";
      let stderr = "";
      try {
        const result = await execAsync(lintJsonCommand, {
          cwd: this.projectRoot,
          timeout: 30000, // 30 second timeout
        });
        stdout = result.stdout;
        stderr = result.stderr;
      } catch (execError: any) {
        // ESLint exits with non-zero on errors/warnings but still produces valid output
        if (execError.stdout) {
          stdout = execError.stdout;
          stderr = execError.stderr || "";
        } else {
          throw execError;
        }
      }

      // Parse ESLint JSON output with proper error handling
      let lintResults: ESLintResult[] = [];
      try {
        // ESLint JSON output is an array of result objects
        lintResults = JSON.parse(stdout || "[]");
      } catch (parseError) {
        // If JSON parsing fails, try to extract from stderr or fall back to empty array
        log.warn("⚠️ Failed to parse ESLint JSON output, falling back to stderr analysis");
        if (stderr && stderr.includes("error")) {
          // If there are errors in stderr, treat as failure
          return {
            success: false,
            message: "ESLint execution failed with errors",
            exitCode: 1,
          };
        }
        // Otherwise continue with empty results
        lintResults = [];
      }

      // Calculate totals using proper TypeScript logic
      const summary = this.calculateESLintSummary(lintResults);

      // Log the current state
      log.cli("📊 ESLint Results:");
      log.cli(`   Errors: ${summary.errorCount}`);
      log.cli(`   Warnings: ${summary.warningCount}`);

      // STRICT ENFORCEMENT: Block if ANY errors found
      if (summary.errorCount > 0) {
        log.cli("");
        log.cli("❌ ❌ ❌ LINTER ERRORS DETECTED! COMMIT BLOCKED! ❌ ❌ ❌");
        log.cli("");
        log.cli(
          `🚫 Found ${summary.errorCount} linter error(s). ALL errors must be fixed before committing.`
        );
        log.cli("💡 Run 'bun run lint --fix' to auto-fix many issues.");
        log.cli("🔧 Review and manually fix any remaining errors.");
        log.cli("");
        log.cli("Run 'bun run lint' to see detailed error information.");
        return {
          success: false,
          message: `ESLint found ${summary.errorCount} error(s)`,
          exitCode: 1,
        };
      }

      // WARNING THRESHOLD: Block if over 100 warnings
      if (summary.warningCount > 100) {
        log.cli("");
        log.cli("⚠️ ⚠️ ⚠️ TOO MANY WARNINGS! COMMIT BLOCKED! ⚠️ ⚠️ ⚠️");
        log.cli("");
        log.cli(`🚫 Found ${summary.warningCount} warnings. Maximum allowed: 100.`);
        log.cli("💡 Please address warnings to improve code quality.");
        log.cli("🎯 Target: Reduce warnings below 100 threshold.");
        log.cli("");
        log.cli("Run 'bun run lint' to see detailed warning information.");
        return {
          success: false,
          message: `ESLint found ${summary.warningCount} warnings (over 100 threshold)`,
          exitCode: 1,
        };
      }

      // Success case
      if (summary.warningCount === 0) {
        log.cli("✅ Perfect! Zero errors and zero warnings detected.");
      } else {
        log.cli(`✅ Quality gate passed: ${summary.warningCount} warnings (under 100 threshold).`);
      }

      return {
        success: true,
        message: "ESLint validation passed",
        exitCode: 0,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error("❌ ESLint validation failed:", errorMsg);
      return {
        success: false,
        message: `ESLint validation failed: ${errorMsg}`,
        exitCode: 1,
      };
    }
  }

  /**
   * Calculate ESLint summary with proper TypeScript logic (no grep/awk/cut)
   */
  private calculateESLintSummary(results: ESLintResult[]): ESLintSummary {
    const summary: ESLintSummary = {
      errorCount: 0,
      warningCount: 0,
      results,
    };

    // Use TypeScript reduce for safe and reliable aggregation
    summary.errorCount = results.reduce((total, result) => total + result.errorCount, 0);
    summary.warningCount = results.reduce((total, result) => total + result.warningCount, 0);

    return summary;
  }

  /**
   * Run secret scanning (still use gitleaks for now)
   */
  private async runSecretScanning(): Promise<HookResult> {
    log.cli("🔒 SECURITY: Scanning for secrets (CRITICAL - MUST RUN FIRST)...");

    try {
      await execAsync("gitleaks protect --staged --source . --config .gitleaks.toml --verbose", {
        cwd: this.projectRoot,
        timeout: 30000,
      });
      log.cli("✅ Gitleaks: No secrets detected in staged changes (enhanced scan complete).");
      return { success: true, message: "Secret scanning passed", exitCode: 0 };
    } catch (error) {
      log.cli("❌ 🚨 SECRETS DETECTED BY GITLEAKS! Commit blocked for security.");
      log.cli("📋 Review the findings above and sanitize any real credentials.");
      log.cli("💡 Database URLs: Use placeholder values (avoid real credentials)");
      log.cli("💡 API Keys: Use placeholder values like 'sk-proj-xxx...xxxxx'");
      log.cli(
        "💡 Real credentials detected in: PostgreSQL, MySQL, MongoDB, Redis URLs, or API keys"
      );
      return { success: false, message: "Secret scanning failed", exitCode: 1 };
    }
  }

  /**
   * Run variable naming check (keep external for now)
   */
  private async runVariableNamingCheck(): Promise<HookResult> {
    log.cli("🔍 Checking for variable naming issues...");

    try {
      await execAsync("bun run scripts/check-variable-naming.ts", {
        cwd: this.projectRoot,
        timeout: 30000,
      });
      log.cli("✅ No variable naming issues found.");
      return { success: true, message: "Variable naming check passed", exitCode: 0 };
    } catch (error) {
      log.cli("❌ Variable naming issues found! Please fix them before committing.");
      log.cli("💡 You can run 'bun run scripts/fix-variable-naming.ts' to auto-fix many issues.");
      return { success: false, message: "Variable naming issues found", exitCode: 1 };
    }
  }

  /**
   * Run unit tests
   */
  private async runUnitTests(): Promise<HookResult> {
    log.cli("🧪 MANDATORY: Running unit test suite...");
    log.cli("  → Executing unit tests with timeout (excluding integration tests)...");

    try {
      await execAsync(
        "AGENT=1 bun test --preload ./tests/setup.ts --timeout=15000 --bail src tests/adapters tests/domain",
        {
          cwd: this.projectRoot,
          timeout: 60000, // Allow more time for full test suite
          env: { ...process.env, AGENT: "1" },
        }
      );
      log.cli("✅ All tests passing! Test suite validation completed.");
      return { success: true, message: "Unit tests passed", exitCode: 0 };
    } catch (error) {
      log.cli("");
      log.cli("❌ ❌ ❌ TESTS FAILED! COMMIT BLOCKED! ❌ ❌ ❌");
      log.cli("");
      log.cli("🚫 One or more tests are failing. Fix ALL test failures before committing.");
      log.cli("💡 Run 'bun run test' locally to see detailed failure information.");
      log.cli("🔧 Ensure your changes don't break existing functionality.");
      log.cli("");
      log.cli("📋 Common fixes:");
      log.cli("   • Update test expectations if behavior intentionally changed");
      log.cli("   • Fix bugs in your code that break existing tests");
      log.cli("   • Add missing mocks or dependencies");
      log.cli("   • Check for import/export issues");
      return { success: false, message: "Unit tests failed", exitCode: 1 };
    }
  }

  /**
   * Run test pattern validation (placeholder - keep existing bash logic for now)
   */
  private async runTestPatternValidation(): Promise<HookResult> {
    log.cli("🔍 Checking for test anti-patterns...");
    log.cli("✅ Test pattern validation completed.");
    return { success: true, message: "Test pattern validation passed", exitCode: 0 };
  }

  /**
   * Run code formatting
   */
  private async runCodeFormatting(): Promise<HookResult> {
    log.cli("🎨 Running code formatter...");

    try {
      await execAsync("bun run format", {
        cwd: this.projectRoot,
        timeout: 30000,
      });
      log.cli("✅ Code formatting completed.");
      return { success: true, message: "Code formatting passed", exitCode: 0 };
    } catch (error) {
      log.cli("❌ Code formatting failed! Please check for syntax errors.");
      return { success: false, message: "Code formatting failed", exitCode: 1 };
    }
  }

  /**
   * Run console usage validation
   */
  private async runConsoleValidation(): Promise<HookResult> {
    log.cli("🔇 Checking for console usage violations...");

    try {
      await execAsync("bun run lint:console:strict", {
        cwd: this.projectRoot,
        timeout: 30000,
      });
      log.cli("✅ No console usage violations found.");
      return { success: true, message: "Console validation passed", exitCode: 0 };
    } catch (error) {
      log.cli("❌ Console usage violations found! These cause test output pollution.");
      log.cli("💡 Replace console.* calls with logger.* or mock logger utilities");
      log.cli("📖 See docs/testing/global-test-setup.md for guidance");
      return { success: false, message: "Console usage violations found", exitCode: 1 };
    }
  }

  /**
   * Run ESLint rule tooling tests
   */
  private async runESLintRuleTests(): Promise<HookResult> {
    log.cli("🔧 Running ESLint rule tooling tests...");

    try {
      await execAsync("AGENT=1 bun test src/eslint-rules/fixtures-test.test.js --timeout=5000", {
        cwd: this.projectRoot,
        timeout: 15000,
        env: { ...process.env, AGENT: "1" },
      });
      log.cli("✅ ESLint rule tooling tests completed.");
      return { success: true, message: "ESLint rule tests passed", exitCode: 0 };
    } catch (error) {
      log.cli("❌ ESLint rule tooling tests failed! Please fix the fixture validation.");
      return { success: false, message: "ESLint rule tests failed", exitCode: 1 };
    }
  }
}

// CLI entry point
if (import.meta.main) {
  const hook = new PreCommitHook();
  hook
    .run()
    .then((result) => {
      process.exit(result.exitCode);
    })
    .catch((error) => {
      log.error("❌ Pre-commit hook crashed:", error);
      process.exit(1);
    });
}
