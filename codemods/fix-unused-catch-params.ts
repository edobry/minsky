#!/usr/bin/env bun

import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

// Get all TypeScript files recursively
function getAllTsFiles(dir: string): string[] {
  const files: string[] = [];
  
  function traverse(currentDir: string) {
    const entries = readdirSync(currentDir);
    
    for (const entry of entries) {
      const fullPath = join(currentDir, entry);
      const stat = statSync(fullPath);
      
      if (stat.isDirectory()) {
        // Skip node_modules and other unwanted directories
        if (!['node_modules', '.git', 'dist', 'build'].includes(entry)) {
          traverse(fullPath);
        }
      } else if (entry.endsWith('.ts')) {
        files.push(fullPath);
      }
    }
  }
  
  traverse(dir);
  return files;
}

const files = getAllTsFiles('src');
let totalChanges = 0;
const changedFiles = new Set<string>();

for (const file of files) {
  const content = readFileSync(file, 'utf8') as string;
  let newContent = content;
  let fileChanges = 0;

  // Fix unused catch block parameters - very safe transformation
  const catchParamFixes = [
    // Standard catch blocks with unused parameters
    { pattern: /catch\s*\(\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\)/g, replacement: 'catch (_$1)' },
    // Catch blocks that already have underscore but might need fixing
    { pattern: /catch\s*\(\s*_([a-zA-Z_][a-zA-Z0-9_]*)\s*\)/g, replacement: 'catch (_$1)' }
  ];

  for (const fix of catchParamFixes) {
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
