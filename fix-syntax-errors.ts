#!/usr/bin/env bun

import { readdirSync, readFileSync, writeFileSync, statSync } from "fs";
import { join } from "path";

/**
 * Fix syntax errors created by incorrect ESLint auto-fixes
 * Pattern: .mockResolvedValueOnce(...) = mock(() => Promise.resolve(...))
 * Should be: = mock(() => Promise.resolve(...))
 */

function findTypeScriptFiles(dir: string): string[] {
  const files: string[] = [];
  
  function walk(currentDir: string) {
    const items = readdirSync(currentDir);
    
    for (const item of items) {
      const fullPath = join(currentDir, item);
      const stat = statSync(fullPath);
      
      if (stat.isDirectory() && !item.startsWith('.') && item !== 'node_modules') {
        walk(fullPath);
      } else if (item.endsWith('.ts') || item.endsWith('.js')) {
        files.push(fullPath);
      }
    }
  }
  
  walk(dir);
  return files;
}

function fixSyntaxErrors(content: string): { content: string; changed: boolean } {
  let changed = false;
  
  // Pattern 1: .mockResolvedValueOnce(...) = mock(() => Promise.resolve(...))
  // Should be: = mock(() => Promise.resolve(...))
  content = content.replace(
    /(\s+)\.mockResolvedValueOnce\([^)]*\)\s*=\s*(mock\([^)]*\))/g,
    (match, indent, mockCall) => {
      changed = true;
      return `${indent}= ${mockCall}`;
    }
  );
  
  // Pattern 2: .mockResolvedValue(...) = mock(() => Promise.resolve(...))
  // Should be: = mock(() => Promise.resolve(...))
  content = content.replace(
    /(\s+)\.mockResolvedValue\([^)]*\)\s*=\s*(mock\([^)]*\))/g,
    (match, indent, mockCall) => {
      changed = true;
      return `${indent}= ${mockCall}`;
    }
  );
  
  // Pattern 3: .mockReturnValue(...) = mock(() => ...)
  // Should be: = mock(() => ...)
  content = content.replace(
    /(\s+)\.mockReturnValue\([^)]*\)\s*=\s*(mock\([^)]*\))/g,
    (match, indent, mockCall) => {
      changed = true;
      return `${indent}= ${mockCall}`;
    }
  );
  
  // Pattern 4: Double assignment patterns like:
  // }).mockResolvedValueOnce(...) = mock(() => ...)(...) = mock(() => ...)
  content = content.replace(
    /(\s+)\.mockResolvedValueOnce\([^)]*\)\s*=\s*mock\([^)]*\)\([^)]*\)\s*=\s*(mock\([^)]*\))/g,
    (match, indent, finalMock) => {
      changed = true;
      return `${indent}= ${finalMock}`;
    }
  );
  
  return { content, changed };
}

function main() {
  const srcFiles = findTypeScriptFiles("src");
  const testFiles = findTypeScriptFiles("tests");
  const allFiles = [...srcFiles, ...testFiles];
  
  let totalFixed = 0;
  
  for (const file of allFiles) {
    try {
      const content = readFileSync(file, "utf-8");
      const { content: newContent, changed } = fixSyntaxErrors(content);
      
      if (changed) {
        writeFileSync(file, newContent, "utf-8");
        console.log(`Fixed syntax errors in: ${file}`);
        totalFixed++;
      }
    } catch (error) {
      console.error(`Error processing ${file}:`, error);
    }
  }
  
  console.log(`\nFixed syntax errors in ${totalFixed} files`);
  
  // Report remaining patterns that need manual attention
  console.log("\nChecking for remaining problematic patterns...");
  
  for (const file of allFiles) {
    try {
      const content = readFileSync(file, "utf-8");
      
      // Check for remaining broken patterns
      if (content.includes(".mockResolvedValueOnce(") && content.includes("= mock(")) {
        console.log(`⚠️  Still has syntax issues: ${file}`);
      }
      
      if (content.includes(".mockResolvedValue(") && content.includes("= mock(")) {
        console.log(`⚠️  Still has syntax issues: ${file}`);
      }
    } catch (error) {
      // Ignore file read errors
    }
  }
}

main(); 
