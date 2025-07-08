#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'fs';
import { globSync } from 'glob';

/**
 * Fix missing this. prefix issues
 * Based on TypeScript errors like: "Cannot find name 'config'. Did you mean the instance member 'this.config'?"
 */

const files = globSync('src/**/*.ts', { ignore: ['**/*.d.ts'] });
console.log(`🔧 Processing ${files.length} TypeScript files to fix missing this. prefix...`);

let totalChanges = 0;
let modifiedFiles = 0;

for (const file of files) {
  const content = readFileSync(file, 'utf-8');
  let newContent = content;
  let fileChanges = 0;

  // Common patterns where `this.` is missing
  // These are based on the specific errors we're seeing
  const thisPatterns = [
    // Property access patterns
    { regex: /\bconfig\./g, replacement: 'this.config.' },
    { regex: /\bbranch\./g, replacement: 'this.branch.' },
    
    // Assignment patterns
    { regex: /\bconfig\s*=/g, replacement: 'this.config =' },
    { regex: /\bbranch\s*=/g, replacement: 'this.branch =' },
    
    // Function call patterns
    { regex: /\bconfig\(/g, replacement: 'this.config(' },
    { regex: /\bbranch\(/g, replacement: 'this.branch(' },
    
    // Conditional patterns
    { regex: /\bconfig\s*\?/g, replacement: 'this.config ?' },
    { regex: /\bbranch\s*\?/g, replacement: 'this.branch ?' },
    { regex: /\bconfig\s*&&/g, replacement: 'this.config &&' },
    { regex: /\bbranch\s*&&/g, replacement: 'this.branch &&' },
    { regex: /\bconfig\s*\|\|/g, replacement: 'this.config ||' },
    { regex: /\bbranch\s*\|\|/g, replacement: 'this.branch ||' },
    
    // Return patterns
    { regex: /return\s+config\b/g, replacement: 'return this.config' },
    { regex: /return\s+branch\b/g, replacement: 'return this.branch' },
    
    // Template literal patterns
    { regex: /\${config}/g, replacement: '${this.config}' },
    { regex: /\${branch}/g, replacement: '${this.branch}' },
    
    // Standalone variable usage (be careful not to match function parameters)
    { regex: /([^a-zA-Z_$])config([^a-zA-Z_$])/g, replacement: '$1this.config$2' },
    { regex: /([^a-zA-Z_$])branch([^a-zA-Z_$])/g, replacement: '$1this.branch$2' },
    
    // Beginning of line patterns
    { regex: /^(\s*)config\b/gm, replacement: '$1this.config' },
    { regex: /^(\s*)branch\b/gm, replacement: '$1this.branch' },
  ];

  // Apply fixes
  for (const pattern of thisPatterns) {
    const beforeReplace = newContent;
    newContent = newContent.replace(pattern.regex, pattern.replacement);
    if (beforeReplace !== newContent) {
      const matches = (beforeReplace.match(pattern.regex) || []).length;
      fileChanges += matches;
    }
  }

  // Write file if changes were made
  if (fileChanges > 0) {
    writeFileSync(file, newContent);
    console.log(`✅ Fixed ${fileChanges} missing this. prefixes in ${file}`);
    modifiedFiles++;
    totalChanges += fileChanges;
  }
}

console.log(`\n🎯 Results:`);
console.log(`   Modified: ${modifiedFiles} files`);
console.log(`   Total: ${files.length} files`);
console.log(`   Success rate: ${((modifiedFiles / files.length) * 100).toFixed(1)}%`);
console.log(`   Total changes: ${totalChanges}`); 
