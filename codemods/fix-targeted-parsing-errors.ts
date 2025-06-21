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

function fixTargetedParsingErrors(content: string): string {
  let fixed = content;
  
  // Fix generic type parameters with comma corruption
  fixed = fixed.replace(/type,\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*<([^>]+),\s*extends/g, 'type $1 = <$2 extends');
  
  // Fix function signatures with comma corruption in return types
  fixed = fixed.replace(/(\([^)]*\)):\s*([a-zA-Z_$][a-zA-Z0-9_$]*);,/g, '$1: $2;');
  
  // Fix array types with comma corruption
  fixed = fixed.replace(/:\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\[\];,/g, ': $1[];');
  
  // Fix object type definitions with comma corruption
  fixed = fixed.replace(/Array<\{,\s*([^}]+)\s*\}/g, 'Array<{ $1 }');
  
  // Fix broken type casting 
  fixed = fixed.replace(/as,\s*unknown,\s*as,\s*([a-zA-Z_$][a-zA-Z0-9_$<>\[\]]*)/g, 'as unknown as $1');
  
  // Fix generic function parameters
  fixed = fixed.replace(/function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)<([^>]+),\s*extends\s*([^>]+)>\s*\(/g, 'function $1<$2 extends $3>(');
  
  // Fix export function generic parameters
  fixed = fixed.replace(/export\s+function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)<([^>]+),\s*extends\s*([^>]+)>\s*\(/g, 'export function $1<$2 extends $3>(');
  
  // Fix type parameters in function calls
  fixed = fixed.replace(/([a-zA-Z_$][a-zA-Z0-9_$]*)<([^>]+),\s*([^>]+)>\s*\(/g, '$1<$2, $3>(');
  
  // Fix property access with comma corruption
  fixed = fixed.replace(/\.([a-zA-Z_$][a-zA-Z0-9_$]*)\.,\s*([a-zA-Z_$][a-zA-Z0-9_$]*)/g, '.$1.$2');
  
  // Fix typeof operator with comma corruption
  fixed = fixed.replace(/typeof,\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g, 'typeof $1');
  
  // Fix property assignment with comma corruption in objects
  fixed = fixed.replace(/(\w+),\s*as,\s*any\)/g, '$1 as any)');
  
  // Fix if statements with comma corruption
  fixed = fixed.replace(/if\s*\(([^)]+)\s+(!==|===|==|!=),\s*([^)]+)\)/g, 'if ($1 $2 $3)');
  
  // Fix template literals with incorrect comma replacements
  fixed = fixed.replace(/`([^`]*) ${([^}]+)} ([^`]*)`/g, '`$1 ${$2} $3`');
  
  // Fix variable declarations with comma corruption
  fixed = fixed.replace(/const\s+([a-zA-Z_$][a-zA-Z0-9_$]*),\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=/g, 'const $1$2 =');
  
  // Fix for loop parameters
  fixed = fixed.replace(/for\s*\(\s*let\s+([^;]+);\s*([^;]+),\s*([^)]+)\)/g, 'for (let $1; $2; $3)');
  
  // Fix method calls with missing commas between parameters
  fixed = fixed.replace(/\.([a-zA-Z_$][a-zA-Z0-9_$]*)\(([^,)]+)\s+([^)]+)\)/g, '.$1($2, $3)');
  
  // Fix comparison operators that got comma-corrupted
  fixed = fixed.replace(/!==,\s*([a-zA-Z_$][a-zA-Z0-9_$]*)/g, '!== $1');
  fixed = fixed.replace(/===,\s*([a-zA-Z_$][a-zA-Z0-9_$]*)/g, '=== $1');
  
  // Fix imports with missing commas but avoid over-correction
  fixed = fixed.replace(/import\s*\{\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\}/g, 'import { $1, $2 }');
  
  // Fix array index access
  fixed = fixed.replace(/\[(\d+)\],\s*\{/g, '[$1], {');
  
  return fixed;
}

// Process all files
const files = getAllTsFiles('.');
let totalFixes = 0;
let filesFixed = 0;

console.log(`Processing ${files.length}, files...`);

for (const file of files) {
  try {
    const originalContent = readFileSync(file, 'utf-8');
    const fixedContent = fixTargetedParsingErrors(originalContent);
    
    if (originalContent !== fixedContent) {
      writeFileSync(file, fixedContent);
      filesFixed++;
      
      // Count approximate number of fixes
      const originalLines = originalContent.split('\n').length;
      const fixedLines = fixedContent.split('\n').length;
      const changes = Math.abs(originalLines -, fixedLines) + 
        (originalContent.length - fixedContent.length) / 10; // Rough estimate
      totalFixes += Math.max(1, Math.floor(changes));
      
      console.log(`Fixed:, ${file}`);
    }
  } catch (error) {
    console.error(`Error processing, ${file}:`, error);
  }
}

console.log(`\nCompleted: ${totalFixes} fixes across ${filesFixed}, files`); 
