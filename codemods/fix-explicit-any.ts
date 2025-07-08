#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'fs';
import { glob } from 'glob';

/**
 * Codemod to fix @typescript-eslint/no-explicit-any issues
 * Replace 'any' with more specific types where patterns are clear
 */

function fixExplicitAnyInFile(filePath: string): boolean {
  try {
    let content: string = readFileSync(filePath, 'utf-8') as string;
    let modified = false;
    const originalContent = content;

    // Common patterns where we can replace 'any' with better types
    
    // Pattern 1: Function parameters that should be unknown instead of any
    content = content.replace(/\(\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*any\s*\)/g, '($1: unknown)');
    
    // Pattern 2: Error handling - errors should be unknown
    content = content.replace(/catch\s*\(\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*any\s*\)/g, 'catch ($1: unknown)');
    
    // Pattern 3: Generic type parameters that default to any
    content = content.replace(/:\s*any\[\]/g, ': unknown[]');
    
    // Pattern 4: Object properties that are any
    content = content.replace(/:\s*any;/g, ': unknown;');
    content = content.replace(/:\s*any,/g, ': unknown,');
    content = content.replace(/:\s*any\s*\}/g, ': unknown }');
    
    // Pattern 5: Function return types
    content = content.replace(/\)\s*:\s*any\s*\{/g, '): unknown {');
    content = content.replace(/\)\s*:\s*any\s*=>/g, '): unknown =>');
    
    // Pattern 6: Variable declarations
    content = content.replace(/:\s*any\s*=/g, ': unknown =');
    
    // Pattern 7: Common data/result/response patterns that should be more specific
    content = content.replace(/(\bdata\s*:\s*)any\b/g, '$1unknown');
    content = content.replace(/(\bresult\s*:\s*)any\b/g, '$1unknown'); 
    content = content.replace(/(\bresponse\s*:\s*)any\b/g, '$1unknown');
    content = content.replace(/(\berror\s*:\s*)any\b/g, '$1unknown');
    content = content.replace(/(\bvalue\s*:\s*)any\b/g, '$1unknown');
    content = content.replace(/(\boptions\s*:\s*)any\b/g, '$1Record<string, unknown>');
    content = content.replace(/(\bconfig\s*:\s*)any\b/g, '$1Record<string, unknown>');
    content = content.replace(/(\bprops\s*:\s*)any\b/g, '$1Record<string, unknown>');
    content = content.replace(/(\bparams\s*:\s*)any\b/g, '$1Record<string, unknown>');

    // Pattern 8: Record types
    content = content.replace(/Record<string,\s*any>/g, 'Record<string, unknown>');
    content = content.replace(/Record<[^,]+,\s*any>/g, (match) => {
      return match.replace(/any>$/, 'unknown>');
    });

    if (content !== originalContent) {
      modified = true;
    }

    if (modified) {
      writeFileSync(filePath, content, 'utf-8');
      console.log(`✅ Fixed explicit any types in ${filePath}`);
      return true;
    }

    return false;
  } catch (error) {
    console.error(`❌ Error processing ${filePath}:`, error);
    return false;
  }
}

async function main() {
  console.log('🔧 Starting explicit any cleanup...');
  
  // Get all TypeScript files
  const files = await glob('src/**/*.ts', { ignore: ['node_modules/**', '**/*.d.ts'] });
  
  let fixedFiles = 0;
  let totalFiles = files.length;
  
  console.log(`📊 Processing ${totalFiles} TypeScript files...`);
  
  for (const file of files) {
    if (fixExplicitAnyInFile(file)) {
      fixedFiles++;
    }
  }
  
  console.log(`\n🎯 Results:`);
  console.log(`   Fixed: ${fixedFiles} files`);
  console.log(`   Total: ${totalFiles} files`);
  console.log(`   Success rate: ${((fixedFiles / totalFiles) * 100).toFixed(1)}%`);
}

if (require.main === module) {
  main().catch(console.error);
} 
