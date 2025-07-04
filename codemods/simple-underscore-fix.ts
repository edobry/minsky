#!/usr/bin/env bun

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
