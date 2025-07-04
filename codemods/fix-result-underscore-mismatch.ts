#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

// Find TypeScript files
const files = execSync('find . -name "*.ts" -o -name "*.tsx"', { encoding: "utf8" })
  .split('\n')
  .filter(f => f && !f.includes('node_modules') && !f.includes('.git'));

let totalFixed = 0;
const fixedFiles: string[] = [];

for (const file of files) {
  try {
    const content = readFileSync(file, 'utf8');
    let modified = false;
    let newContent = content;

    // Pattern 1: Fix cases where _result is declared but result is used
    // This is a VERY conservative pattern - only fix obvious mismatches
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // Check if this line declares _result
      if (line.includes('const result =') || line.includes('let result =')) {
        // Check next few lines for usage of 'result' without underscore
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
          if (lines[j].match(/\bresult\b/) && !lines[j].match(/\b_result\b/)) {
            // Found usage of 'result' without underscore - fix the declaration
            lines[i] = lines[i].replace(/\b_result\b/, 'result');
            modified = true;
            totalFixed++;
            break;
          }
        }
      }
    }

    if (modified) {
      newContent = lines.join('\n');
      writeFileSync(file, newContent);
      fixedFiles.push(file);
    }
  } catch (error) {
    console.error(`Error processing ${file}:`, error);
  }
}

console.log(`\nFixed ${totalFixed} mismatched _result declarations in ${fixedFiles.length} files`);
if (fixedFiles.length > 0) {
  console.log('\nFixed files:');
  fixedFiles.forEach(f => console.log(`  ${f}`));
} 
