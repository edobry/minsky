#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'fs';
import { globSync } from 'glob';

/**
 * Fix remaining variable naming issues
 * Based on specific error patterns seen in TypeScript output
 */

const files = globSync('src/**/*.ts', { ignore: ['**/*.d.ts'] });
console.log(`🔧 Processing ${files.length} files to fix remaining variable naming issues...`);

let totalChanges = 0;
let modifiedFiles = 0;

for (const file of files) {
  const content = readFileSync(file, 'utf-8');
  let newContent = content;
  let fileChanges = 0;

  // Fix specific issues seen in TypeScript errors
  const specificFixes = [
    // Fix _k usage (should be k)
    { regex: /\b_k\b/g, replacement: 'k' },
    
    // Fix category vs _category issues
    { regex: /\bcategory\b/g, replacement: 'category' }, // First, preserve existing usage
    
    // Fix specific variable declaration issues
    { regex: /const _k =/g, replacement: 'const k =' },
    { regex: /let _k =/g, replacement: 'let k =' },
    
    // Fix object destructuring issues
    { regex: /\{ _k,/g, replacement: '{ k,' },
    { regex: /, _k \}/g, replacement: ', k }' },
    { regex: /\{ _k \}/g, replacement: '{ k }' },
    
    // Fix function parameter issues for single letter variables
    { regex: /\(_k\)/g, replacement: '(k)' },
    { regex: /\(_k,/g, replacement: '(k,' },
    { regex: /, _k\)/g, replacement: ', k)' },
    { regex: /, _k,/g, replacement: ', k,' },
    
    // Fix iteration variable issues
    { regex: /for \(const _k of/g, replacement: 'for (const k of' },
    { regex: /for \(let _k of/g, replacement: 'for (let k of' },
    { regex: /for \(const _k in/g, replacement: 'for (const k in' },
    { regex: /for \(let _k in/g, replacement: 'for (let k in' },
    
    // Fix array/object method issues
    { regex: /\.map\(_k =>/g, replacement: '.map(k =>' },
    { regex: /\.filter\(_k =>/g, replacement: '.filter(k =>' },
    { regex: /\.forEach\(_k =>/g, replacement: '.forEach(k =>' },
    { regex: /\.find\(_k =>/g, replacement: '.find(k =>' },
    { regex: /\.some\(_k =>/g, replacement: '.some(k =>' },
    { regex: /\.every\(_k =>/g, replacement: '.every(k =>' },
  ];

  // Apply specific fixes
  for (const fix of specificFixes) {
    const beforeReplace = newContent;
    newContent = newContent.replace(fix.regex, fix.replacement);
    if (beforeReplace !== newContent) {
      const matches = (beforeReplace.match(fix.regex) || []).length;
      fileChanges += matches;
    }
  }

  // Handle parameter vs usage mismatches by looking for specific patterns
  const lines = newContent.split('\n');
  let lineFixed = false;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Pattern: function parameter _category but usage category
    if (line.includes('_category') && line.includes('(')) {
      // Check if this is a parameter definition
      const parameterRegex = /\(([^)]*_category[^)]*)\)/;
      const match = line.match(parameterRegex);
      if (match) {
        // Check next few lines for usage of clean variable
        for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
          if (lines[j].includes('category') && !lines[j].includes('_category')) {
            // Found usage of clean variable - fix the parameter
            lines[i] = lines[i].replace('_category', 'category');
            fileChanges++;
            lineFixed = true;
            break;
          }
        }
      }
    }
  }

  if (lineFixed) {
    newContent = lines.join('\n');
  }

  // Write file if changes were made
  if (fileChanges > 0) {
    writeFileSync(file, newContent);
    console.log(`✅ Fixed ${fileChanges} remaining variable issues in ${file}`);
    modifiedFiles++;
    totalChanges += fileChanges;
  }
}

console.log(`\n🎯 Results:`);
console.log(`   Modified: ${modifiedFiles} files`);
console.log(`   Total: ${files.length} files`);
console.log(`   Success rate: ${((modifiedFiles / files.length) * 100).toFixed(1)}%`);
console.log(`   Total changes: ${totalChanges}`); 
