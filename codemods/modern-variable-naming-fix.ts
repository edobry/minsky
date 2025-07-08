#!/usr/bin/env bun

import { VariableNamingCodemod } from "./utils/specialized-codemods";

/**
 * Modern Variable Naming Fix
 * 
 * This codemod demonstrates the new utilities framework approach
 * for fixing variable naming issues. It replaces the old 
 * fix-variable-naming-ast.ts with a much cleaner implementation.
 * 
 * Key Improvements:
 * - Uses standardized framework for consistent behavior
 * - Comprehensive error handling and reporting
 * - Performance monitoring built-in
 * - Follows Task #178 AST-first principles
 * - Much less code with better functionality
 */

async function main() {
  console.log("🎯 Modern Variable Naming Fix");
  console.log("Using the new codemod utilities framework");
  console.log("=" .repeat(50));

  // Configure the codemod
  const codemod = new VariableNamingCodemod({
    includePatterns: ["src/**/*.ts", "src/**/*.tsx"],
    excludePatterns: ["**/*.d.ts", "**/*.test.ts", "**/node_modules/**"],
    verbose: true,
    dryRun: false  // Set to true to see what would be changed without making changes
  });

  // Execute the codemod
  await codemod.execute();

  console.log("\n✅ Modern variable naming fix completed!");
  console.log("This replaces the old fix-variable-naming-ast.ts with a cleaner, more maintainable approach");
}

if (import.meta.main) {
  main().catch(console.error);
} 
