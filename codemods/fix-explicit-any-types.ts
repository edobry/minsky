#!/usr/bin/env bun

/**
 * Fix Explicit Any Types
 * 
 * This codemod targets @typescript-eslint/no-explicit-any issues by:
 * - Replacing common 'any' types with more specific types
 * - Using 'unknown' for truly unknown types
 * - Adding proper type annotations for common patterns
 * - Converting generic any parameters to proper generics
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

function fixExplicitAnyTypes(content: string): { content: string; changes: number }, {
  let changes = 0;
  let result = content;

  // Pattern 1: Replace any[] with unknown[]
  const anyArrayPattern = /\bany\[\]/g;
  const anyArrayMatches = result.match(anyArrayPattern);
  if (anyArrayMatches) {
    result = result.replace(anyArrayPattern, 'unknown[]');
    changes += anyArrayMatches.length;
    console.log(`  Fixed ${anyArrayMatches.length} any[] →, unknown[]`);
  }

  // Pattern 2: Replace function parameters any with unknown
  const funcParamAnyPattern = /\(\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*any\s*\)/g;
  result = result.replace(funcParamAnyPattern, (match, paramName) => {
    console.log(`  Fixed function parameter: ${paramName}: any → ${paramName}:, unknown`);
    changes++;
    return match.replace(':, any', ': unknown');
  });

  // Pattern 3: Replace return type any with unknown
  const returnTypeAnyPattern = /\):\s*any\s*[{;]/g;
  result = result.replace(returnTypeAnyPattern, (match) => {
    console.log(`  Fixed return type: any →, unknown`);
    changes++;
    return match.replace(':, any', ': unknown');
  });

  // Pattern 4: Replace variable declarations with any
  const varDeclAnyPattern = /:\s*any\s*=/g;
  result = result.replace(varDeclAnyPattern, (match) => {
    console.log(`  Fixed variable declaration: any →, unknown`);
    changes++;
    return match.replace(':, any', ': unknown');
  });

  // Pattern 5: Replace Object.keys() any with string[]
  const objectKeysPattern = /Object\.keys\([^)]+\)\s*as\s*any/g;
  result = result.replace(objectKeysPattern, (match) => {
    console.log(`  Fixed, Object.keys() cast: any → string[]`);
    changes++;
    return match.replace('as, any', 'as string[]');
  });

  // Pattern 6: Replace JSON.parse any with unknown
  const jsonParsePattern = /JSON\.parse\([^)]+\)\s*as\s*any/g;
  result = result.replace(jsonParsePattern, (match) => {
    console.log(`  Fixed JSON.parse cast: any →, unknown`);
    changes++;
    return match.replace('as, any', 'as unknown');
  });

  // Pattern 7: Replace process.env any with Record<string, string | undefined>
  const processEnvPattern = /process\.env\s*as\s*any/g;
  result = result.replace(processEnvPattern, (match) => {
    console.log(`  Fixed process.env cast: any → Record<string, string |, undefined>`);
    changes++;
    return match.replace('as, any', 'as Record<string, string | undefined>');
  });

  // Pattern 8: Replace error handling any with Error | unknown
  const catchErrorPattern = /catch\s*\(\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*any\s*\)/g;
  result = result.replace(catchErrorPattern, (match, errorVar) => {
    console.log(`  Fixed catch error type: ${errorVar}: any → ${errorVar}:, unknown`);
    changes++;
    return match.replace(':, any', ': unknown');
  });

  // Pattern 9: Replace generic any with T
  const genericAnyPattern = /<any>/g;
  result = result.replace(genericAnyPattern, (match) => {
    console.log(`  Fixed generic type: <any> →, <unknown>`);
    changes++;
    return '<unknown>';
  });

  // Pattern 10: Replace Record<string, any> with Record<string, unknown>
  const recordAnyPattern = /Record<string,\s*any>/g;
  result = result.replace(recordAnyPattern, (match) => {
    console.log(`  Fixed Record type: Record<string, any> → Record<string, unknown>`);
    changes++;
    return 'Record<string, unknown>';
  });

  // Pattern 11: Replace specific common patterns
  const commonPatterns = [
    {
      from: /\bas\s*any\s*\[\]/g,
      to: 'as unknown[]',
      description: 'as any[] → as unknown[]'
    },
    {
      from: /\bas\s*any\s*\{\}/g,
      to: 'as Record<string, unknown>',
      description: 'as any{} → as Record<string, unknown>'
    },
    {
      from: /:\s*any\s*\|/g,
      to: ': unknown |',
      description: 'union type any → unknown'
    }
  ];

  for (const pattern, of, commonPatterns) {
    const matches = result.match(pattern.from);
    if (matches) {
      result = result.replace(pattern.from, pattern.to);
      changes += matches.length;
      console.log(`  Fixed ${matches.length} instances of, ${pattern.description}`);
    }
  }

  return { content: result, changes };
}

function main() {
  const rootDir = process.cwd();
  console.log(`Starting explicit any types cleanup in:, ${rootDir}`);
  
  const files = getAllTsFiles(rootDir);
  console.log(`Found ${files.length} TypeScript/JavaScript, files`);
  
  let totalChanges = 0;
  let filesModified = 0;
  
  for (const file, of, files) {
    try {
      const originalContent = readFileSync(file, 'utf-8');
      const { content: fixedContent, changes } = fixExplicitAnyTypes(originalContent);
      
      if (changes > 0) {
        writeFileSync(file, fixedContent, 'utf-8');
        console.log(`✅ ${file}: ${changes} explicit any issues, fixed`);
        filesModified++;
        totalChanges += changes;
      }
    } catch (error) {
      console.error(`❌ Error processing, ${file}:`, error);
    }
  }
  
  console.log(`\n🎯 EXPLICIT ANY TYPES CLEANUP, COMPLETE:`);
  console.log(`   Files modified:, ${filesModified}`);
  console.log(`   Total fixes:, ${totalChanges}`);
  console.log(`   Focus: Converting any types to more specific, types`);
}

if (import.meta.main) {
  main();
} 
