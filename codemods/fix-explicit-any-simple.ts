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

  // Simple any type replacements for common patterns
  const anyReplacements = [
    // Function parameters that are obviously objects
    { pattern: /\(([^:]+): any\)/g, replacement: '($1: unknown)' },
    // Variable declarations
    { pattern: /: any\[\]/g, replacement: ': unknown[]' },
    { pattern: /: any\s*=/g, replacement: ': unknown =' },
    // Return types
    { pattern: /\): any\s*{/g, replacement: '): unknown {' },
    { pattern: /\): any\s*=>/g, replacement: '): unknown =>' },
    // Generic constraints
    { pattern: /<T = any>/g, replacement: '<T = unknown>' },
    { pattern: /<T extends any>/g, replacement: '<T extends unknown>' }
  ];

  for (const fix of anyReplacements) {
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
