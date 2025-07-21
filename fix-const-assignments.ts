#!/usr/bin/env bun

import { readdirSync, statSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

/**
 * Fix const assignment errors by changing const to let for variables that are reassigned
 */

function findTypeScriptFiles(dir: string): string[] {
  const files: string[] = [];
  
  function walk(currentDir: string) {
    const items = readdirSync(currentDir);
    
    for (const item of items) {
      const fullPath = join(currentDir, item);
      const stat = statSync(fullPath);
      
      if (stat.isDirectory() && !item.startsWith(".") && item !== "node_modules") {
        walk(fullPath);
      } else if (item.endsWith(".ts") || item.endsWith(".tsx")) {
        files.push(fullPath);
      }
    }
  }
  
  walk(dir);
  return files;
}

function fixConstAssignments(content: string): { content: string; changed: boolean } {
  let result = content;
  let changed = false;

  // Pattern: const variableName = ... followed later by variableName = mock(...)
  // We need to find const declarations where the variable is later reassigned
  
  const lines = result.split("\n");
  const constDeclarations = new Map<string, number>(); // variable name -> line index
  const reassignments = new Set<string>(); // variable names that are reassigned
  
  // First pass: find all const declarations and reassignments
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Match const declarations: const variableName = ...
    const constMatch = line.match(/^\s*const\s+(\w+)\s*=/);
    if (constMatch) {
      const varName = constMatch[1];
      constDeclarations.set(varName, i);
    }
    
    // Match reassignments: variableName = mock(...) or variableName.mockImplementation(...)
    const reassignMatch = line.match(/^\s*(\w+)\s*=\s*(mock\(|.*\.mock)/);
    if (reassignMatch) {
      const varName = reassignMatch[1];
      reassignments.add(varName);
    }
  }
  
  // Second pass: change const to let for variables that are reassigned
  for (const [varName, lineIndex] of constDeclarations) {
    if (reassignments.has(varName)) {
      const oldLine = lines[lineIndex];
      const newLine = oldLine.replace(/^\s*const\s+/, `${oldLine.match(/^\s*/)?.[0]  }let `);
      if (newLine !== oldLine) {
        lines[lineIndex] = newLine;
        changed = true;
        console.log(`Fixed const assignment: ${varName} in line ${lineIndex + 1}`);
      }
    }
  }
  
  return { content: lines.join("\n"), changed };
}

function main() {
  const projectRoot = process.cwd();
  console.log(`Scanning for TypeScript files in: ${projectRoot}`);
  
  const files = findTypeScriptFiles(projectRoot);
  console.log(`Found ${files.length} TypeScript files`);
  
  let totalFixed = 0;
  
  for (const file of files) {
    try {
      const content = readFileSync(file, "utf-8");
      const { content: newContent, changed } = fixConstAssignments(content);
      
      if (changed) {
        writeFileSync(file, newContent);
        totalFixed++;
        console.log(`Fixed: ${file}`);
      }
    } catch (error) {
      console.error(`Error processing ${file}:`, error);
    }
  }
  
  console.log(`\nFixed const assignments in ${totalFixed} files`);
}

if (import.meta.main) {
  main();
} 
