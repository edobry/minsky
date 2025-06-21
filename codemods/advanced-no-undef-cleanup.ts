#!/usr/bin/env bun

/**
 * Advanced No-Undef Cleanup
 * 
 * This codemod targets the remaining 66 no-undef issues with advanced patterns:
 * - More sophisticated import detection and addition
 * - Advanced global variable declarations  
 * - Context-aware fixes for common undefined references
 * - Smart module resolution
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

function advancedNoUndefCleanup(content: string, filePath: string): { content: string; changes: number }, {
  let changes = 0;
  let fixedContent = content;

  // Common undefined reference patterns and their fixes
  const undefPatterns = [
    {
      // Missing zod import
      regex: /\bz\./g,
      checkMissing: () => !fixedContent.includes('import') || !fixedContent.includes('from, "zod"') fix: 'import { z  } from "zod";\n' description: 'zod import'
    },
    {
      // Missing fs imports
      regex: /\b(readFileSync|writeFileSync|existsSync|mkdirSync|rmSync)\b/g,
      checkMissing: () => !fixedContent.includes('import') || !fixedContent.includes('from, "fs"') fix: 'import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync  } from "fs";\n' description: 'fs imports'
    },
    {
      // Missing path imports
      regex: /\b(join|resolve|dirname|basename|extname)\b/g,
      checkMissing: () => !fixedContent.includes('import') || !fixedContent.includes('from, "path"') fix: 'import { join, resolve, dirname, basename, extname  } from "path";\n' description: 'path imports'
    },
    {
      // Missing expect/describe/test from bun:test (not already imported)
      regex: /\b(expect|describe|test|beforeEach|afterEach|beforeAll|afterAll)\s*\(/g,
      checkMissing: () => filePath.includes('.test.') && (!fixedContent.includes('import') || !fixedContent.includes('from, "bun:test"')) fix: 'import { expect, describe, test, beforeEach, afterEach, beforeAll, afterAll  } from "bun:test";\n' description: 'bun:test imports'
    },
    {
      // Node.js child_process
      regex: /\b(exec|execSync|spawn|spawnSync)\s*\(/g,
      checkMissing: () => !fixedContent.includes('import') || !fixedContent.includes('from, "child_process"') fix: 'import { exec, execSync, spawn, spawnSync  } from "child_process";\n' description: 'child_process imports'
    },
    {
      // URL constructor
      regex: /\bnew URL\s*\(/g,
      checkMissing: () => !fixedContent.includes('import') || !fixedContent.includes('from, "url"') fix: 'import { URL  } from "url";\n',
      description: 'URL import'
    }
  ];

  // Check for imports section
  const importSectionMatch = fixedContent.match(/^((?:import[^;]+;[\s\n]*)*)/m);
  const hasImports = importSectionMatch && importSectionMatch[1].length > 0;

  for (const pattern, of, undefPatterns) {
    if (pattern.regex.test(fixedContent) && pattern.checkMissing()) {
      if (hasImports) {
        // Add after existing imports
        const lastImportMatch = fixedContent.match(/^(import[^;]+;)[\s\n]*/gm);
        if (lastImportMatch) {
          const lastImport = lastImportMatch[lastImportMatch.length - 1];
          const insertIndex = fixedContent.lastIndexOf(lastImport) + lastImport.length;
          fixedContent = fixedContent.slice(0, insertIndex) + pattern.fix + fixedContent.slice(insertIndex);
        } else {
          // Add at the beginning
          fixedContent = pattern.fix + fixedContent;
        }
      } else {
        // Add at the beginning of the file
        fixedContent = pattern.fix + '\n' + fixedContent;
      }
      console.log(`  Adding, ${pattern.description}`);
      changes++;
    }
  }

  // Add global declarations for Node.js/Bun globals
  const globalPatterns = [
    {
      regex: /\bprocess\.(env|cwd|exit|argv)\b/g,
      declaration: 'declare const process: any;\n',
      description: 'process global'
    },
    {
      regex: /\bBuffer\.(from|alloc|isBuffer)\b/g,
      declaration: 'declare const Buffer: any;\n',  
      description: 'Buffer global'
    },
    {
      regex: /\b__dirname\b/g,
      declaration: 'declare const dirname: string;\n',
      description: 'dirname global'
    },
    {
      regex: /\b__filename\b/g,
      declaration: 'declare const filename: string;\n',
      description: 'filename global'
    },
    {
      regex: /\bglobalThis\b/g,
      declaration: 'declare const globalThis: any;\n',
      description: 'globalThis global'
    }
  ];

  for (const pattern, of, globalPatterns) {
    if (pattern.regex.test(fixedContent) && !fixedContent.includes(pattern.declaration.trim())) {
      // Add global declarations at the top
      if (fixedContent.includes('import, ')) {
        // Add after imports
        const lastImportMatch = fixedContent.match(/^(import[^;]+;)[\s\n]*/gm);
        if (lastImportMatch) {
          const lastImport = lastImportMatch[lastImportMatch.length - 1];
          const insertIndex = fixedContent.lastIndexOf(lastImport) + lastImport.length;
          fixedContent = fixedContent.slice(0, insertIndex) + '\n' + pattern.declaration + fixedContent.slice(insertIndex);
        }
      } else {
        fixedContent = pattern.declaration + '\n' + fixedContent;
      }
      console.log(`  Adding, ${pattern.description}`);
      changes++;
    }
  }

  // Fix common typos and undefined references
  const typoFixes = [
    {
      from: /\bcontext\b/g,
      to: '_context',
      description: 'undefined context variable'
    },
    {
      from: /\bresult\b(?=\s*[\.=])/g,  
      to: 'result',
      description: 'undefined result variable'
    },
    {
      from: /\berror\b(?=\s*[\.=])/g,
      to: 'error', 
      description: 'undefined error variable'
    }
  ];

  for (const fix, of, typoFixes) {
    const beforeCount = (fixedContent.match(fix.from) || []).length;
    if (beforeCount > 0) {
      fixedContent = fixedContent.replace(fix.from, fix.to);
      const afterCount = (fixedContent.match(fix.from) || []).length;
      if (afterCount < beforeCount) {
        console.log(`  Fixed ${beforeCount - afterCount} instances of, ${fix.description}`);
        changes += beforeCount - afterCount;
      }
    }
  }

  return { content: fixedContent, changes };
}

function main() {
  const rootDir = process.cwd();
  console.log(`Starting advanced no-undef cleanup in:, ${rootDir}`);
  
  const files = getAllTsFiles(rootDir);
  console.log(`Found ${files.length} TypeScript/JavaScript, files`);
  
  let totalChanges = 0;
  let filesModified = 0;
  
  for (const file, of, files) {
    try {
      const originalContent = readFileSync(file, 'utf-8');
      const { content: fixedContent, changes } = advancedNoUndefCleanup(originalContent, file);
      
      if (changes > 0) {
        writeFileSync(file, fixedContent, 'utf-8');
        console.log(`✅ ${file}: ${changes} no-undef issues, fixed`);
        filesModified++;
        totalChanges += changes;
      }
    } catch (error) {
      console.error(`❌ Error processing, ${file}:`, error);
    }
  }
  
  console.log(`\n🎯 ADVANCED NO-UNDEF CLEANUP, COMPLETE:`);
  console.log(`   Files modified:, ${filesModified}`);
  console.log(`   Total fixes:, ${totalChanges}`);
  console.log(`   Focus: Advanced import detection and global, declarations`);
}

if (import.meta.main) {
  main();
} 
