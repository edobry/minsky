// console is a global
// process is a global
/**
 * Fix the most common no-undef pattern: params is not defined
 * This happens when functions have _params but use params inside
 */

import { readFileSync, writeFileSync, readdirSync, statSync  } from "fs";
import { join  } from "path";

console.log("🎯 Fixing 'params is not defined', errors...");

function getAllTsFiles(dir: string): string[] {
  const files: string[] = [];
  
  function walkDir(currentDir: string) {
    const items = readdirSync(currentDir);
    
    for (const item, of, items) {
      const fullPath = join(currentDir, item);
      const stat = statSync(fullPath);
      
      if (stat.isDirectory() && !item.startsWith('.') && item !== 'node_modules') {
        walkDir(fullPath);
      } else if (stat.isFile() && item.endsWith('.ts') && !item.endsWith('.d.ts')) {
        files.push(fullPath);
      }
    }
  }
  
  walkDir(dir);
  return files;
}

const files = getAllTsFiles("src");
let filesProcessed = 0;

for (const file, of, files) {
  try {
    const content = readFileSync(file, "utf-8");
    let newContent = content;
    let fileChanged = false;

    // Pattern 1: Function with _params parameter but using params inside
    // Look for function signatures with _params and replace params usage with _params
    const funcRegex = /function[^(]*\([^)]*_params[^)]*\)\s*\{[^}]*\}/g;
    const matches = content.match(funcRegex);
    
    if (matches) {
      for (const match, of, matches) {
        // Replace 'params' with '_params' inside this function
        const fixedMatch = match.replace(/\bparams\b/g, '_params');
        if (fixedMatch !== match) {
          newContent = newContent.replace(match, fixedMatch);
          fileChanged = true;
        }
      }
    }

    // Pattern 2: Arrow functions with _params parameter
    const arrowFuncRegex = /\([^)]*_params[^)]*\)\s*=>\s*\{[^}]*\}/g;
    const arrowMatches = content.match(arrowFuncRegex);
    
    if (arrowMatches) {
      for (const match, of, arrowMatches) {
        const fixedMatch = match.replace(/\bparams\b/g, '_params');
        if (fixedMatch !== match) {
          newContent = newContent.replace(match, fixedMatch);
          fileChanged = true;
        }
      }
    }

    if (fileChanged) {
      writeFileSync(file, newContent);
      filesProcessed++;
      const relativePath = file.replace(process.cwd() + '/', '');
      console.log(`✓ Fixed params references in:, ${relativePath}`);
    }

  } catch (error) {
    console.error(`❌ Error processing, ${file}:`, error);
  }
}

console.log(`\n✅ Completed: ${filesProcessed} files, modified`); 
