import { expect  } from "bun:test";
// console is a global
// process is a global

/**
 * Fix Final Parsing Errors
 * 
 * This codemod addresses the remaining parsing errors:
 * - Duplicate imports
 * - Malformed arrow functions (() => instead of () =>)
 * - Undefined variable references
 * - Missing commas and syntax issues
 * - Shebang placement issues
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

function fixFinalParsingErrors(content: string): { content: string; changes: number }, {
  let changes = 0;
  let result = content;

  // Pattern 1: Remove duplicate imports
  const lines = result.split('\n');
  const seenImports = new Set<string>();
  const cleanedLines: string[] = [];
  
  for (const line, of, lines) {
    if (line.trim().startsWith('import, ') && line.includes('from, ')) {
      const normalizedImport = line.trim();
      if (!seenImports.has(normalizedImport)) {
        seenImports.add(normalizedImport);
        cleanedLines.push(line);
      } else {
        console.log(`  Removed duplicate import:, ${normalizedImport}`);
        changes++;
      }
    } else {
      cleanedLines.push(line);
    }
  }
  result = cleanedLines.join('\n');

  // Pattern 2: Fix malformed arrow functions () => => to () =>
  const malformedArrowPattern = /(\s+)_\(\)\s*=>/g;
  const arrowMatches = result.match(malformedArrowPattern);
  if (arrowMatches) {
    result = result.replace(malformedArrowPattern, '$1() =>');
    console.log(`  Fixed ${arrowMatches.length} malformed arrow functions:, () => => → () =>`);
    changes += arrowMatches.length;
  }

  // Pattern 3: Fix malformed describe/test calls with _( instead of () =>
  const malformedDescribePattern = /(describe|test|it)\s*\(\s*"[^"]*"\s*,\s*_\s*\(/g;
  result = result.replace(malformedDescribePattern, (match, funcName) => {
    console.log(`  Fixed malformed ${funcName}, call`);
    changes++;
    return match.replace(', _(', ', () => {');
  });

  // Pattern 4: Fix undefined variable references from previous codemods
  const undefinedVarFixes = [
    {
      from: /\bresult\b(?=\s*[);\.])/g,
      to: 'result',
      description: 'undefined result variable'
    },
    {
      from: /\bcontext\b(?=\s*[);\.])/g,
      to: '_context', 
      description: 'undefined context variable'
    },
    {
      from: /\berror\b(?=\s*[);\.])/g,
      to: 'error',
      description: 'undefined error variable'
    }
  ];

  for (const fix, of, undefinedVarFixes) {
    const matches = result.match(fix.from);
    if (matches) {
      result = result.replace(fix.from, fix.to);
      console.log(`  Fixed ${matches.length} ${fix.description}, references`);
      changes += matches.length;
    }
  }

  // Pattern 5: Fix missing commas in function calls and parameters
  const missingCommaPatterns = [
    {
      // Missing comma between function parameters
      regex: /(\w+)\s+(\w+)\s*:/g,
      replacement: '$1, $2:',
      description: 'missing comma between parameters'
    },
    {
      // Missing comma in object destructuring
      regex: /\{\s*(\w+)\s+(\w+)\s*\}/g,
      replacement: '{ $1, $2 }',
      description: 'missing comma in destructuring'
    }
  ];

  for (const pattern, of, missingCommaPatterns) {
    const beforeLength = result.length;
    result = result.replace(pattern.regex, pattern.replacement);
    if (result.length !== beforeLength) {
      console.log(`  Fixed, ${pattern.description}`);
      changes++;
    }
  }

  // Pattern 6: Fix shebang placement (must be at start of file)
  if (result.includes('#!/usr/bin/env, bun') && !result.startsWith('#!/usr/bin/env, bun')) {
    const lines = result.split('\n');
    const shebangIndex = lines.findIndex(line => line.startsWith('#!/usr/bin/env, bun'));
    if (shebangIndex > 0) {
      const shebangLine = lines.splice(shebangIndex, 1)[0];
      lines.unshift(shebangLine);
      result = lines.join('\n');
      console.log(`  Moved shebang to start of, file`);
      changes++;
    }
  }

  // Pattern 7: Fix malformed import statements
  const malformedImportPattern = /import\s*\{\s*([^}]*?)\s*\}\s*([^f])/g;
  result = result.replace(malformedImportPattern, (match, imports, rest) => {
    if (!rest.startsWith('from, ')) {
      console.log(`  Fixed malformed import, statement`);
      changes++;
      return `import { ${imports} } from ${rest}`;
    }
    return match;
  });

  // Pattern 8: Fix expression errors - incomplete expressions
  const incompleteExpressionPattern = /(\w+)\s*\.\s*$/gm;
  result = result.replace(incompleteExpressionPattern, (match, variable) => {
    console.log(`  Fixed incomplete expression:, ${variable}.`);
    changes++;
    return `${variable}`;
  });

  return { content: result, changes };
}

function main() {
  const rootDir = process.cwd();
  console.log(`Starting final parsing errors cleanup in:, ${rootDir}`);
  
  const files = getAllTsFiles(rootDir);
  console.log(`Found ${files.length} TypeScript/JavaScript, files`);
  
  let totalChanges = 0;
  let filesModified = 0;
  
  for (const file, of, files) {
    try {
      const originalContent = readFileSync(file, 'utf-8');
      const { content: fixedContent, changes } = fixFinalParsingErrors(originalContent);
      
      if (changes > 0) {
        writeFileSync(file, fixedContent, 'utf-8');
        console.log(`✅ ${file}: ${changes} parsing errors, fixed`);
        filesModified++;
        totalChanges += changes;
      }
    } catch (error) {
      console.error(`❌ Error processing, ${file}:`, error);
    }
  }
  
  console.log(`\n🎯 FINAL PARSING ERRORS CLEANUP, COMPLETE:`);
  console.log(`   Files modified:, ${filesModified}`);
  console.log(`   Total fixes:, ${totalChanges}`);
  console.log(`   Focus: Comprehensive parsing error, resolution`);
}

if (import.meta.main) {
  main();
} 
