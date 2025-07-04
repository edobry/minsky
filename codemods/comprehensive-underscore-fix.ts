#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'fs';
import { globSync } from 'glob';

/**
 * Comprehensive underscore mismatch fixer
 * Combines and extends successful patterns from:
 * - fix-incorrect-underscore-prefixes.ts (fixed 57 issues)
 * - fix-result-underscore-mismatch.ts (fixed 188 issues)
 * - Manual fixes for arrow function parameters
 * - Remaining variable naming patterns
 */

const files = globSync('src/**/*.ts', { ignore: ['**/*.d.ts'] });
console.log(`🔧 Processing ${files.length} TypeScript files to fix comprehensive underscore mismatches...`);

let totalChanges = 0;
let modifiedFiles = 0;

for (const file of files) {
  const content = readFileSync(file, 'utf-8');
  let newContent = content;
  let fileChanges = 0;

  // Category 1: Single underscore usage issues (from successful codemod)
  const singleUnderscoreUsageFixes = [
    // Function calls and property access
    { regex: /\b_(\w+)\./g, replacement: '$1.' },
    { regex: /\b_(\w+)\(/g, replacement: '$1(' },
    { regex: /\b_(\w+)\[/g, replacement: '$1[' },
    
    // Variable assignments and comparisons
    { regex: /= _(\w+);/g, replacement: '= $1;' },
    { regex: /=== _(\w+)/g, replacement: '=== $1' },
    { regex: /!== _(\w+)/g, replacement: '!== $1' },
    { regex: /== _(\w+)/g, replacement: '== $1' },
    { regex: /!= _(\w+)/g, replacement: '!= $1' },
    
    // Return statements
    { regex: /return _(\w+);/g, replacement: 'return $1;' },
    { regex: /return _(\w+)\./g, replacement: 'return $1.' },
    { regex: /return _(\w+)\(/g, replacement: 'return $1(' },
    
    // Template literals and string interpolation
    { regex: /\${_(\w+)}/g, replacement: '${$1}' },
    
    // Conditional expressions
    { regex: /_(\w+) \? /g, replacement: '$1 ? ' },
    { regex: /_(\w+) \|\| /g, replacement: '$1 || ' },
    { regex: /_(\w+) && /g, replacement: '$1 && ' },
    
    // Common method calls
    { regex: /\.push\(_(\w+)\)/g, replacement: '.push($1)' },
    { regex: /\.includes\(_(\w+)\)/g, replacement: '.includes($1)' },
    { regex: /\.map\(_(\w+)\)/g, replacement: '.map($1)' },
    { regex: /\.filter\(_(\w+)\)/g, replacement: '.filter($1)' },
    { regex: /\.forEach\(_(\w+)\)/g, replacement: '.forEach($1)' },
    
    // Property assignments
    { regex: /: _(\w+),/g, replacement: ': $1,' },
    { regex: /: _(\w+)\}/g, replacement: ': $1}' },
    { regex: /: _(\w+)$/g, replacement: ': $1' },
  ];

  // Category 2: Double underscore issues (new patterns)
  const doubleUnderscoreUsageFixes = [
    // Function calls and property access
    { regex: /\b__(\w+)\./g, replacement: '$1.' },
    { regex: /\b__(\w+)\(/g, replacement: '$1(' },
    { regex: /\b__(\w+)\[/g, replacement: '$1[' },
    
    // Variable assignments and comparisons
    { regex: /= __(\w+);/g, replacement: '= $1;' },
    { regex: /=== __(\w+)/g, replacement: '=== $1' },
    { regex: /!== __(\w+)/g, replacement: '!== $1' },
    
    // Return statements
    { regex: /return __(\w+);/g, replacement: 'return $1;' },
    { regex: /return __(\w+)\./g, replacement: 'return $1.' },
    { regex: /return __(\w+)\(/g, replacement: 'return $1(' },
    
    // Template literals and string interpolation
    { regex: /\${__(\w+)}/g, replacement: '${$1}' },
    
    // Function arguments
    { regex: /\(__(\w+)\)/g, replacement: '($1)' },
    { regex: /\(__(\w+),/g, replacement: '($1,' },
    { regex: /, __(\w+)\)/g, replacement: ', $1)' },
    { regex: /, __(\w+),/g, replacement: ', $1,' },
  ];

  // Category 3: Property access with underscores (common error patterns)
  const propertyAccessFixes = [
    // Common property access issues seen in errors
    { regex: /\._command/g, replacement: '.command' },
    { regex: /error\._command/g, replacement: 'error.command' },
  ];

  // Apply all single underscore fixes
  for (const fix of singleUnderscoreUsageFixes) {
    const beforeReplace = newContent;
    newContent = newContent.replace(fix.regex, fix.replacement);
    if (beforeReplace !== newContent) {
      const matches = (beforeReplace.match(fix.regex) || []).length;
      fileChanges += matches;
    }
  }

  // Apply all double underscore fixes
  for (const fix of doubleUnderscoreUsageFixes) {
    const beforeReplace = newContent;
    newContent = newContent.replace(fix.regex, fix.replacement);
    if (beforeReplace !== newContent) {
      const matches = (beforeReplace.match(fix.regex) || []).length;
      fileChanges += matches;
    }
  }

  // Apply property access fixes
  for (const fix of propertyAccessFixes) {
    const beforeReplace = newContent;
    newContent = newContent.replace(fix.regex, fix.replacement);
    if (beforeReplace !== newContent) {
      const matches = (beforeReplace.match(fix.regex) || []).length;
      fileChanges += matches;
    }
  }

  // Category 4: Declaration vs usage mismatches (from successful pattern, extended)
  const lines = newContent.split('\n');
  let declarationFixed = false;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Common declaration patterns that should be fixed
    const declarationPatterns = [
      { from: 'const _result =', to: 'const result =', usage: 'result' },
      { from: 'let _result =', to: 'let result =', usage: 'result' },
      { from: 'const _item =', to: 'const item =', usage: 'item' },
      { from: 'let _item =', to: 'let item =', usage: 'item' },
      { from: 'const _data =', to: 'const data =', usage: 'data' },
      { from: 'let _data =', to: 'let data =', usage: 'data' },
      { from: 'const _error =', to: 'const error =', usage: 'error' },
      { from: 'let _error =', to: 'let error =', usage: 'error' },
      { from: 'const _response =', to: 'const response =', usage: 'response' },
      { from: 'let _response =', to: 'let response =', usage: 'response' },
      { from: 'const _taskId =', to: 'const taskId =', usage: 'taskId' },
      { from: 'let _taskId =', to: 'let taskId =', usage: 'taskId' },
      { from: 'const _k =', to: 'const k =', usage: 'k' },
      { from: 'let _k =', to: 'let k =', usage: 'k' },
      { from: 'const _category =', to: 'const category =', usage: 'category' },
      { from: 'let _category =', to: 'let category =', usage: 'category' },
    ];

    for (const pattern of declarationPatterns) {
      if (line.includes(pattern.from)) {
        // Check next few lines for usage of the clean variable
        for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
          const regex = new RegExp(`\\b${pattern.usage}\\b`);
          const underscoreRegex = new RegExp(`\\b_${pattern.usage}\\b`);
          if (regex.test(lines[j]) && !underscoreRegex.test(lines[j])) {
            // Found usage of clean variable - fix the declaration
            lines[i] = lines[i].replace(pattern.from, pattern.to);
            fileChanges++;
            declarationFixed = true;
            break;
          }
        }
      }
    }
  }

  if (declarationFixed) {
    newContent = lines.join('\n');
  }

  // Category 5: Arrow function parameter underscore mismatches (IMPROVED)
  // Pattern: async (_args) => { ... args.something ... }
  const arrowFunctionPatterns = [
    // Standard async arrow functions
    /execute:\s*async\s*\(([^)]*_\w+[^)]*)\)\s*:\s*[^{]*=>\s*{/g,
    // Other arrow function patterns
    /:\s*async\s*\(([^)]*_\w+[^)]*)\)\s*=>\s*{/g,
    /=\s*async\s*\(([^)]*_\w+[^)]*)\)\s*=>\s*{/g,
  ];

  for (const pattern of arrowFunctionPatterns) {
    newContent = newContent.replace(pattern, (match, params) => {
      if (!params.includes('_')) {
        return match; // No underscore parameters
      }
      
      // Find the function body to check usage
      const functionStart = newContent.indexOf(match);
      const bodyStart = functionStart + match.length;
      let braceCount = 1;
      let bodyEnd = bodyStart;
      
      // Find the end of the function body
      for (let i = bodyStart; i < newContent.length && braceCount > 0; i++) {
        if (newContent[i] === '{') braceCount++;
        else if (newContent[i] === '}') braceCount--;
        bodyEnd = i;
      }
      
      const body = newContent.substring(bodyStart, bodyEnd);
      
      // Check if underscore parameters are used without underscores
      const underscoreParams = params.match(/_\w+/g) || [];
      let modifiedParams = params;
      let paramChanged = false;
      
      for (const underscoreParam of underscoreParams) {
        const cleanParam = underscoreParam.substring(1);
        const cleanParamRegex = new RegExp(`\\b${cleanParam}\\b`);
        
        if (cleanParamRegex.test(body)) {
          modifiedParams = modifiedParams.replace(underscoreParam, cleanParam);
          paramChanged = true;
          fileChanges++;
        }
      }
      
      if (paramChanged) {
        return match.replace(params, modifiedParams);
      }
      
      return match;
    });
  }

  // Category 6: Function parameter patterns (extended)
  // Pattern: function(_taskId, ...) { ... taskId ... }
  const functionParameterPatterns = [
    /function\s*\(([^)]*_\w+[^)]*)\)\s*{/g,
    /\(([^)]*_\w+[^)]*)\)\s*=>\s*{/g,
  ];

  for (const pattern of functionParameterPatterns) {
    newContent = newContent.replace(pattern, (match, params) => {
      if (!params.includes('_')) {
        return match;
      }
      
      // Similar logic as arrow functions
      const functionStart = newContent.indexOf(match);
      const bodyStart = functionStart + match.length;
      let braceCount = 1;
      let bodyEnd = bodyStart;
      
      for (let i = bodyStart; i < newContent.length && braceCount > 0; i++) {
        if (newContent[i] === '{') braceCount++;
        else if (newContent[i] === '}') braceCount--;
        bodyEnd = i;
      }
      
      const body = newContent.substring(bodyStart, bodyEnd);
      const underscoreParams = params.match(/_\w+/g) || [];
      let modifiedParams = params;
      let paramChanged = false;
      
      for (const underscoreParam of underscoreParams) {
        const cleanParam = underscoreParam.substring(1);
        const cleanParamRegex = new RegExp(`\\b${cleanParam}\\b`);
        
        if (cleanParamRegex.test(body)) {
          modifiedParams = modifiedParams.replace(underscoreParam, cleanParam);
          paramChanged = true;
          fileChanges++;
        }
      }
      
      if (paramChanged) {
        return match.replace(params, modifiedParams);
      }
      
      return match;
    });
  }

  // Write file if changes were made
  if (fileChanges > 0) {
    writeFileSync(file, newContent);
    console.log(`✅ Fixed ${fileChanges} underscore mismatches in ${file}`);
    modifiedFiles++;
    totalChanges += fileChanges;
  }
}

console.log(`\n🎯 Results:`);
console.log(`   Modified: ${modifiedFiles} files`);
console.log(`   Total: ${files.length} files`);
console.log(`   Success rate: ${((modifiedFiles / files.length) * 100).toFixed(1)}%`);
console.log(`   Total changes: ${totalChanges}`); 
