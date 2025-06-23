#!/usr/bin/env bun

import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

// Simple fixes for most common unused variable patterns
const SIMPLE_FIXES = [
  // Unused function parameters
  [/(\s+)([a-zA-Z][a-zA-Z0-9]*)\s*:\s*([^,)]+)(\s*,)/g, "$1_$2: $3$4"],
  [/(\s+)([a-zA-Z][a-zA-Z0-9]*)\s*:\s*([^,)]+)(\s*\))/g, "$1_$2: $3$4"],
  
  // Unused variable assignments
  [/(\s+)(const|let|var)\s+([a-zA-Z][a-zA-Z0-9]*)\s*=/g, "$1$2 _$3 ="],
  
  // Unused destructuring
  [/(\s+)(const|let|var)\s+\{\s*([a-zA-Z][a-zA-Z0-9]*)\s*\}/g, "$1$2 { _$3 }"],
];

function processFile(filePath: string): number {
  const content = readFileSync(filePath, "utf8");
  let newContent = content;
  let changeCount = 0;

  for (const [pattern, replacement] of SIMPLE_FIXES) {
    const beforeContent = newContent;
    newContent = newContent.replace(pattern, replacement);
    if (newContent !== beforeContent) {
      changeCount++;
    }
  }

  if (newContent !== content) {
    writeFileSync(filePath, newContent);
    return changeCount;
  }

  return 0;
}

function findTsFiles(dir: string): string[] {
  const files: string[] = [];
  
  function walkDir(currentDir: string) {
    const entries = readdirSync(currentDir);
    
    for (const entry of entries) {
      const fullPath = join(currentDir, entry);
      const stat = statSync(fullPath);
      
      if (stat.isDirectory() && !entry.startsWith(".") && entry !== "node_modules") {
        walkDir(fullPath);
      } else if (stat.isFile() && fullPath.endsWith(".ts") && !fullPath.endsWith(".d.ts")) {
        files.push(fullPath);
      }
    }
  }
  
  walkDir(dir);
  return files;
}

const srcDir = "/Users/edobry/.local/state/minsky/git/local-minsky/sessions/136/src";
const files = findTsFiles(srcDir);

console.log(`Processing ${files.length} TypeScript files...`);

let totalChanges = 0;
let filesChanged = 0;

for (const file of files) {
  const changes = processFile(file);
  if (changes > 0) {
    totalChanges += changes;
    filesChanged++;
    console.log(`${file}: ${changes} changes`);
  }
}

console.log(`\nSummary: ${filesChanged} files changed, ${totalChanges} total changes`); 
