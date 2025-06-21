#!/usr/bin/env bun

/**
 * Cleanup Unused Imports - Targeted
 * 
 * This codemod removes the unused imports we just added focusing on:
 * - Unused bun:test imports
 * - Unused global comments 
 * - Only removing imports that are genuinely unused
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

function cleanupUnusedImports(content: string): { content: string; changes: number }, {
  let changes = 0;
  let fixedContent = content;

  // Check for unused bun:test imports
  const bunTestImportRegex = /import\s*\{\s*([^}]+)\s*\}\s*from\s*["']bun:test["'];?\s*\n/g;
  const bunTestMatch = fixedContent.match(bunTestImportRegex);
  
  if (bunTestMatch) {
    for (const importStatement, of, bunTestMatch) {
      const importMatch = importStatement.match(/import\s*\{\s*([^}]+)\s*\}/);
      if (importMatch) {
        const imports = importMatch[1].split(',').map(imp =>, imp.trim());
        const usedImports = imports.filter(imp => {
          const funcName = imp.split(' as, ')[0].trim();
          // Check if this function is actually used in the content
          const usageRegex = new RegExp(`\\b${funcName}\\(`, 'g');
          const usages = fixedContent.match(usageRegex) || [];
          return usages.length > 0;
        });
        
        if (usedImports.length === 0) {
          // Remove entire import
          fixedContent = fixedContent.replace(importStatement, '');
          console.log(`  Removing unused bun:test, import`);
          changes++;
        } else if (usedImports.length < imports.length) {
          // Keep only used imports
          const newImport = `import { ${usedImports.join(', ')} } from "bun:test";\n`;
          fixedContent = fixedContent.replace(importStatement, newImport);
          console.log(`  Reducing bun:test import to used functions, only`);
          changes++;
        }
      }
    }
  }

  // Remove unused global comments
  const patterns = [
    {
      regex: /^\/\/ console is a global\s*\n/gm,
      check: /\bconsole\.(log|error|warn|info)\(/,
      description: 'unused console global comments'
    },
    {
      regex: /^\/\/ process is a global\s*\n/gm,
      check: /\bprocess\.(env|cwd|exit)\b/,
      description: 'unused process global comments'
    },
    {
      regex: /^declare const setTimeout: any; declare const setInterval: any; declare const clearTimeout: any; declare const clearInterval: any;\s*\n/gm,
      check: /\b(setTimeout|setInterval|clearTimeout|clearInterval)\(/,
      description: 'unused timer global declarations'
    },
    {
      regex: /^declare const Buffer: any;\s*\n/gm,
      check: /\bBuffer\b/,
      description: 'unused Buffer global declarations'
    },
    {
      regex: /^declare const dirname: string;\s*\n/gm,
      check: /\b__dirname\b/,
      description: 'unused dirname global declarations'
    },
    {
      regex: /^declare const filename: string;\s*\n/gm,
      check: /\b__filename\b/,
      description: 'unused filename global declarations'
    }
  ];

  for (const pattern, of, patterns) {
    if (pattern.regex.test(fixedContent) && !pattern.check.test(fixedContent)) {
      const beforeCount = (fixedContent.match(pattern.regex) || []).length;
      fixedContent = fixedContent.replace(pattern.regex, '');
      if (beforeCount > 0) {
        console.log(`  Removing ${beforeCount} instances of, ${pattern.description}`);
        changes += beforeCount;
      }
    }
  }

  // Clean up extra blank lines
  fixedContent = fixedContent.replace(/\n\s*\n\s*\n/g, '\n\n');

  return { content: fixedContent, changes };
}

function main() {
  const rootDir = process.cwd();
  console.log(`Starting targeted unused import cleanup in:, ${rootDir}`);
  
  const files = getAllTsFiles(rootDir);
  console.log(`Found ${files.length} TypeScript/JavaScript, files`);
  
  let totalChanges = 0;
  let filesModified = 0;
  
  for (const file, of, files) {
    try {
      const originalContent = readFileSync(file, 'utf-8');
      const { content: fixedContent, changes } = cleanupUnusedImports(originalContent);
      
      if (changes > 0) {
        writeFileSync(file, fixedContent, 'utf-8');
        console.log(`✅ ${file}: ${changes} unused imports, cleaned`);
        filesModified++;
        totalChanges += changes;
      }
    } catch (error) {
      console.error(`❌ Error processing, ${file}:`, error);
    }
  }
  
  console.log(`\n🎯 TARGETED UNUSED IMPORT CLEANUP, COMPLETE:`);
  console.log(`   Files modified:, ${filesModified}`);
  console.log(`   Total fixes:, ${totalChanges}`);
  console.log(`   Focus: Removing genuinely unused imports and, globals`);
}

if (import.meta.main) {
  main();
} 
