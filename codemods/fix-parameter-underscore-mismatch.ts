#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'fs';
import { globSync } from 'glob';

/**
 * Fix function parameter underscore mismatches
 * Pattern: Parameter defined with underscore (_args) but used without underscore (args)
 * Solution: Remove underscore from parameter definition
 */

const files = globSync('src/**/*.ts', { ignore: ['**/*.d.ts'] });
console.log(`🔧 Processing ${files.length} TypeScript files to fix parameter underscore mismatches...`);

let totalChanges = 0;
let modifiedFiles = 0;

for (const file of files) {
  const content = readFileSync(file, 'utf-8');
  let newContent = content;
  let fileChanges = 0;

  // Pattern 1: Arrow functions with underscore parameters used without underscores
  // execute: async (_args) => { ... args.something ... }
  const arrowFunctionRegex = /(\w+):\s*async\s*\(([^)]*)\)\s*=>\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g;
  
  newContent = newContent.replace(arrowFunctionRegex, (match, methodName, params, body) => {
    if (!params.trim()) return match;
    
    const paramList = params.split(',').map(p => p.trim());
    let bodyModified = body;
    let paramModified = false;
    
    // Check each parameter
    const newParams = paramList.map(param => {
      // Extract parameter name (handle types like _args: Type)
      const paramMatch = param.match(/^(_\w+)(?:\s*:\s*[^,]+)?$/);
      if (!paramMatch) return param;
      
      const underscoreParam = paramMatch[1]; // e.g., "_args"
      const cleanParam = underscoreParam.substring(1); // e.g., "args"
      
      // Check if the clean parameter (without underscore) is used in the function body
      const usageRegex = new RegExp(`\\b${cleanParam}\\b`, 'g');
      if (usageRegex.test(body)) {
        // Replace parameter definition to remove underscore
        paramModified = true;
        return param.replace(underscoreParam, cleanParam);
      }
      
      return param;
    });
    
    if (paramModified) {
      fileChanges++;
      return match.replace(params, newParams.join(', '));
    }
    
    return match;
  });

  // Pattern 2: Regular functions with underscore parameters
  // function foo(_param) { ... param.something ... }
  const functionRegex = /function\s+(\w+)\s*\(([^)]*)\)\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g;
  
  newContent = newContent.replace(functionRegex, (match, functionName, params, body) => {
    if (!params.trim()) return match;
    
    const paramList = params.split(',').map(p => p.trim());
    let paramModified = false;
    
    // Check each parameter
    const newParams = paramList.map(param => {
      // Extract parameter name (handle types like _args: Type)
      const paramMatch = param.match(/^(_\w+)(?:\s*:\s*[^,]+)?$/);
      if (!paramMatch) return param;
      
      const underscoreParam = paramMatch[1]; // e.g., "_args"
      const cleanParam = underscoreParam.substring(1); // e.g., "args"
      
      // Check if the clean parameter (without underscore) is used in the function body
      const usageRegex = new RegExp(`\\b${cleanParam}\\b`, 'g');
      if (usageRegex.test(body)) {
        // Replace parameter definition to remove underscore
        paramModified = true;
        return param.replace(underscoreParam, cleanParam);
      }
      
      return param;
    });
    
    if (paramModified) {
      fileChanges++;
      return match.replace(params, newParams.join(', '));
    }
    
    return match;
  });

  // Pattern 3: Method definitions with underscore parameters
  // methodName(_param) { ... param.something ... }
  const methodRegex = /(\w+)\s*\(([^)]*)\)\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g;
  
  newContent = newContent.replace(methodRegex, (match, methodName, params, body) => {
    if (!params.trim()) return match;
    
    const paramList = params.split(',').map(p => p.trim());
    let paramModified = false;
    
    // Check each parameter
    const newParams = paramList.map(param => {
      // Extract parameter name (handle types like _args: Type)
      const paramMatch = param.match(/^(_\w+)(?:\s*:\s*[^,]+)?$/);
      if (!paramMatch) return param;
      
      const underscoreParam = paramMatch[1]; // e.g., "_args"
      const cleanParam = underscoreParam.substring(1); // e.g., "args"
      
      // Check if the clean parameter (without underscore) is used in the function body
      const usageRegex = new RegExp(`\\b${cleanParam}\\b`, 'g');
      if (usageRegex.test(body)) {
        // Replace parameter definition to remove underscore
        paramModified = true;
        return param.replace(underscoreParam, cleanParam);
      }
      
      return param;
    });
    
    if (paramModified) {
      fileChanges++;
      return match.replace(params, newParams.join(', '));
    }
    
    return match;
  });

  // Write file if changes were made
  if (fileChanges > 0) {
    writeFileSync(file, newContent);
    console.log(`✅ Fixed ${fileChanges} parameter underscore mismatches in ${file}`);
    modifiedFiles++;
    totalChanges += fileChanges;
  }
}

console.log(`\n🎯 Results:`);
console.log(`   Modified: ${modifiedFiles} files`);
console.log(`   Total: ${files.length} files`);
console.log(`   Success rate: ${((modifiedFiles / files.length) * 100).toFixed(1)}%`);
console.log(`   Total changes: ${totalChanges}`); 
