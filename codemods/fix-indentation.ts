/**
 * ESLint Auto-Fix Codemod
 *
 * PROBLEM SOLVED:
 * Automatically fixes indentation and other ESLint fixable issues across the codebase
 * using ESLint's built-in --fix functionality. This addresses formatting inconsistencies
 * and code style violations that ESLint can automatically correct.
 *
 * EXACT SITUATION:
 * - Inconsistent indentation (tabs vs spaces, wrong spacing)
 * - Missing semicolons or trailing commas
 * - Incorrect quote usage (single vs double quotes)
 * - Spacing issues around operators, brackets, etc.
 * - Any other ESLint rules marked as "fixable"
 *
 * TRANSFORMATION APPLIED:
 * Runs `bun run lint --fix` command which:
 * - Applies all ESLint auto-fixable rules to the entire codebase
 * - Preserves code logic while fixing formatting and style issues
 * - Uses project's ESLint configuration for consistency
 *
 * CONFIGURATION:
 * - Uses project's existing ESLint configuration
 * - Processes all files covered by the lint script
 * - Applies only auto-fixable rules (no manual intervention required)
 *
 * SAFETY CONSIDERATIONS:
 * - Only applies ESLint auto-fixable rules (guaranteed safe transformations)
 * - Does not modify code logic, only formatting and style
 * - Uses project's established ESLint configuration
 * - Non-destructive - only fixes issues, doesn't remove code
 *
 * LIMITATIONS:
 * - Cannot fix ESLint errors that require manual intervention
 * - Depends on project's ESLint configuration being properly set up
 * - May not fix all formatting issues if not covered by ESLint rules
 * - ESLint process may exit with non-zero code even when fixes are applied
 */

import { execSync } from "child_process";

console.log("Running ESLint with --fix to automatically correct indentation and other fixable issues...");

try {
  // Run ESLint with --fix flag to automatically correct fixable issues
  const result = execSync("bun run lint --fix", { 
    encoding: "utf8",
    cwd: process.cwd()
  });
  
  console.log("ESLint --fix completed successfully");
  console.log(result);
} catch (error: any) {
  // ESLint returns non-zero exit code even when fixes are applied, so check the output
  if (error.stdout) {
    console.log("ESLint --fix applied fixes:");
    console.log(error.stdout);
  }
  if (error.stderr) {
    console.log("ESLint stderr:");
    console.log(error.stderr);
  }
  
  console.log("ESLint --fix process completed (may have fixed issues despite non-zero exit)");
} 
