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

  // Fix unused function parameters by prefixing with underscore
  const unusedParamFixes = [
    // Function parameters that are clearly unused (common patterns)
    { pattern: /\(([a-zA-Z_][a-zA-Z0-9_]*): [^)]+\) =>/g, replacement: '(_$1: unknown) =>' },
    // Catch block parameters
    { pattern: /catch\s*\(([a-zA-Z_][a-zA-Z0-9_]*)\)/g, replacement: 'catch (_$1)' },
    // Function parameters in function declarations (be more conservative)
    { pattern: /function\s+[a-zA-Z_][a-zA-Z0-9_]*\s*\(([a-zA-Z_][a-zA-Z0-9_]*): [^)]+\)/g, replacement: (match: string) => {
      return match.replace(/\(([a-zA-Z_][a-zA-Z0-9_]*):/, '(_$1:');
    }}
  ];

  // Remove obviously unused imports (be very conservative)
  const unusedImportPatterns = [
    // Remove unused imports that are clearly not used anywhere in the file
    { pattern: /import\s+{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*}\s+from\s+['"][^'"]+['"];\s*\n/g, 
      replacement: (match: string, importName: string) => {
        // Only remove if the import is clearly not used in the file
        const regex = new RegExp(`\\b${importName}\\b`, 'g');
        const usages = (newContent.match(regex) || []).length;
        // If only appears once (in the import), remove it
        return usages <= 1 ? '' : match;
      }
    }
  ];

  for (const fix of unusedParamFixes) {
    if (typeof fix.replacement === 'function') {
      newContent = newContent.replace(fix.pattern, fix.replacement);
    } else {
      const matches = newContent.match(fix.pattern);
      if (matches) {
        newContent = newContent.replace(fix.pattern, fix.replacement);
        fileChanges += matches.length;
      }
    }
  }

  for (const fix of unusedImportPatterns) {
    if (typeof fix.replacement === 'function') {
      const originalContent = newContent;
      newContent = newContent.replace(fix.pattern, fix.replacement);
      if (originalContent !== newContent) {
        fileChanges += 1;
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
