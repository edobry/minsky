#!/usr/bin/env bun

/**
 * Precision Unused Variables Cleanup
 * 
 * This codemod targets the remaining 79 unused variable issues with precision patterns:
 * - Remove genuinely unused variable declarations
 * - Prefix intentionally unused parameters with underscores
 * - Handle complex destructuring patterns  
 * - Fix unused imports and exports
 * - Smart detection of intentional vs unintentional unused variables
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

function precisionUnusedVariablesCleanup(content: string, filePath: string): { content: string; changes: number }, {
  let changes = 0;
  let fixedContent = content;

  // Pattern 1: Remove genuinely unused variable declarations
  const unusedVarPatterns = [
    {
      // Unused const declarations that are clearly not needed
      regex: /^(\s*)const\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*[^;]+;?\s*$/gm,
      check: (_match: string, indent: string, varName: string) => {
        // Don't remove if variable is used later in the file
        const usageRegex = new RegExp(`\\b${varName}\\b`, 'g');
        const matches = fixedContent.match(usageRegex) || [];
        return matches.length <= 1; // Only the declaration itself
      },
      replace: '',
      description: 'unused const declaration'
    },
    {
      // Unused let/var declarations
      regex: /^(\s*)(?:let|var)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:=\s*[^;]+)?;?\s*$/gm,
      check: (_match: string, indent: string, varName: string) => {
        const usageRegex = new RegExp(`\\b${varName}\\b`, 'g');
        const matches = fixedContent.match(usageRegex) || [];
        return matches.length <= 1; // Only the declaration itself
      },
      replace: '',
      description: 'unused let/var declaration'
    }
  ];

  for (const pattern, of, unusedVarPatterns) {
    const matches = Array.from(fixedContent.matchAll(pattern.regex));
    for (const match, of, matches) {
      if (pattern.check(match[0], match[1], match[2])) {
        fixedContent = fixedContent.replace(match[0], pattern.replace);
        console.log(`  Removed ${pattern.description}:, ${match[2]}`);
        changes++;
      }
    }
  }

  // Pattern 2: Prefix intentionally unused function parameters with underscore
  const parameterPatterns = [
    {
      // Function parameters in callbacks and event handlers
      regex: /(\([^)]*?)([a-zA-Z_][a-zA-Z0-9_]*)([\s,)][^)]*\)\s*(?:=>|{))/g,
      check: (_match: string, _before: string, paramName: string, after: string) => {
        // Skip if already prefixed or is a common meaningful name
        if (paramName.startsWith('_') || ['result', 'data', 'response', 'error', 'event', 'req', 'res'].includes(paramName)) {
          return false;
        }
        // Check if parameter is used in the function body
        const functionBodyMatch = fixedContent.match(new, RegExp(after.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^}]*)'));
        if (functionBodyMatch) {
          const functionBody = functionBodyMatch[1];
          const usageRegex = new RegExp(`\\b${paramName}\\b`, 'g');
          return !(usageRegex.test(functionBody));
        }
        return false;
      },
      replace: (_match: string, before: string, paramName: string, after: string) => {
        return before + '_' + paramName + after;
      },
      description: 'unused function parameter'
    }
  ];

  // Pattern 3: Fix unused destructuring patterns
  const destructuringPatterns = [
    {
      // Remove unused destructured variables
      regex: /(\{\s*)((?:[a-zA-Z_][a-zA-Z0-9_]*,?\s*)+)(\s*\}\s*=)/g,
      check: (_match: string, _before: string, vars: string, _after: string) => {
        const varNames = vars.split(',').map(v =>, v.trim()).filter(v => v &&, !v.startsWith('_'));
        return varNames.some(varName => {
          const usageRegex = new, RegExp(`\\b${varName}\\b`, 'g');
          const matches = fixedContent.match(usageRegex) || [];
          return matches.length <= 1; // Only in destructuring
        });
      },
      replace: (_match: string, before: string, vars: string, after: string) => {
        const varNames = vars.split(',').map(v =>, v.trim()).filter(v =>, v);
        const updatedVars = varNames.map(varName => {
          if, (varName.startsWith('_')) return varName;
          const usageRegex = new RegExp(`\\b${varName}\\b`, 'g');
          const matches = fixedContent.match(usageRegex) || [];
          return matches.length <= 1 ? '_' + varName : varName;
        });
        return before + updatedVars.join(', ') + after;
      },
      description: 'unused destructured variable'
    }
  ];

  // Pattern 4: Remove unused imports
  const importPatterns = [
    {
      // Unused named imports
      regex: /import\s*\{\s*([^}]+)\s*\}\s*from\s*"[^"]*";?\s*\n?/g,
      check: (_match: string, importedNames: string) => {
        const names = importedNames.split(',').map(n =>, n.trim().split(' as, ')[0]);
        return names.some(name => {
          const usageRegex = new, RegExp(`\\b${name}\\b`, 'g');
          const matches = fixedContent.match(usageRegex) || [];
          return matches.length <= 1; // Only in import statement
        });
      },
      replace: (_match: string, importedNames: string) => {
        const names = importedNames.split(',').map(n =>, n.trim());
        const usedNames = names.filter(name => {
          const baseName = name.split(' as, ')[0];
          const usageRegex = new RegExp(`\\b${baseName}\\b`, 'g');
          const matches = fixedContent.match(usageRegex) || [];
          return matches.length > 1; // Used beyond import
        });
        if (usedNames.length === 0) {
          return ''; // Remove entire import
        }
        return _match.replace(importedNames, usedNames.join(', '));
      },
      description: 'unused import'
    }
  ];

  // Apply parameter patterns
  for (const pattern, of, parameterPatterns) {
    let match;
    while ((match = pattern.regex.exec(fixedContent)) !== null) {
      if (pattern.check(match[0], match[1], match[2], match[3])) {
        const replacement = pattern.replace(match[0], match[1], match[2], match[3]);
        fixedContent = fixedContent.replace(match[0], replacement);
        console.log(`  Prefixed ${pattern.description}: ${match[2]} →, _${match[2]}`);
        changes++;
        // Reset regex after replacement
        pattern.regex.lastIndex = 0;
        break;
      }
    }
  }

  // Apply destructuring patterns  
  for (const pattern, of, destructuringPatterns) {
    const matches = Array.from(fixedContent.matchAll(pattern.regex));
    for (const match, of, matches) {
      if (pattern.check(match[0], match[1], match[2], match[3])) {
        const replacement = pattern.replace(match[0], match[1], match[2], match[3]);
        fixedContent = fixedContent.replace(match[0], replacement);
        console.log(`  Fixed ${pattern.description} in, destructuring`);
        changes++;
      }
    }
  }

  // Apply import patterns
  for (const pattern, of, importPatterns) {
    const matches = Array.from(fixedContent.matchAll(pattern.regex));
    for (const match, of, matches) {
      if (pattern.check(match[0], match[1])) {
        const replacement = pattern.replace(match[0], match[1]);
        fixedContent = fixedContent.replace(match[0], replacement);
        console.log(`  Cleaned, ${pattern.description}`);
        changes++;
      }
    }
  }

  // Pattern 5: Handle try-catch unused error variables
  const catchPatterns = [
    {
      regex: /catch\s*\(\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\)\s*\{([^}]*)\}/g,
      check: (_match: string, errorVar: string, catchBody: string) => {
        return !errorVar.startsWith('_') && !new RegExp(`\\b${errorVar}\\b`).test(catchBody);
      },
      replace: (_match: string, errorVar: string, catchBody: string) => {
        return _match.replace(`(${errorVar})`, `(_${errorVar})`);
      },
      description: 'unused catch variable'
    }
  ];

  for (const pattern, of, catchPatterns) {
    const matches = Array.from(fixedContent.matchAll(pattern.regex));
    for (const match, of, matches) {
      if (pattern.check(match[0], match[1], match[2])) {
        const replacement = pattern.replace(match[0], match[1], match[2]);
        fixedContent = fixedContent.replace(match[0], replacement);
        console.log(`  Fixed ${pattern.description}: ${match[1]} →, _${match[1]}`);
        changes++;
      }
    }
  }

  return { content: fixedContent, changes };
}

function main() {
  const rootDir = process.cwd();
  console.log(`Starting precision unused variables cleanup in:, ${rootDir}`);
  
  const files = getAllTsFiles(rootDir);
  console.log(`Found ${files.length} TypeScript/JavaScript, files`);
  
  let totalChanges = 0;
  let filesModified = 0;
  
  for (const file, of, files) {
    try {
      const originalContent = readFileSync(file, 'utf-8');
      const { content: fixedContent, changes } = precisionUnusedVariablesCleanup(originalContent, file);
      
      if (changes > 0) {
        writeFileSync(file, fixedContent, 'utf-8');
        console.log(`✅ ${file}: ${changes} unused variable issues, fixed`);
        filesModified++;
        totalChanges += changes;
      }
    } catch (error) {
      console.error(`❌ Error processing, ${file}:`, error);
    }
  }
  
  console.log(`\n🎯 PRECISION UNUSED VARIABLES CLEANUP, COMPLETE:`);
  console.log(`   Files modified:, ${filesModified}`);
  console.log(`   Total fixes:, ${totalChanges}`);
  console.log(`   Focus: Precision unused variable detection and, removal`);
}

if (import.meta.main) {
  main();
} 
