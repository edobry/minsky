#!/usr/bin/env bun

/**
 * Simple Underscore Variable Fix Codemod
 *
 * PROBLEM SOLVED:
 * Removes unnecessary underscore prefixes from variable declarations when the 
 * variable is used elsewhere in the code without the underscore prefix.
 * This prevents "variable not defined" errors caused by underscore prefix mismatches.
 *
 * EXACT SITUATION:
 * - Variable declared as `_variableName` but used as `variableName`
 * - Results in "variable is not defined" errors
 * - Common in code where underscore prefix was added but usage wasn't updated
 * - Also handles function parameters, destructuring, and arrow functions
 *
 * TRANSFORMATION APPLIED:
 * - Scans for variables starting with underscore (_variable)
 * - Checks if clean version (variable) is used anywhere in the same file
 * - If clean version is used, removes underscore from all declarations
 * - Handles: const/let/var declarations, function parameters, destructuring, arrow functions
 *
 * CONFIGURATION:
 * - Processes all TypeScript files in src directory
 * - Ignores .d.ts declaration files
 * - Uses regex patterns to match various declaration contexts
 * - Per-file analysis (doesn't track cross-file usage)
 *
 * SAFETY CONSIDERATIONS:
 * - Only removes underscores when clean variable is actually used
 * - Preserves intentionally unused variables (no clean version usage)
 * - Multiple regex patterns to catch different declaration contexts
 * - File-by-file analysis to avoid unintended cross-file changes
 *
 * LIMITATIONS:
 * - **POTENTIAL BOUNDARY ISSUES**: Complex regex patterns may miss edge cases
 * - **STRING CONTEXT**: May incorrectly match variables in string literals or comments
 * - **SCOPE CONTEXT**: Doesn't understand variable scope, may make incorrect changes
 * - **CROSS-FILE**: Only analyzes usage within the same file
 * - **COMPLEX DESTRUCTURING**: May not handle deeply nested destructuring patterns
 * - **TEMPLATE LITERALS**: Regex patterns may not properly handle template literal contexts
 * - **ARROW FUNCTION EDGE CASES**: Arrow function parameter detection may miss complex cases
 * 
 * **REGEX COMPLEXITY**: Uses multiple overlapping regex patterns that may interact unexpectedly
 */

import { readFileSync, writeFileSync } from 'fs';
import { globSync } from 'glob';

/**
 * Simple underscore fix: Find variables with underscores, check if they're used without underscores,
 * and if so, remove the underscore from the declaration.
 * 
 * This is much simpler than trying to catch every usage pattern.
 */

const files = globSync('src/**/*.ts', { ignore: ['**/*.d.ts'] });
console.log(`🔧 Processing ${files.length} TypeScript files with simple underscore fix...`);

let totalChanges = 0;
let modifiedFiles = 0;

for (const file of files) {
  const content = readFileSync(file, 'utf-8');
  let newContent = content;
  let fileChanges = 0;

  // Find all variables that start with underscore
  const underscoreVariables = content.match(/\b_[a-zA-Z][a-zA-Z0-9]*/g) || [];
  const uniqueUnderscoreVars = [...new Set(underscoreVariables)];

  for (const underscoreVar of uniqueUnderscoreVars) {
    const cleanVar = underscoreVar.substring(1); // Remove the underscore
    
    // Check if the clean variable is used anywhere in the file
    const cleanVarRegex = new RegExp(`\\b${cleanVar}\\b`);
    if (cleanVarRegex.test(content)) {
      // The clean variable is used, so we should remove underscores from declarations
      
      // Remove underscores from all common declaration patterns
      const declarationPatterns = [
        // Variable declarations
        new RegExp(`\\bconst ${underscoreVar}\\b`, 'g'),
        new RegExp(`\\blet ${underscoreVar}\\b`, 'g'),
        new RegExp(`\\bvar ${underscoreVar}\\b`, 'g'),
        
        // Function parameters
        new RegExp(`\\(([^)]*)${underscoreVar}([^)]*)\\)`, 'g'),
        
        // Destructuring
        new RegExp(`\\{([^}]*)${underscoreVar}([^}]*)\\}`, 'g'),
        new RegExp(`\\[([^\\]]*)${underscoreVar}([^\\]]*)\\]`, 'g'),
        
        // Arrow function parameters
        new RegExp(`=>\\s*\\(([^)]*)${underscoreVar}([^)]*)\\)`, 'g'),
        new RegExp(`\\(([^)]*)${underscoreVar}([^)]*)\\)\\s*=>`, 'g'),
      ];

      for (const pattern of declarationPatterns) {
        const beforeReplace = newContent;
        newContent = newContent.replace(pattern, (match) => {
          return match.replace(new RegExp(underscoreVar, 'g'), cleanVar);
        });
        if (beforeReplace !== newContent) {
          fileChanges++;
        }
      }
    }
  }

  // Write file if changes were made
  if (fileChanges > 0) {
    writeFileSync(file, newContent);
    console.log(`✅ Fixed ${fileChanges} underscore declarations in ${file}`);
    modifiedFiles++;
    totalChanges += fileChanges;
  }
}

console.log(`\n🎯 Results:`);
console.log(`   Modified: ${modifiedFiles} files`);
console.log(`   Total: ${files.length} files`);
console.log(`   Success rate: ${((modifiedFiles / files.length) * 100).toFixed(1)}%`);
console.log(`   Total changes: ${totalChanges}`); 
