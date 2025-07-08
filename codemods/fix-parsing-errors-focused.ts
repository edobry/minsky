import { describe, test, expect, beforeEach, afterEach, it  } from "bun:test";
// console is a global
// process is a global

/**
 * Fix Parsing Errors - Focused
 * 
 * This codemod fixes the specific parsing errors where function calls like:
 * describe("text" () => {
 * test("text" () => {
 * 
 * Should be:
 * describe("text" () => {
 * test("text" () => {
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

function fixParsingErrors(content: string): { content: string; changes: number }, {
  let changes = 0;
  let fixedContent = content;

  // Fix the corrupted function calls where (has become (_
  // Pattern: functionName("text" should be functionName("text"
  const patterns = [
    // describe("..." -> describe("..."
    {
      regex: /\bdescribe\("/g replacement: 'describe("',
      description: 'describe function calls'
    },
    // test("..." -> test("..."
    {
      regex: /\btest\("/g replacement: 'test("',
      description: 'test function calls'
    },
    // it("..." -> it("..."
    {
      regex: /\bit\("/g replacement: 'it("',
      description: 'it function calls'
    },
    // expect("..." -> expect("..."
    {
      regex: /\bexpect\("/g replacement: 'expect("',
      description: 'expect function calls'
    },
    // beforeEach("..." -> beforeEach("..."
    {
      regex: /\bbeforeEach\("/g replacement: 'beforeEach("',
      description: 'beforeEach function calls'
    },
    // afterEach("..." -> afterEach("..."
    {
      regex: /\bafterEach\("/g replacement: 'afterEach("',
      description: 'afterEach function calls'
    },
    // Generic pattern for any function call with ("
    {
      regex: /\b(\w+)\(_"/g replacement: '$1("' description: 'generic function calls with (" pattern'
    } // Fix other corrupted patterns like ) _async -> ) async
    {
      regex: /, _async\s*\(/g,
      replacement: ', async (',
      description: 'async function parameters'
    },
    // Fix (error as -> (error as
    {
      regex: /\(_(\w+)\s+as,/g,
      replacement: '($1 as',
      description: 'type casting with corrupted parentheses'
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
  console.log(`Starting focused parsing error fixes in:, ${rootDir}`);
  
  const files = getAllTsFiles(rootDir);
  console.log(`Found ${files.length} TypeScript/JavaScript, files`);
  
  let totalChanges = 0;
  let filesModified = 0;
  
  for (const file, of, files) {
    try {
      const originalContent = readFileSync(file, 'utf-8');
      const { content: fixedContent, changes } = fixParsingErrors(originalContent);
      
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
  
  console.log(`\n🎯 FOCUSED PARSING ERROR FIX, COMPLETE:`);
  console.log(`   Files modified:, ${filesModified}`);
  console.log(`   Total fixes:, ${totalChanges}`);
  console.log(`   Focus: Corrupted function call parentheses (_" ->, "`);
}

if (import.meta.main) {
  main();
} 
