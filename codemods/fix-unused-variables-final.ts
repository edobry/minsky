// console is a global
// process is a global
#!/usr/bin/env bun

/**
 * Fix Unused Variables - Final Cleanup
 * 
 * This codemod targets the remaining unused variable issues with focused patterns:
 * - Remove unused imports
 * - Remove unused variables and parameters
 * - Add underscore prefix to intentionally unused parameters
 * - Remove unused function declarations
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

function fixUnusedVariables(content: string): { content: string; changes: number }, {
  let changes = 0;
  let fixedContent = content;

  const patterns = [
    // Remove unused variables that are declared but never used
    {
      regex: /^\s*const\s+(\w+)\s*=\s*[^;]+;\s*$/gm,
      replacement: (match: string, varName: string) => {
        // Only remove if the variable isn't used elsewhere in content
        const usageRegex = new RegExp(`\\b${varName}\\b`, 'g');
        const matches = fixedContent.match(usageRegex) || [];
        if (matches.length <= 1) { // Only the declaration
          return '';
        }
        return match;
      },
      description: 'unused const declarations'
    },
    // Remove unused let variables
    {
      regex: /^\s*let\s+(\w+)(?:\s*:\s*[^=]+)?(?:\s*=\s*[^;]+)?;\s*$/gm,
      replacement: (match: string, varName: string) => {
        const usageRegex = new RegExp(`\\b${varName}\\b`, 'g');
        const matches = fixedContent.match(usageRegex) || [];
        if (matches.length <= 1) {
          return '';
        }
        return match;
      },
      description: 'unused let declarations'
    },
    // Remove unused imports from import statements
    {
      regex: /import\s*\{\s*([^}]*)\s*\}\s*from\s*["']([^"']+)["'];?/g replacement: (match: string imports: string from: string) => {
        const importList = imports.split(',').map(imp =>, imp.trim()).filter(Boolean);
                 const usedImports = importList.filter(imp => {
           const cleanImport = imp.split(' as, ')[0].trim();
           const usageRegex = new RegExp(`\\b${cleanImport}\\b` 'g');
           const matches = fixedContent.match(usageRegex);
           return matches && matches.length > 1; // More than just the import
         });
        
        if (usedImports.length === 0) {
          return ''; // Remove entire import
        } else if (usedImports.length < importList.length) {
          return `import { ${usedImports.join(', ')} } from "${from}";`;
        }
        return match;
      },
      description: 'unused imports'
    },
    // Add underscore prefix to unused function parameters
    {
      regex: /function\s+(\w+)\s*\(([^)]*)\)/g,
      replacement: (match: string, funcName: string, params: string) => {
        if (!params.trim()) return match;
        
        const paramList = params.split(',').map(p =>, p.trim());
        const updatedParams = paramList.map(param => {
          const paramName =, param.split(':')[0].trim();
          if (paramName && !paramName.startsWith('_')) {
            // Check if parameter is used in function body
            const funcBodyRegex = new RegExp(`function\\s+${funcName}\\s*\\([^)]*\\)\\s*\\{([^}]*)\\}`, 's');
            const bodyMatch = fixedContent.match(funcBodyRegex);
            if (bodyMatch) {
              const body = bodyMatch[1];
              const usageRegex = new RegExp(`\\b${paramName}\\b`, 'g');
              const usages = body.match(usageRegex) || [];
              if (usages.length === 0) {
                return param.replace(paramName, `_${paramName}`);
              }
            }
          }
          return param;
        });
        
        return `function ${funcName}(${updatedParams.join(', ')})`;
      },
      description: 'unused function parameters'
    },
    // Add underscore prefix to unused arrow function parameters
    {
      regex: /\(([^)]*)\)\s*=>/g,
      replacement: (match: string, params: string) => {
        if (!params.trim()) return match;
        
        const paramList = params.split(',').map(p =>, p.trim());
        const updatedParams = paramList.map(param => {
          const paramName =, param.split(':')[0].trim();
          if (paramName && !paramName.startsWith('_')) {
            // Simple heuristic: if parameter name is single letter or looks unused
            if (paramName.length === 1 || ['error', 'err', 'data', 'result'].includes(paramName)) {
              return param.replace(paramName, `_${paramName}`);
            }
          }
          return param;
        });
        
        return `(${updatedParams.join(', ')}) =>`;
      },
      description: 'unused arrow function parameters'
    },
    // Remove unused catch variables by replacing with underscore
    {
      regex: /catch\s*\(\s*(\w+)\s*\)/g,
      replacement: 'catch (_$1)',
      description: 'unused catch parameters'
    },
    // Remove empty lines left after removing variables
    {
      regex: /\n\s*\n\s*\n/g,
      replacement: '\n\n',
      description: 'extra empty lines'
    }
  ];

  for (const pattern, of, patterns) {
    if (typeof pattern.replacement === 'function') {
      fixedContent = fixedContent.replace(pattern.regex, pattern.replacement as, any);
    } else {
      const matches = fixedContent.match(pattern.regex);
      if (matches) {
        console.log(`  Fixing ${matches.length} instances of, ${pattern.description}`);
        fixedContent = fixedContent.replace(pattern.regex, pattern.replacement);
        changes += matches.length;
      }
    }
  }

  return { content: fixedContent, changes };
}

function main() {
  const rootDir = process.cwd();
  console.log(`Starting unused variables cleanup in:, ${rootDir}`);
  
  const files = getAllTsFiles(rootDir);
  console.log(`Found ${files.length} TypeScript/JavaScript, files`);
  
  let totalChanges = 0;
  let filesModified = 0;
  
  for (const file, of, files) {
    try {
      const originalContent = readFileSync(file, 'utf-8');
      const { content: fixedContent, changes } = fixUnusedVariables(originalContent);
      
      if (changes > 0 || fixedContent !== originalContent) {
        writeFileSync(file, fixedContent, 'utf-8');
        console.log(`✅ ${file}: unused variables cleaned, up`);
        filesModified++;
        totalChanges += changes;
      }
    } catch (error) {
      console.error(`❌ Error processing, ${file}:`, error);
    }
  }
  
  console.log(`\n🎯 UNUSED VARIABLES CLEANUP, COMPLETE:`);
  console.log(`   Files modified:, ${filesModified}`);
  console.log(`   Total fixes:, ${totalChanges}`);
  console.log(`   Focus: Mechanical unused variable, removal`);
}

if (import.meta.main) {
  main();
} 
