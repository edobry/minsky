/**
 * BOUNDARY VALIDATION TEST RESULTS: fix-remaining-unused-vars.ts
 * 
 * DECISION: ❌ REMOVE IMMEDIATELY - CRITICALLY DANGEROUS
 * 
 * === STEP 1: REVERSE ENGINEERING ANALYSIS ===
 * 
 * Codemod Claims:
 * - Purpose: Fix remaining unused variables through targeted cleanup patterns
 * - Targets: Remove `___error` and `___e` declarations, convert catch blocks, prefix unused parameters
 * - Method: 7 regex patterns targeting hardcoded variable names (options, branch, content, command, args, ctx, workingDir, taskId)
 * - Scope: All TypeScript files in src/ (excluding tests)
 * 
 * === STEP 2: TECHNICAL ANALYSIS ===
 * 
 * CRITICAL SAFETY VIOLATIONS:
 * - NO USAGE ANALYSIS: Cannot verify if targeted variables are actually unused
 * - HARDCODED ASSUMPTIONS: Assumes specific variable names are always unused
 * - NO SCOPE VERIFICATION: Cannot distinguish between different variables with same name
 * - CONTEXT-BLIND REPLACEMENT: No understanding of variable usage or scope
 * - 7 REGEX PATTERNS: Complex interactions without validation
 * 
 * === STEP 3: TEST DESIGN ===
 * 
 * Boundary violation test cases created to validate:
 * - Actually used parameters (should NOT be changed)
 * - Used error variables in catch blocks (should NOT be converted to parameterless)
 * - Used destructured variables (should NOT be prefixed)
 * - Different scope same name variables (should handle correctly)
 * - Context blindness (comments/strings should not affect logic)
 * 
 * === STEP 4: BOUNDARY VALIDATION RESULTS ===
 * 
 * TEST EXECUTED: ✅ 19 changes made to boundary violation test file
 * COMPILATION ERRORS: ❌ Multiple undefined variable references created
 * 
 * CRITICAL FAILURES DISCOVERED:
 * 
 * 1. FALSE POSITIVE PARAMETER PREFIXING:
 *    - Changed `command: string` to `_command: string` but code uses `command`
 *    - Changed `options: any` to `_options: any` but code uses `options`
 *    - Created undefined variable references in function bodies
 * 
 * 2. DANGEROUS VARIABLE DECLARATION REMOVAL:
 *    - Removed `const ___error = new Error("test");` declarations
 *    - But code still references ___error.message - creates undefined variable error
 * 
 * 3. INCORRECT CATCH BLOCK CONVERSION:
 *    - Converted `catch (___error)` to parameterless `catch {`
 *    - But code still references ___error.message and throws ___error
 *    - Creates undefined variable references
 * 
 * 4. SCOPE VIOLATION ACROSS FUNCTIONS:
 *    - Prefixed parameters in functions where they are actually used
 *    - No analysis of whether variables are genuinely unused
 * 
 * EVIDENCE OF DANGEROUS ASSUMPTIONS:
 * - Assumes all instances of specific variable names are unused
 * - No verification of actual usage before modification
 * - Creates breaking changes in 100% of test cases
 * 
 * Performance Metrics:
 * - Files Processed: 1
 * - Changes Made: 19
 * - Compilation Errors Introduced: 10+
 * - Success Rate: 0% (all changes broke working code)
 * - False Positive Rate: 100%
 * 
 * === STEP 5: DECISION AND DOCUMENTATION ===
 * 
 * ANTI-PATTERN CLASSIFICATION:
 * - PRIMARY: Variable Renaming Without Usage Analysis
 * - SECONDARY: Hardcoded Pattern Assumptions
 * - TERTIARY: Bulk Pattern Replacement Without Context Analysis
 * 
 * This codemod demonstrates Task #178 Anti-Pattern: Variable Renaming Without Usage Analysis
 * - Assumes specific variable names are unused without verification
 * - Creates compilation errors by breaking legitimate variable usage
 * - No scope analysis or conflict detection
 * 
 * RECOMMENDED ALTERNATIVE:
 * AST-based approach using ts-morph that:
 * 1. Analyzes actual variable usage in proper scope
 * 2. Verifies parameters/variables are genuinely unused before modification  
 * 3. Performs scope-aware analysis to prevent cross-scope modifications
 * 4. Validates transformations don't break compilation
 * 
 * REMOVAL JUSTIFICATION:
 * This codemod is fundamentally unsafe and breaks the core principle of "never break working code".
 * All 19 changes were boundary violations that introduced compilation errors.
 */

import { readFileSync, writeFileSync } from "fs";
import { globSync } from "glob";

const files = globSync("src/**/*.ts", {
  ignore: ["**/*.test.ts", "**/*.spec.ts", "**/node_modules/**"],
});

let totalChanges = 0;
const changedFiles = new Set<string>();

for (const file of files) {
  const content = readFileSync(file, "utf8") as string;
  let newContent = content;
  let fileChanges = 0;

  // Enhanced unused variable cleanup
  const fixes = [
    // 1. Remove remaining ___error and ___e variable declarations
    {
      pattern: /^\s*const\s+___error\s*[=:][^;]*[;]?\s*$/gm,
      replacement: "",
      description: "Remove remaining ___error variable declarations"
    },
    {
      pattern: /^\s*const\s+___e\s*[=:][^;]*[;]?\s*$/gm,
      replacement: "",
      description: "Remove remaining ___e variable declarations"
    },
    
    // 2. Fix remaining catch blocks
    {
      pattern: /catch\s*\(\s*___error\s*\)\s*\{/g,
      replacement: "catch {",
      description: "Convert remaining catch blocks to parameterless"
    },
    {
      pattern: /catch\s*\(\s*___e\s*\)\s*\{/g,
      replacement: "catch {",
      description: "Convert remaining catch blocks to parameterless"
    },
    
    // 3. Prefix remaining unused function parameters
    {
      pattern: /(\([^)]*?)(\b(?:options|branch|content|command|args|ctx|workingDir|taskId)\b)(\s*[,:][^,)]+)/g,
      replacement: "$1_$2$3",
      description: "Prefix remaining unused function parameters"
    },
    
    // 4. Fix destructuring assignments with unused variables
    {
      pattern: /const\s*\{\s*([^}]*?)\b(options|branch|content|command|args|ctx|workingDir|taskId)\b([^}]*?)\s*\}/g,
      replacement: "const { $1_$2$3 }",
      description: "Prefix unused destructured variables"
    },
    
    // 5. Fix arrow function parameters
    {
      pattern: /(\([^)]*?)(\b(?:options|branch|content|command|args|ctx|workingDir|taskId)\b)(\s*(?::\s*[^,)]+)?)/g,
      replacement: "$1_$2$3",
      description: "Prefix unused arrow function parameters"
    }
  ];

  for (const fix of fixes) {
    const matches = newContent.match(fix.pattern);
    if (matches) {
      const beforeReplace = newContent;
      newContent = newContent.replace(fix.pattern, fix.replacement);
      // Only count if content actually changed
      if (newContent !== beforeReplace) {
        fileChanges += matches.length;
      }
    }
  }

  if (fileChanges > 0) {
    writeFileSync(file, newContent);
    changedFiles.add(file);
    totalChanges += fileChanges;
    console.log(`${file}: ${fileChanges} changes`);
  }
}

console.log(`\nTotal: ${totalChanges} changes across ${changedFiles.size} files`); 
