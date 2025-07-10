/**
 * BOUNDARY VALIDATION TEST RESULTS: fix-unused-variables-targeted.ts
 * 
 * DECISION: ❌ REMOVE IMMEDIATELY - CRITICALLY DANGEROUS
 * 
 * === STEP 1: REVERSE ENGINEERING ANALYSIS ===
 * 
 * Codemod Claims:
 * - Purpose: Fix unused variables through targeted cleanup patterns
 * - Targets: Remove `___error`, `___err`, `___e` declarations; convert catch blocks; prefix unused parameters
 * - Method: 7 hardcoded regex patterns targeting specific variable names
 * - Scope: All TypeScript files in src/ (excluding tests)
 * 
 * === STEP 2: TECHNICAL ANALYSIS ===
 * 
 * CRITICAL SAFETY VIOLATIONS:
 * - HARDCODED VARIABLE ASSUMPTIONS: Assumes specific variable names are always unused
 * - NO USAGE ANALYSIS: Cannot verify if variables are actually used elsewhere
 * - PARAMETER PREFIXING WITHOUT VERIFICATION: Adds underscore prefixes without usage analysis
 * - CATCH BLOCK MODIFICATION: Converts catch blocks to parameterless without usage verification
 * - BULK PATTERN REPLACEMENT: 7 regex patterns without context validation
 * - NO SCOPE ANALYSIS: Cannot distinguish between used and unused variables
 * 
 * === STEP 3: TEST DESIGN ===
 * 
 * Boundary violation test cases designed to validate:
 * - Used error variables in catch blocks (should NOT be removed)
 * - Used function parameters (should NOT be prefixed)
 * - Same variable names in different scopes (should handle correctly)
 * - Error variables referenced after catch blocks (should NOT be removed)
 * - Mixed usage patterns (some used, some unused)
 * 
 * === STEP 4: BOUNDARY VALIDATION RESULTS ===
 * 
 * TEST EXECUTED: ✅ Codemod run on boundary violation test scenarios
 * CHANGES MADE: 12 variable modifications
 * COMPILATION ERRORS: ❌ Multiple undefined variable references created
 * 
 * CRITICAL FAILURES DISCOVERED:
 * 
 * 1. USED ERROR VARIABLE REMOVAL:
 *    - Removed `const ___error = new Error("test");` declarations
 *    - But code still references `___error.message` and `throw ___error`
 *    - Created undefined variable references
 * 
 * 2. CATCH BLOCK PARAMETER REMOVAL WITH USAGE:
 *    - Converted `catch (___error)` to parameterless `catch`
 *    - But code still references `___error` inside catch block
 *    - Created undefined variable references
 * 
 * 3. USED PARAMETER PREFIXING:
 *    - Added underscore prefix to `options` parameter: `(options: any)` → `(_options: any)`
 *    - But function body uses `options.value` - created undefined variable reference
 * 
 * 4. SCOPE-BLIND VARIABLE MODIFICATION:
 *    - Changed variables without understanding their actual usage context
 *    - No verification that variables are genuinely unused
 *    - Broke working code in multiple contexts
 * 
 * EVIDENCE OF DANGEROUS ASSUMPTIONS:
 * - Assumes specific variable names (___error, ___err, ___e) are always unused
 * - No verification of variable usage before removal/modification
 * - Assumes function parameters with specific names are always unused
 * - No scope analysis to prevent cross-scope conflicts
 * 
 * Performance Metrics:
 * - Files Processed: 1
 * - Changes Made: 12
 * - Compilation Errors Introduced: 8
 * - Success Rate: 0% (all changes broke working code)
 * - False Positive Rate: 100%
 * 
 * === STEP 5: DECISION AND DOCUMENTATION ===
 * 
 * ANTI-PATTERN CLASSIFICATION:
 * - PRIMARY: Variable Removal Without Usage Analysis
 * - SECONDARY: Hardcoded Variable Name Assumptions
 * - TERTIARY: Parameter Modification Without Scope Verification
 * 
 * This codemod demonstrates Task #178 Anti-Pattern: Variable Removal Without Usage Analysis
 * - Assumes specific variable names are always unused
 * - Removes/modifies variables without verification
 * - Creates compilation errors by breaking legitimate variable usage
 * - No scope analysis or conflict detection
 * 
 * RECOMMENDED ALTERNATIVE:
 * AST-based approach using ts-morph that:
 * 1. Analyzes actual variable usage in proper scope
 * 2. Verifies variables are genuinely unused before removal/modification
 * 3. Performs comprehensive scope analysis to prevent conflicts
 * 4. Validates transformations maintain code correctness
 * 
 * REMOVAL JUSTIFICATION:
 * This codemod violates the core principle of "never break working code" by making
 * dangerous assumptions about variable usage without proper analysis. All changes
 * were inappropriate and introduced compilation errors.
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

  // Fix patterns in order of frequency
  const fixes = [
    // 1. Remove unused ___error and ___err variable declarations (252 total)
    {
      pattern: /^\s*const\s+___error\s*=.*?;?\s*$/gm,
      replacement: "",
      description: "Remove unused ___error variable declarations"
    },
    {
      pattern: /^\s*const\s+___err\s*=.*?;?\s*$/gm,
      replacement: "",
      description: "Remove unused ___err variable declarations"
    },
    {
      pattern: /^\s*const\s+___e\s*=.*?;?\s*$/gm,
      replacement: "",
      description: "Remove unused ___e variable declarations"
    },
    
    // 2. Fix catch blocks with unused parameters (convert to parameterless catch)
    {
      pattern: /catch\s*\(\s*___error\s*\)/g,
      replacement: "catch",
      description: "Remove unused catch parameters (___error)"
    },
    {
      pattern: /catch\s*\(\s*___err\s*\)/g,
      replacement: "catch",
      description: "Remove unused catch parameters (___err)"
    },
    {
      pattern: /catch\s*\(\s*___e\s*\)/g,
      replacement: "catch",
      description: "Remove unused catch parameters (___e)"
    },

    // 3. Prefix unused function parameters with underscore (73 issues)
    {
      pattern: /(\([^)]*?)(\b(?:options|path|session|id|branch|repoPath|data)\b)(\s*:\s*[^,)]+)/g,
      replacement: "$1_$2$3",
      description: "Prefix unused function parameters with underscore"
    },
  ];

  for (const fix of fixes) {
    const matches = newContent.match(fix.pattern);
    if (matches) {
      newContent = newContent.replace(fix.pattern, fix.replacement);
      fileChanges += matches.length;
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
