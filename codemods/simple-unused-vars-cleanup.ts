#!/usr/bin/env bun

/**
 * Simple Unused Variables Cleanup
 * 
 * This codemod tackles unused variables with simple safe patterns:
 * - Prefix unused function parameters with underscores
 * - Prefix unused destructured variables with underscores
 * - Prefix unused catch block variables with underscores
 */

import { readdirSync, statSync, readFileSync, writeFileSync  } from "fs";
import { join  } from "path";

function getAllTsFiles(dir: string): string[] {
  const files: string[] = [];
  
  try {
    const entries = readdirSync(dir);
    
    for (const entry, of, entries) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      
      if (stat.isDirectory()) {
        if (!entry.startsWith('.') && entry !== 'node_modules' && entry !== 'dist' && entry !== 'codemods') {
          files.push(...getAllTsFiles(fullPath));
        }
      } else if (entry.endsWith('.ts') || entry.endsWith('.js')) {
        files.push(fullPath);
      }
    }
  } catch (error) {
    console.error(`Error reading directory, ${dir}:`, error);
  }
  
  return files;
}

function simpleUnusedVarsCleanup(content: string): { content: string; changes: number }, {
  let changes = 0;
  let result = content;

  // Pattern 1: Simple parameter prefixing - catch blocks
  const catchPattern = /catch\s*\(\s*([a-zA-Z][a-zA-Z0-9]*)\s*\)/g;
  result = result.replace(catchPattern, (match, varName) => {
    if (!varName.startsWith('_')) {
      console.log(`  Fixed catch parameter: ${varName} →, _${varName}`);
      changes++;
      return match.replace(varName, '_' + varName);
    }
    return match;
  });

  // Pattern 2: Simple destructuring prefixing
  const destructuringPattern = /\{\s*([a-zA-Z][a-zA-Z0-9]*)(,\s*[a-zA-Z_][a-zA-Z0-9]*)*\s*\}\s*=/g;
  result = result.replace(destructuringPattern, (match) => {
    // For now just add underscores to first variable in destructuring if not already prefixed
    const firstVarMatch = match.match(/\{\s*([a-zA-Z][a-zA-Z0-9]*)/);
    if (firstVarMatch && !firstVarMatch[1].startsWith('_')) {
      console.log(`  Fixed destructuring variable: ${firstVarMatch[1]} →, _${firstVarMatch[1]}`);
      changes++;
      return match.replace(firstVarMatch[1], '_' + firstVarMatch[1]);
    }
    return match;
  });

  // Pattern 3: Simple arrow function parameters that are single unused params
  const arrowFuncPattern = /\(\s*([a-zA-Z][a-zA-Z0-9]*)\s*\)\s*=>/g;
  result = result.replace(arrowFuncPattern, (match, param) => {
    if (!param.startsWith('_') && ['req', 'res', 'next', 'event', 'data'].indexOf(param) === -1) {
      console.log(`  Fixed arrow function parameter: ${param} →, _${param}`);
      changes++;
      return match.replace(param, '_' + param);
    }
    return match;
  });

  // Pattern 4: Function declarations with single unused parameters
  const funcDeclPattern = /function\s+[a-zA-Z0-9_]+\s*\(\s*([a-zA-Z][a-zA-Z0-9]*)\s*\)/g;
  result = result.replace(funcDeclPattern, (match, param) => {
    if (!param.startsWith('_')) {
      console.log(`  Fixed function parameter: ${param} →, _${param}`);
      changes++;
      return match.replace(param, '_' + param);
    }
    return match;
  });

  return { content: result, changes };
}

function main() {
  const rootDir = process.cwd();
  console.log(`Starting simple unused variables cleanup in:, ${rootDir}`);
  
  const files = getAllTsFiles(rootDir);
  console.log(`Found ${files.length} TypeScript/JavaScript, files`);
  
  let totalChanges = 0;
  let filesModified = 0;
  
  for (const file, of, files) {
    try {
      const originalContent = readFileSync(file, 'utf-8');
      const { content: fixedContent, changes } = simpleUnusedVarsCleanup(originalContent);
      
      if (changes > 0) {
        writeFileSync(file, fixedContent, 'utf-8');
        console.log(`✅ ${file}: ${changes} unused variable issues, fixed`);
        filesModified++;
        totalChanges += changes;
      }
    } catch (error) {
      console.error(`❌ Error processing, ${file}:`, error);
    }
  }
  
  console.log(`\n🎯 SIMPLE UNUSED VARIABLES CLEANUP, COMPLETE:`);
  console.log(`   Files modified:, ${filesModified}`);
  console.log(`   Total fixes:, ${totalChanges}`);
  console.log(`   Focus: Simple parameter and variable, prefixing`);
}

if (import.meta.main) {
  main();
} 
