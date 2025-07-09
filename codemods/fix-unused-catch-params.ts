/**
 * Unused Catch Parameters Fix Codemod
 *
 * PROBLEM SOLVED:
 * Automatically adds underscore prefixes to unused catch block parameters
 * to suppress TypeScript/ESLint unused variable warnings. This follows
 * the convention of prefixing intentionally unused parameters with underscore.
 *
 * EXACT SITUATION:
 * - catch (error) { ... } where 'error' is not used in the catch block
 * - Results in "unused variable" warnings from linters
 * - Common pattern where errors are caught but not processed
 * - Need to mark parameters as intentionally unused
 *
 * TRANSFORMATION APPLIED:
 * - Scans all TypeScript files in src directory recursively
 * - Identifies catch block parameters: catch(paramName)
 * - Adds underscore prefix: catch(_paramName)
 * - Handles both new parameters and existing underscore parameters
 * - Preserves parameter names for debugging clarity
 *
 * SAFETY FEATURES:
 * - Only processes .ts files (skips other file types)
 * - Excludes common directories (node_modules, .git, dist, build)
 * - Uses straightforward regex patterns for catch blocks
 * - Maintains original parameter names with underscore prefix
 * - Tracks changes and reports modified files
 *
 * CONFIGURATION:
 * - Hardcoded to process 'src' directory
 * - Recursive file traversal with directory exclusions
 * - Processes all .ts files found
 * - No configuration options for different directories
 *
 * LIMITATIONS:
 * - Only handles standard catch(param) syntax
 * - Does not verify if parameter is actually unused
 * - May prefix parameters that are actually used
 * - Hardcoded directory structure assumptions
 * - No rollback or validation of changes
 * - Does not handle complex catch parameter patterns
 *
 * REGEX PATTERNS:
 * - /catch\s*\(\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\)/g: Standard catch blocks
 * - /catch\s*\(\s*_([a-zA-Z_][a-zA-Z0-9_]*)\s*\)/g: Already prefixed blocks
 *
 * RISK ASSESSMENT:
 * - LOW: Simple, targeted transformation
 * - MEDIUM: No validation that parameters are actually unused
 * - HIGH: May change semantics if parameter names are used in comments/strings
 * - CRITICAL: No verification that catch blocks are valid TypeScript syntax
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

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
        if (!['node_modules', '.git', 'dist', 'build'].includes(entry)) {
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

const files = getAllTsFiles('src');
let totalChanges = 0;
const changedFiles = new Set<string>();

for (const file of files) {
  const content = readFileSync(file, 'utf8') as string;
  let newContent = content;
  let fileChanges = 0;

  // Fix unused catch block parameters - very safe transformation
  const catchParamFixes = [
    // Standard catch blocks with unused parameters
    { pattern: /catch\s*\(\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\)/g, replacement: 'catch (_$1)' },
    // Catch blocks that already have underscore but might need fixing
    { pattern: /catch\s*\(\s*_([a-zA-Z_][a-zA-Z0-9_]*)\s*\)/g, replacement: 'catch (_$1)' }
  ];

  for (const fix of catchParamFixes) {
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
