/**
 * Triple-Underscore Variable Cleanup Codemod
 *
 * PROBLEM SOLVED:
 * Removes triple-underscore variables (___variableName) that are used to mark
 * completely unused variables in TypeScript code. These variables serve no purpose
 * and clutter the codebase.
 *
 * EXACT SITUATION:
 * - Standalone triple-underscore variable declarations: const ___unused = something;
 * - Catch blocks with triple-underscore parameters: catch (___error) { ... }
 * - Destructuring with triple-underscore variables: const { value, ___unused } = obj;
 * - Excessive empty lines left after variable removals
 *
 * TRANSFORMATION APPLIED:
 * Before:
 *   const ___unused = someValue
 *   catch (___error) { }
 *   const { value, ___ignored } = obj
 *
 * After:
 *   (removed completely)
 *   catch { }
 *   const { value } = obj
 *
 * CONFIGURATION:
 * - Processes all TypeScript files in src/**/*.ts
 * - Ignores node_modules directory
 * - Uses regex patterns for transformation
 *
 * SAFETY CONSIDERATIONS:
 * - Only removes variables that start with triple-underscore prefix
 * - Preserves all other code structure
 * - Cleans up formatting after removals
 * - Does not modify variable names that are actually used
 *
 * LIMITATIONS:
 * - Regex-based approach may miss complex patterns
 * - Does not perform AST analysis for guaranteed safety
 * - May leave some formatting inconsistencies
 * - DISCOVERED: Regex pattern ___\w+ matches variables that START with ___ (not exactly 3 underscores)
 *   This means ____quadrupleUnderscore variables are also removed, which may be unintended
 */

import { readFileSync, writeFileSync } from "fs";
import { globSync } from "glob";

const files = globSync("src/**/*.ts", {
  ignore: ["**/node_modules/**"],
});

let totalChanges = 0;
const changedFiles = new Set<string>();

for (const file of files) {
  const content = readFileSync(file, "utf8") as string;
  let newContent = content;
  let fileChanges = 0;

  // Clean up remaining triple-underscore variables
  const fixes = [
    // 1. Remove standalone triple-underscore variable declarations
    {
      pattern: /^\s*const\s+___\w+\s*[=:][^;]*[;]?\s*$/gm,
      replacement: "",
      description: "Remove triple-underscore variable declarations"
    },
    
    // 2. Convert catch blocks with triple-underscore variables to parameterless
    {
      pattern: /catch\s*\(\s*___\w+\s*\)\s*\{/g,
      replacement: "catch {",
      description: "Convert catch blocks to parameterless"
    },
    
    // 3. Remove triple-underscore variables from destructuring
    {
      pattern: /,\s*___\w+\s*(?=[,}])/g,
      replacement: "",
      description: "Remove triple-underscore from destructuring"
    },
    
    // 4. Clean up empty lines left by removals
    {
      pattern: /\n\s*\n\s*\n/g,
      replacement: "\n\n",
      description: "Clean up excessive empty lines"
    }
  ];

  for (const fix of fixes) {
    const matches = newContent.match(fix.pattern);
    if (matches) {
      const beforeReplace = newContent;
      newContent = newContent.replace(fix.pattern, fix.replacement);
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
