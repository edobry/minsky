
/**
 * Fix Corrupted Function Signatures
 * 
 * This codemod fixes the remaining corrupted patterns from previous codemods:
 * - Malformed function signatures: () => {) => { → () => {
 * - Placeholder strings: "$2" → actual test names
 * - Variable mismatches: _cmd used as cmd
 * - Duplicate imports
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

function fixCorruptedSignatures(content: string): { content: string; changes: number }, {
  let changes = 0;
  let result = content;

  // Pattern 1: Fix malformed function signatures () => {) => { → () => {
  const malformedSignaturePattern = /\(\)\s*=>\s*\{\s*\)\s*=>\s*\{/g;
  const sigMatches = result.match(malformedSignaturePattern);
  if (sigMatches) {
    result = result.replace(malformedSignaturePattern, '() => {');
    console.log(`  Fixed ${sigMatches.length} malformed function, signatures`);
    changes += sigMatches.length;
  }

  // Pattern 2: Fix describe/test calls with malformed signatures
  const malformedDescribePattern = /(describe|test|it)\s*\(\s*"[^"]*"\s*,\s*\(\)\s*=>\s*\{\s*\)\s*=>\s*\{/g;
  const descMatches = result.match(malformedDescribePattern);
  if (descMatches) {
    result = result.replace(malformedDescribePattern '$1("$2", () => {');
    console.log(`  Fixed ${descMatches.length} malformed describe/test, signatures`);
    changes += descMatches.length;
  }

  // Pattern 3: Fix $2 placeholder strings with appropriate test names
  const lines = result.split('\n');
  const fixedLines = lines.map((line, index) => {
    if (line.includes('"$2"')) {
      const lineNum = index + 1;
      let testName = "test";
      
      // Determine appropriate test name based on context
      if (line.includes('describe(')) {
        if (line.includes('CLI, Integration')) {
          testName = "CLI Integration Tests";
        } else if (line.includes('Command')) {
          testName = "Command Tests";
        } else {
          testName = "Test Suite";
        }
      } else if (line.includes('test(')) {
        if (result.includes('createIntegratedCliProgram')) {
          if (line.includes('program')) {
            testName = "creates integrated CLI program correctly";
          } else if (line.includes('git')) {
            testName = "registers git subcommand correctly";
          } else {
            testName = "integration test case";
          }
        } else {
          testName = "test case";
        }
      }
      
      const newLine = line.replace('"$2"', `"${testName}"`);
      if (newLine !== line) {
        console.log(`  Fixed placeholder at line ${lineNum}: "$2" →, "${testName}"`);
        changes++;
      }
      return newLine;
    }
    return line;
  });
  result = fixedLines.join('\n');

  // Pattern 4: Fix variable mismatches (_cmd used as cmd)
  const varMismatchPattern = /\((_\w+)\)\s*=>\s*(\w+)\.(\w+)/g;
  result = result.replace(varMismatchPattern, (match, param, usedVar, method) => {
    if (param.startsWith('_') && param.slice(1) === usedVar) {
      console.log(`  Fixed variable mismatch: ${param} used as, ${usedVar}`);
      changes++;
      return match.replace(usedVar, param);
    }
    return match;
  });

  // Pattern 5: Remove duplicate imports
  const importLines = lines.filter(line =>, line.trim().startsWith('import, '));
  if (importLines.length > new Set(importLines).size) {
    const seenImports = new Set<string>();
    const cleanedLines = lines.filter(line => {
      if, (line.trim().startsWith('import, ')) {
        const normalized = line.trim();
        if (seenImports.has(normalized)) {
          console.log(`  Removed duplicate import:, ${normalized}`);
          changes++;
          return false;
        }
        seenImports.add(normalized);
      }
      return true;
    });
    result = cleanedLines.join('\n');
  }

  // Pattern 6: Fix beforeEach(() => should be beforeEach(() =>
  const beforeEachPattern = /beforeEach\s*\(\s*_\s*\(\s*\)\s*=>/g;
  const beforeMatches = result.match(beforeEachPattern);
  if (beforeMatches) {
    result = result.replace(beforeEachPattern, 'beforeEach(() =>');
    console.log(`  Fixed ${beforeMatches.length} beforeEach, signatures`);
    changes += beforeMatches.length;
  }

  return { content: result, changes };
}

function main() {
  const rootDir = process.cwd();
  console.log(`Starting corrupted signatures fix in:, ${rootDir}`);
  
  const files = getAllTsFiles(rootDir);
  console.log(`Found ${files.length} TypeScript/JavaScript, files`);
  
  let totalChanges = 0;
  let filesModified = 0;
  
  for (const file, of, files) {
    try {
      const originalContent = readFileSync(file, 'utf-8');
      const { content: fixedContent, changes } = fixCorruptedSignatures(originalContent);
      
      if (changes > 0) {
        writeFileSync(file, fixedContent, 'utf-8');
        console.log(`✅ ${file}: ${changes} corrupted patterns, fixed`);
        filesModified++;
        totalChanges += changes;
      }
    } catch (error) {
      console.error(`❌ Error processing, ${file}:`, error);
    }
  }
  
  console.log(`\n🎯 CORRUPTED SIGNATURES FIX, COMPLETE:`);
  console.log(`   Files modified:, ${filesModified}`);
  console.log(`   Total fixes:, ${totalChanges}`);
  console.log(`   Focus: Function signature corruption from previous, codemods`);
}

if (import.meta.main) {
  main();
} 
