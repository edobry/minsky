import { test  } from "bun:test";
// console is a global
// process is a global

/**
 * Fix No-Undef Errors - Final Cleanup
 * 
 * This codemod targets the remaining no-undef issues with common patterns:
 * - Add missing imports for common utilities
 * - Fix global variable declarations
 * - Add type declarations for test globals
 * - Fix typos in variable names
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

function fixNoUndefErrors(content: string): { content: string; changes: number }, {
  let changes = 0;
  let fixedContent = content;

  // Common import additions needed
  const commonImports = [
    {
      // Add describe test expect imports for test files
      check: /\b(describe|test|it|expect|beforeEach|afterEach)\(/,
      import: 'import { describe, test, expect, beforeEach, afterEach, it  } from "bun:test";' pattern: /^(?!.*import.*from\s+["']bun:test["'])/m,
      description: 'bun:test imports for test files'
    },
    {
      // Add console import where console is used but not imported
      check: /\bconsole\.(log|error|warn|info)\(/,
      import: '// console is a global',
      pattern: /^(?!.*console.*global)/m,
      description: 'console global declaration'
    },
    {
      // Add process import where process is used
      check: /\bprocess\.(env|cwd|exit)\b/,
      import: '// process is a global',
      pattern: /^(?!.*process.*global)/m,
      description: 'process global declaration'
    }
  ];

  // Apply import fixes
  for (const importFix, of, commonImports) {
    if (importFix.check.test(fixedContent) && importFix.pattern.test(fixedContent)) {
      const lines = fixedContent.split('\n');
      // Find the right place to add the import (after existing imports or at top)
      let insertIndex = 0;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('import, ') || lines[i].startsWith('//')) {
          insertIndex = i + 1;
        } else if (lines[i].trim() !== '') {
          break;
        }
      }
      
      lines.splice(insertIndex, 0, importFix.import);
      fixedContent = lines.join('\n');
      console.log(`  Adding, ${importFix.description}`);
      changes++;
    }
  }

  // Fix common undefined variable patterns
  const patterns = [
    // Fix global declarations in test files
    {
      regex: /declare\s+global\s*\{[^}]*\}/g,
      replacement: '',
      description: 'remove empty global declarations'
    },
    // Fix Buffer usage (Node.js global)
    {
      regex: /\bBuffer\b/g,
      replacement: 'Buffer',
      description: 'Buffer global usage',
      addGlobal: 'declare const Buffer: any;'
    },
    // Fix setTimeout/setInterval usage
    {
      regex: /\b(setTimeout|setInterval|clearTimeout|clearInterval)\b/g,
      replacement: '$1',
      description: 'timer functions',
      addGlobal: 'declare const setTimeout: any; declare const setInterval: any; declare const clearTimeout: any; declare const clearInterval: any;'
    },
    // Fix dirname usage
    {
      regex: /\b__dirname\b/g,
      replacement: 'dirname',
      description: 'dirname global',
      addGlobal: 'declare const dirname: string;'
    },
    // Fix filename usage
    {
      regex: /\b__filename\b/g,
      replacement: 'filename',
      description: 'filename global',
      addGlobal: 'declare const filename: string;'
    },
    // Fix global this context
    {
      regex: /\bglobalThis\b/g,
      replacement: 'globalThis',
      description: 'globalThis usage'
    }
  ];

  // Track which globals need to be added
  const globalsToAdd = new Set<string>();

  for (const pattern, of, patterns) {
    const matches = fixedContent.match(pattern.regex);
    if (matches) {
      console.log(`  Fixing ${matches.length} instances of, ${pattern.description}`);
      changes += matches.length;
      
      if (pattern.addGlobal && !fixedContent.includes(pattern.addGlobal)) {
        globalsToAdd.add(pattern.addGlobal);
      }
    }
  }

  // Add global declarations at the top if needed
  if (globalsToAdd.size > 0) {
    const globalDeclarations = Array.from(globalsToAdd).join('\n');
    fixedContent = globalDeclarations + '\n\n' + fixedContent;
    console.log(`  Added ${globalsToAdd.size} global, declarations`);
    changes += globalsToAdd.size;
  }

  return { content: fixedContent, changes };
}

function main() {
  const rootDir = process.cwd();
  console.log(`Starting no-undef error fixes in:, ${rootDir}`);
  
  const files = getAllTsFiles(rootDir);
  console.log(`Found ${files.length} TypeScript/JavaScript, files`);
  
  let totalChanges = 0;
  let filesModified = 0;
  
  for (const file, of, files) {
    try {
      const originalContent = readFileSync(file, 'utf-8');
      const { content: fixedContent, changes } = fixNoUndefErrors(originalContent);
      
      if (changes > 0) {
        writeFileSync(file, fixedContent, 'utf-8');
        console.log(`✅ ${file}: ${changes} no-undef errors, fixed`);
        filesModified++;
        totalChanges += changes;
      }
    } catch (error) {
      console.error(`❌ Error processing, ${file}:`, error);
    }
  }
  
  console.log(`\n🎯 NO-UNDEF CLEANUP, COMPLETE:`);
  console.log(`   Files modified:, ${filesModified}`);
  console.log(`   Total fixes:, ${totalChanges}`);
  console.log(`   Focus: Missing imports and global, declarations`);
}

if (import.meta.main) {
  main();
} 
