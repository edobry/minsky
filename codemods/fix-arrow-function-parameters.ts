#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'fs';
import { globSync } from 'glob';

/**
 * Fix arrow function parameter underscore mismatches
 * Pattern: async (_args) => { ... args.something ... }
 * Solution: async (args) => { ... args.something ... }
 */

const files = globSync('src/**/*.ts', { ignore: ['**/*.d.ts'] });
console.log(`🔧 Processing ${files.length} files to fix arrow function parameter underscore mismatches...`);

let totalChanges = 0;
let modifiedFiles = 0;

for (const file of files) {
  const content = readFileSync(file, 'utf-8');
  let newContent = content;
  let fileChanges = 0;

  // Simple pattern matching for arrow functions with underscore parameters
  // Pattern: async (_paramName) => { ... paramName.something ... }
  const arrowFunctionPattern = /async\s*\(([^)]*)\)\s*:\s*[^{]*=>\s*{([^}]*(?:{[^}]*}[^}]*)*?)}/g;
  
  newContent = newContent.replace(arrowFunctionPattern, (match, params, body) => {
    if (!params.includes('_')) {
      return match; // No underscore parameters, no change needed
    }
    
    let modifiedParams = params;
    let paramChanged = false;
    
    // Find parameters that start with underscore
    const underscoreParams = params.match(/_\w+/g) || [];
    
    for (const underscoreParam of underscoreParams) {
      const cleanParam = underscoreParam.substring(1); // Remove the underscore
      
      // Check if the clean parameter name is used in the body
      const cleanParamRegex = new RegExp(`\\b${cleanParam}\\b`, 'g');
      if (cleanParamRegex.test(body)) {
        // The parameter is used without underscore in the body
        // Fix by removing underscore from parameter declaration
        modifiedParams = modifiedParams.replace(underscoreParam, cleanParam);
        paramChanged = true;
        fileChanges++;
      }
    }
    
    if (paramChanged) {
      // Replace the parameter list in the original match
      return match.replace(params, modifiedParams);
    }
    
    return match;
  });

  // Write file if changes were made
  if (fileChanges > 0) {
    writeFileSync(file, newContent);
    console.log(`✅ Fixed ${fileChanges} arrow function parameter mismatches in ${file}`);
    modifiedFiles++;
    totalChanges += fileChanges;
  }
}

console.log(`\n🎯 Results:`);
console.log(`   Modified: ${modifiedFiles} files`);
console.log(`   Total: ${files.length} files`);
console.log(`   Success rate: ${((modifiedFiles / files.length) * 100).toFixed(1)}%`);
console.log(`   Total changes: ${totalChanges}`); 
