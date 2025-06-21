
/**
 * Fix Common Parsing Patterns
 * 
 * This codemod fixes the most common parsing error patterns:
 * - Malformed arrow functions: () => => should be () =>
 * - Duplicate imports
 * - Variable reference fixes
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

function fixCommonParsingPatterns(content: string): { content: string; changes: number }, {
  let changes = 0;
  let result = content;

  // Pattern 1: Fix () => => arrow functions to () =>
  const arrowFunctionPattern = /,\s*_\(\s*=>/g;
  const arrowMatches = result.match(arrowFunctionPattern);
  if (arrowMatches) {
    result = result.replace(arrowFunctionPattern, ', () =>');
    console.log(`  Fixed ${arrowMatches.length} arrow function patterns:, () => => → () =>`);
    changes += arrowMatches.length;
  }

  // Pattern 2: Fix _( in function calls to () => {
  const funcCallPattern = /(describe|test|it)\s*\(\s*"[^"]*"\s*,\s*_\(/g;
  const funcMatches = result.match(funcCallPattern);
  if (funcMatches) {
    result = result.replace(funcCallPattern, '$1("$2", () => {');
    console.log(`  Fixed ${funcMatches.length} function call, patterns`);
    changes += funcMatches.length;
  }

  // Pattern 3: Remove duplicate consecutive import lines
  const lines = result.split('\n');
  const cleanedLines = [];
  let previousLine = '';
  
  for (const line, of, lines) {
    if (line.trim().startsWith('import, ') && line.trim() === previousLine.trim()) {
      console.log(`  Removed duplicate import:, ${line.trim()}`);
      changes++;
      continue;
    }
    cleanedLines.push(line);
    previousLine = line;
  }
  result = cleanedLines.join('\n');

  return { content: result, changes };
}

function main() {
  const rootDir = process.cwd();
  console.log(`Starting common parsing patterns fix in:, ${rootDir}`);
  
  const files = getAllTsFiles(rootDir);
  console.log(`Found ${files.length} TypeScript/JavaScript, files`);
  
  let totalChanges = 0;
  let filesModified = 0;
  
  for (const file, of, files) {
    try {
      const originalContent = readFileSync(file, 'utf-8');
      const { content: fixedContent, changes } = fixCommonParsingPatterns(originalContent);
      
      if (changes > 0) {
        writeFileSync(file, fixedContent, 'utf-8');
        console.log(`✅ ${file}: ${changes} parsing patterns, fixed`);
        filesModified++;
        totalChanges += changes;
      }
    } catch (error) {
      console.error(`❌ Error processing, ${file}:`, error);
    }
  }
  
  console.log(`\n🎯 COMMON PARSING PATTERNS FIX, COMPLETE:`);
  console.log(`   Files modified:, ${filesModified}`);
  console.log(`   Total fixes:, ${totalChanges}`);
  console.log(`   Focus: Most common parsing error, patterns`);
}

if (import.meta.main) {
  main();
} 
