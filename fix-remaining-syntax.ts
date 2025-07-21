#!/usr/bin/env bun

import { readdirSync, readFileSync, writeFileSync, statSync } from "fs";
import { join } from "path";

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

function fixComplexSyntaxErrors(content: string): { content: string; changed: boolean } {
  let changed = false;
  
  // Pattern 1: = mock() = mock(...) -> = mock(...)
  // Keep only the last mock assignment
  content = content.replace(
    /(\s*)([a-zA-Z_][a-zA-Z0-9_.*]*)\s*=\s*mock\(\)\s*=\s*(mock\([^)]*\))/g,
    (match, indent, varName, finalMock) => {
      changed = true;
      return `${indent}${varName} = ${finalMock}`;
    }
  );
  
  // Pattern 2: = mock(...) = mock(...) -> = mock(...)
  // Keep only the last mock assignment
  content = content.replace(
    /(\s*)([a-zA-Z_][a-zA-Z0-9_.*]*)\s*=\s*mock\([^)]*\)\s*=\s*(mock\([^)]*\))/g,
    (match, indent, varName, finalMock) => {
      changed = true;
      return `${indent}${varName} = ${finalMock}`;
    }
  );
  
  // Pattern 3: Nested parentheses issues: mock(() => ...))({ ... }) = mock(...)
  content = content.replace(
    /(\s*)([a-zA-Z_][a-zA-Z0-9_.*]*)\s*=\s*mock\([^)]*\)\)\([^)]*\)\s*=\s*(mock\([^)]*\))/g,
    (match, indent, varName, finalMock) => {
      changed = true;
      return `${indent}${varName} = ${finalMock}`;
    }
  );
  
  // Pattern 4: Clean up any remaining orphaned mock assignments
  content = content.replace(
    /(\s+)= mock\([^)]*\)(\)\([^)]*\))?;\s*\/\/[^\n]*$/gm,
    (match, indent) => {
      changed = true;
      return ''; // Remove orphaned assignments
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
      const { content: newContent, changed } = fixComplexSyntaxErrors(content);
      
      if (changed) {
        writeFileSync(file, newContent, "utf-8");
        console.log(`Fixed complex syntax errors in: ${file}`);
        totalFixed++;
      }
    } catch (error) {
      console.error(`Error processing ${file}:`, error);
    }
  }
  
  console.log(`\nFixed complex syntax errors in ${totalFixed} files`);
  
  // Report any remaining double assignments
  console.log("\nChecking for remaining double assignments...");
  
  for (const file of allFiles) {
    try {
      const content = readFileSync(file, "utf-8");
      
      if (content.includes("= mock") && content.includes("= mock")) {
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes("= mock") && lines[i].match(/= mock.*= mock/)) {
            console.log(`⚠️  Line ${i + 1} in ${file}: ${lines[i].trim()}`);
          }
        }
      }
    } catch (error) {
      // Ignore file read errors
    }
  }
}

main(); 
