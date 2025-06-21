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
      } else if (entry.endsWith('.ts') || entry.endsWith('.js')) {
        files.push(fullPath);
      }
    }
  }
  
  traverse(dir);
  return files;
}

function fixSpecificTypeScriptErrors(content: string): string {
  let fixed = content;
  
  // Fix generic type parameters with comma before extends
  fixed = fixed.replace(/<([a-zA-Z_$][a-zA-Z0-9_$]*),\s*extends\s*([^>]+)>/g, '<$1 extends $2>');
  
  // Fix type properties with trailing commas that shouldn't be there
  fixed = fixed.replace(/:\s*"[^"]*"\s*\|\s*"[^"]*";,/g, (match) => match.replace(';,', ';'));
  
  // Fix Error references (should be Error)
  fixed = fixed.replace(/\|\s*Error/g, '| Error');
  fixed = fixed.replace(/:\s*Error/g, ': Error');
  
  // Fix function parameters with wrong comma placement
  fixed = fixed.replace(/\(implementation\?\:\s*any,\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\)/g, '(implementation?: $1)');
  
  // Fix arrow function parameters in loops with comma corruption
  fixed = fixed.replace(/for\s*\(\s*let\s+([^;]+);\s*([^;]+);\s*([^,)]+),\s*([^)]+)\)/g, 'for (let $1; $2; $3, $4)');
  
  // Fix generic constraints with comma corruption
  fixed = fixed.replace(/createMockObject<([a-zA-Z_$][a-zA-Z0-9_$]*),\s*extends\s*([^>]+)>/g, 'createMockObject<$1 extends $2>');
  
  // Fix Record type with missing comma
  fixed = fixed.replace(/Record<([a-zA-Z_$][a-zA-Z0-9_$]*)\s+([^>]+)>/g, 'Record<$1, $2>');
  
  // Fix typeof comma corruption
  fixed = fixed.replace(/ReturnType<typeof,\s*([a-zA-Z_$][a-zA-Z0-9_$]*)/g, 'ReturnType<typeof $1');
  
  // Fix object type properties with comma corruption
  fixed = fixed.replace(/extends\s*,\s*object/g, 'extends object');
  
  // Fix keyof with comma corruption
  fixed = fixed.replace(/keyof,\s*([a-zA-Z_$][a-zA-Z0-9_$]*)/g, 'keyof $1');
  
  // Fix underscore prefixes in variable names that shouldn't be there
  fixed = fixed.replace(/\_([a-zA-Z_$][a-zA-Z0-9_$]*)/g, (match, name) => {
    // Keep underscores for unused variables, but fix random underscores
    if (name === 'Error' || name === 'result' || name === 'T') {
      return name;
    }
    return match; // Keep original for other cases
  });
  
  // Fix function calls with incorrect underscore prefixes
  fixed = fixed.replace(/\_\(\)/g, '() =>');
  
  // Fix specific arrow function syntax issues
  fixed = fixed.replace(/afterEach\(\_\(\)\s*=>/g, 'afterEach(() =>');
  fixed = fixed.replace(/mock\(\_\(\)\s*=>/g, 'mock(() =>');
  
  return fixed;
}

// Process all files, but focus on the most problematic ones first
const files = getAllTsFiles('.');
let totalFixes = 0;
let filesFixed = 0;

console.log(`Processing ${files.length} files...`);

for (const file of files) {
  try {
    const originalContent = readFileSync(file, 'utf-8');
    const fixedContent = fixSpecificTypeScriptErrors(originalContent);
    
    if (originalContent !== fixedContent) {
      writeFileSync(file, fixedContent);
      filesFixed++;
      
      // Count approximate number of fixes
      const originalLines = originalContent.split('\n').length;
      const fixedLines = fixedContent.split('\n').length;
      const changes = Math.abs(originalLines - fixedLines) + 
        (originalContent.length - fixedContent.length) / 10; // Rough estimate
      totalFixes += Math.max(1, Math.floor(changes));
      
      console.log(`Fixed: ${file}`);
    }
  } catch (error) {
    console.error(`Error processing ${file}:`, error);
  }
}

console.log(`\nCompleted: ${totalFixes} fixes across ${filesFixed} files`); 
