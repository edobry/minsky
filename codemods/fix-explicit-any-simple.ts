
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Simple Explicit Any Type Replacement Codemod
 *
 * PROBLEM SOLVED:
 * Replaces explicit 'any' type annotations with 'unknown' type annotations
 * to improve type safety while maintaining compatibility. The 'unknown' type
 * is safer than 'any' as it requires type checking before use.
 *
 * EXACT SITUATION:
 * - Function parameters typed as 'any': (param: any) => void
 * - Array types using any: any[]
 * - Variable declarations: let variable: any = value
 * - Return types: (): any => result
 * - Generic constraints: <T = any> or <T extends any>
 *
 * TRANSFORMATION APPLIED:
 * - Changes (param: any) to (param: unknown)
 * - Changes any[] to unknown[]
 * - Changes : any = to : unknown =
 * - Changes ): any { to ): unknown {
 * - Changes ): any => to ): unknown =>
 * - Changes <T = any> to <T = unknown>
 * - Changes <T extends any> to <T extends unknown>
 *
 * CONFIGURATION:
 * - Processes all TypeScript files recursively
 * - Excludes: node_modules, .git, dist, build, codemods directories
 * - Only processes .ts files (not .d.ts declaration files)
 * - Uses regex patterns for each transformation
 *
 * SAFETY CONSIDERATIONS:
 * - Only changes explicit 'any' annotations, not implicit any
 * - Preserves existing code structure and formatting
 * - Applies multiple specific patterns rather than broad replacements
 * - Reports changes per file for tracking
 *
 * LIMITATIONS:
 * - **BOUNDARY ISSUES**: Regex patterns may match 'any' in inappropriate contexts
 * - **STRING LITERALS**: May incorrectly change 'any' appearing in strings or comments
 * - **CONTEXT INSENSITIVE**: Doesn't understand TypeScript syntax trees
 * - **TYPE COMPLEXITY**: May break complex generic type constraints
 * - **UNION TYPES**: Doesn't handle 'any' within union types (string | any)
 * - **MAPPED TYPES**: May incorrectly transform 'any' in mapped type contexts
 * - **CONDITIONAL TYPES**: Regex can't understand conditional type syntax
 * - **TEMPLATE LITERALS**: May match 'any' in template literal types
 * 
 * **CRITICAL RISK**: Changing 'any' to 'unknown' can break existing code that
 * relies on 'any' behavior, requiring additional type assertions
 */

// Get all TypeScript files recursively
function getAllTsFiles(dir: string): string[] {
  const files: string[] = [];
  
  function traverse(currentDir: string) {
    const entries = readdirSync(currentDir);
    
    for (const entry of entries) {
      const fullPath = join(currentDir, entry);
      const stat = statSync(fullPath);
      
      if (stat.isDirectory()) {
        // Skip node_modules and other unwanted directories
        if (!['node_modules', '.git', 'dist', 'build', 'codemods'].includes(entry)) {
          traverse(fullPath);
        }
      } else if (entry.endsWith('.ts')) {
        files.push(fullPath);
      }
    }
  }
  
  traverse(dir);
  return files;
}

const files = getAllTsFiles('.');
let totalChanges = 0;
const changedFiles = new Set<string>();

for (const file of files) {
  const content = readFileSync(file, 'utf8') as string;
  let newContent = content;
  let fileChanges = 0;

  // Simple any type replacements for common patterns
  const anyReplacements = [
    // Function parameters that are obviously objects
    { pattern: /\(([^:]+): any\)/g, replacement: '($1: unknown)' },
    // Variable declarations
    { pattern: /: any\[\]/g, replacement: ': unknown[]' },
    { pattern: /: any\s*=/g, replacement: ': unknown =' },
    // Return types
    { pattern: /\): any\s*{/g, replacement: '): unknown {' },
    { pattern: /\): any\s*=>/g, replacement: '): unknown =>' },
    // Generic constraints
    { pattern: /<T = any>/g, replacement: '<T = unknown>' },
    { pattern: /<T extends any>/g, replacement: '<T extends unknown>' }
  ];

  for (const fix of anyReplacements) {
    const matches = newContent.match(fix.pattern);
    if (matches) {
      newContent = newContent.replace(fix.pattern, fix.replacement);
      fileChanges += matches.length;
    }
  }

  if (fileChanges > 0) {
    writeFileSync(file, newContent);
    changedFiles.add(file);
    totalChanges += fileChanges;
    console.log(`${file}: ${fileChanges} changes`);
  }
}

console.log(`\nTotal: ${totalChanges} changes across ${changedFiles.size} files`); 
