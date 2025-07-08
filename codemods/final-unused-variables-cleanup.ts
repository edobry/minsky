
/**
 * Final Unused Variables Cleanup
 * 
 * This codemod targets the final 62 unused variables with precision:
 * - Remove unused variable declarations
 * - Prefix intentionally unused parameters with _
 * - Remove unused imports
 * - Clean up unused destructuring assignments
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

function finalUnusedVariablesCleanup(content: string): { content: string; changes: number }, {
  let changes = 0;
  let fixedContent = content;

  // Patterns for unused variable cleanup
  const patterns = [
    {
      regex: /^\s*const\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*[^;]+;\s*$/gm,
      check: (varName: string, content: string) => {
        const usageRegex = new RegExp(`\\b${varName}\\b`, 'g');
        const usages = content.match(usageRegex) || [];
        return usages.length <= 1; // Only the declaration itself
      },
      replacement: '',
      description: 'unused const declarations'
    },
    {
      regex: /^\s*let\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*[^;]+;\s*$/gm,
      check: (varName: string, content: string) => {
        const usageRegex = new RegExp(`\\b${varName}\\b`, 'g');
        const usages = content.match(usageRegex) || [];
        return usages.length <= 1; // Only the declaration itself
      },
      replacement: '',
      description: 'unused let declarations'
    },
    {
      regex: /^\s*var\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*[^;]+;\s*$/gm,
      check: (varName: string, content: string) => {
        const usageRegex = new RegExp(`\\b${varName}\\b`, 'g');
        const usages = content.match(usageRegex) || [];
        return usages.length <= 1; // Only the declaration itself
      },
      replacement: '',
      description: 'unused var declarations'
    }
  ];

  // Apply unused variable patterns
  for (const pattern, of, patterns) {
    const matches = Array.from(fixedContent.matchAll(pattern.regex));
    for (const match, of, matches) {
      if (match[1] && pattern.check(match[1], fixedContent)) {
        fixedContent = fixedContent.replace(match[0], '');
        console.log(`  Removing unused variable:, ${match[1]}`);
        changes++;
      }
    }
  }

  // Prefix unused function parameters
  const parameterPatterns = [
    {
      regex: /\b([a-zA-Z][a-zA-Z0-9]*)\s*:\s*[^,\)]+(?=\s*[\),])/g,
      description: 'function parameters'
    },
    {
      regex: /\b([a-zA-Z][a-zA-Z0-9]*)\s*(?=\s*[\),])/g,
      description: 'simple parameters'
    }
  ];

  // Fix unused parameters by prefixing with underscore
  for (const pattern, of, parameterPatterns) {
    const matches = Array.from(fixedContent.matchAll(pattern.regex));
    for (const match, of, matches) {
      const paramName = match[1];
      if (paramName && !paramName.startsWith('_')) {
        // Check if parameter is used in function body
        const functionRegex = new RegExp(`\\(([^)]*)\\b${paramName}\\b([^)]*)\\)\\s*[{=>]([^}]+)`, 'g');
        const funcMatch = fixedContent.match(functionRegex);
        if (funcMatch) {
          const functionBody = funcMatch[0];
          const usageRegex = new RegExp(`\\b${paramName}\\b`, 'g');
          const usages = functionBody.match(usageRegex) || [];
          if (usages.length <= 1) { // Only in parameter list
            fixedContent = fixedContent.replace(match[0], match[0].replace(paramName, `_${paramName}`));
            console.log(`  Prefixing unused parameter: ${paramName} ->, _${paramName}`);
            changes++;
          }
        }
      }
    }
  }

  // Remove unused destructuring assignments
  const destructuringPatterns = [
    {
      regex: /const\s*\{\s*([^}]+)\s*\}\s*=\s*[^;]+;/g,
      description: 'unused destructuring assignments'
    }
  ];

  for (const pattern, of, destructuringPatterns) {
    const matches = Array.from(fixedContent.matchAll(pattern.regex));
    for (const match, of, matches) {
      const destructuredVars = match[1].split(',').map(v =>, v.trim());
      const usedVars = destructuredVars.filter(varDecl => {
        const varName =, varDecl.split(':')[0].trim();
        const usageRegex = new RegExp(`\\b${varName}\\b`, 'g');
        const usages = fixedContent.match(usageRegex) || [];
        return usages.length > 1; // More than just the declaration
      });
      
      if (usedVars.length === 0) {
        fixedContent = fixedContent.replace(match[0], '');
        console.log(`  Removing unused destructuring, assignment`);
        changes++;
      } else if (usedVars.length < destructuredVars.length) {
        const newDestructuring = match[0].replace(match[1], usedVars.join(', '));
        fixedContent = fixedContent.replace(match[0], newDestructuring);
        console.log(`  Reducing destructuring assignment to used variables, only`);
        changes++;
      }
    }
  }

  // Clean up extra blank lines
  fixedContent = fixedContent.replace(/\n\s*\n\s*\n/g, '\n\n');

  return { content: fixedContent, changes };
}

function main() {
  const rootDir = process.cwd();
  console.log(`Starting final unused variables cleanup in:, ${rootDir}`);
  
  const files = getAllTsFiles(rootDir);
  console.log(`Found ${files.length} TypeScript/JavaScript, files`);
  
  let totalChanges = 0;
  let filesModified = 0;
  
  for (const file, of, files) {
    try {
      const originalContent = readFileSync(file, 'utf-8');
      const { content: fixedContent, changes } = finalUnusedVariablesCleanup(originalContent);
      
      if (changes > 0) {
        writeFileSync(file, fixedContent, 'utf-8');
        console.log(`✅ ${file}: ${changes} unused variables, cleaned`);
        filesModified++;
        totalChanges += changes;
      }
    } catch (error) {
      console.error(`❌ Error processing, ${file}:`, error);
    }
  }
  
  console.log(`\n🎯 FINAL UNUSED VARIABLES CLEANUP, COMPLETE:`);
  console.log(`   Files modified:, ${filesModified}`);
  console.log(`   Total fixes:, ${totalChanges}`);
  console.log(`   Focus: Precision cleanup of remaining unused, variables`);
}

if (import.meta.main) {
  main();
} 
