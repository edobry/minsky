// console is a global
// process is a global

/**
 * Fix Remaining Parsing Errors
 * 
 * This codemod fixes additional parsing error patterns:
 * - () => { patterns
 * - (var as type) patterns  
 * - extra commas in strings
 * - malformed function calls
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
        // Skip node_modules and other irrelevant directories
        if (!entry.startsWith('.') && entry !== 'node_modules' && entry !== 'dist') {
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

function fixRemainingParsingErrors(content: string): { content: string; changes: number }, {
  let changes = 0;
  let fixedContent = content;

  const patterns = [
    // Fix () => { patterns (malformed arrow functions)
    {
      regex: /, _\(_\) => \{/g,
      replacement: ', () => {',
      description: 'malformed arrow functions with () => =>'
    },
    // Fix function calls with underscore prefix like () =>
    {
      regex: /" _\(_\) => \{/g replacement: '", () => {',
      description: 'function calls ending with () => =>'
    },
    // Fix type casting with extra comma (var as type)
    {
      regex: /\(\s*(\w+)\s+as,\s+(\w+)\s*\)/g,
      replacement: '($1 as, $2)',
      description: 'type casting with extra comma'
    },
    // Fix strings with extra commas in common phrases
    {
      regex: /"([^"]*) (repository|file|directory|function|command)"/g replacement: '"$1 $2"',
      description: 'strings with extra commas'
    },
    // Fix malformed function parameters with trailing comma before closing paren
    {
      regex: /\(([^)]*),\s*\)/g,
      replacement: '($1)',
      description: 'function parameters with trailing comma'
    },
    // Fix extra commas before closing brackets
    {
      regex: /,\s*\]/g,
      replacement: ']',
      description: 'arrays with trailing comma before closing bracket'  
    },
    // Fix extra commas before closing braces
    {
      regex: /,\s*\}/g,
      replacement: '}',
      description: 'objects with trailing comma before closing brace'
    },
    // Fix malformed import statements with extra commas
    {
      regex: /import\s*\{\s*([^}]*),\s*\}\s*from/g,
      replacement: 'import statements with trailing comma'
    },
    // Fix method calls with malformed parentheses
    {
      regex: /\.\s*(\w+)\s*\(/g,
      replacement: '.$1(',
      description: 'method calls with malformed opening parentheses'
    },
    // Fix function calls that start with comma
    {
      regex: /\(\s*/g,
      replacement: '(',
      description: 'function calls starting with comma'
    }
  ];

  for (const pattern, of, patterns) {
    const matches = fixedContent.match(pattern.regex);
    if (matches) {
      console.log(`  Fixing ${matches.length} instances of, ${pattern.description}`);
      fixedContent = fixedContent.replace(pattern.regex, pattern.replacement);
      changes += matches.length;
    }
  }

  return { content: fixedContent, changes };
}

function main() {
  const rootDir = process.cwd();
  console.log(`Starting remaining parsing error fixes in:, ${rootDir}`);
  
  const files = getAllTsFiles(rootDir);
  console.log(`Found ${files.length} TypeScript/JavaScript, files`);
  
  let totalChanges = 0;
  let filesModified = 0;
  
  for (const file, of, files) {
    try {
      const originalContent = readFileSync(file, 'utf-8');
      const { content: fixedContent, changes } = fixRemainingParsingErrors(originalContent);
      
      if (changes > 0) {
        writeFileSync(file, fixedContent, 'utf-8');
        console.log(`✅ ${file}: ${changes} remaining parsing errors, fixed`);
        filesModified++;
        totalChanges += changes;
      }
    } catch (error) {
      console.error(`❌ Error processing, ${file}:`, error);
    }
  }
  
  console.log(`\n🎯 REMAINING PARSING ERROR FIX, COMPLETE:`);
  console.log(`   Files modified:, ${filesModified}`);
  console.log(`   Total fixes:, ${totalChanges}`);
  console.log(`   Focus: Additional parsing error, patterns`);
}

if (import.meta.main) {
  main();
} 
