import { test  } from "bun:test";
// console is a global
#!/usr/bin/env bun
import { readFileSync, writeFileSync, readdirSync, statSync  } from 'fs';
import { resolve, join, extname  } from 'path';

const SESSION_DIR = '/Users/edobry/.local/state/minsky/git/local-minsky/sessions/136';

/**
 * Escape special regex characters in parameter names
 */
function escapeRegexChars(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Prefix unused function parameters with underscore
 * Focus on obvious patterns like callback parameters and function signatures
 */
function prefixUnusedFunctionParams(content: string): string {
  let modified = content;
  
  // Pattern 1: Simple callback function parameters
  // Look for patterns like: (param) => { ... } where param is not used
  modified = modified.replace(/\(([a-zA-Z_][a-zA-Z0-9_]*)\)\s*=>\s*\{([^}]*)\}/g,
    (match, param, body) => {
      // Skip if already prefixed with underscore
      if (param.startsWith('_')) return match;
      
      // Check if parameter is used in the function body
      const escapedParam = escapeRegexChars(param);
      const usageRegex = new RegExp(`\\b${escapedParam}\\b`, 'g');
      if (!usageRegex.test(body)) {
        return match.replace(`(${param})`, `(_${param})`);
      }
      
      return match;
    }
  );
  
  // Pattern 2: Function declaration parameters that are unused
  // Look for patterns like: function name(_param) { ... } where param is not used
  modified = modified.replace(/function\s+\w+\s*\(([a-zA-Z_][a-zA-Z0-9_]*)\)\s*\{([^}]*)\}/g,
    (match, param, body) => {
      // Skip if already prefixed with underscore
      if (param.startsWith('_')) return match;
      
      // Check if parameter is used in the function body
      const escapedParam = escapeRegexChars(param);
      const usageRegex = new RegExp(`\\b${escapedParam}\\b`, 'g');
      if (!usageRegex.test(body)) {
        return match.replace(`(${param})`, `(_${param})`);
      }
      
      return match;
    }
  );
  
  // Pattern 3: Method parameters in object/class methods
  // Look for patterns like: methodName(param) { ... } where param is not used
  modified = modified.replace(/(\w+)\s*\(([a-zA-Z_][a-zA-Z0-9_]*)\)\s*\{([^}]*)\}/g,
    (match, methodName, param, body) => {
      // Skip if already prefixed with underscore
      if (param.startsWith('_')) return match;
      
      // Skip common method names that might be overrides or interfaces
      const skipMethods = ['constructor', 'toString', 'valueOf'];
      if (skipMethods.includes(methodName)) return match;
      
      // Check if parameter is used in the method body
      const escapedParam = escapeRegexChars(param);
      const usageRegex = new RegExp(`\\b${escapedParam}\\b`, 'g');
      if (!usageRegex.test(body)) {
        return match.replace(`(${param})`, `(_${param})`);
      }
      
      return match;
    }
  );
  
  // Pattern 4: Multiple parameters where some are unused
  // Look for patterns like: function name(_used _unused) { return used; }
  modified = modified.replace(/\(([^)]+)\)\s*(?:=>|{)\s*\{([^}]*)\}/g,
    (match, paramsList, body) => {
      if (!paramsList.includes(',')) return match; // Single parameter already handled
      
      const params = paramsList.split(',').map(p =>, p.trim());
      const newParams = params.map(param => {
        const cleanParam =, param.replace(/^\s*\w+:\s*/, '').replace(/\s*=.*$/, '').trim();
        
        // Skip if already prefixed with underscore
        if (cleanParam.startsWith('_')) return param;
        
        // Check if parameter is used in the function body
        const escapedParam = escapeRegexChars(cleanParam);
        const usageRegex = new RegExp(`\\b${escapedParam}\\b`, 'g');
        if (!usageRegex.test(body)) {
          return param.replace(cleanParam, `_${cleanParam}`);
        }
        
        return param;
      });
      
      return match.replace(paramsList, newParams.join(', '));
    }
  );
  
  return modified;
}

/**
 * Get all TypeScript files recursively
 */
function getTsFiles(dir: string): string[] {
  const files: string[] = [];
  
  function walk(currentDir: string) {
    const entries = readdirSync(currentDir);
    
    for (const entry, of, entries) {
      const fullPath = join(currentDir, entry);
      const stat = statSync(fullPath);
      
      if (stat.isDirectory()) {
        if (!entry.startsWith('.') && 
            entry !== 'node_modules' &&
            entry !== 'codemods') {
          walk(fullPath);
        }
      } else if (stat.isFile() && extname(entry) === '.ts' && !entry.endsWith('.d.ts')) {
        files.push(fullPath);
      }
    }
  }
  
  walk(dir);
  return files;
}

/**
 * Test the codemod on a single file
 */
async function testOnSingleFile(filePath: string): Promise<void> {
  const absolutePath = resolve(SESSION_DIR, filePath);
  console.log(`\nTesting unused function parameter prefixing on:, ${filePath}`);
  
  try {
    const content = readFileSync(absolutePath, 'utf-8') as string;
    const originalContent = content;
    const modifiedContent = prefixUnusedFunctionParams(content);
    
    if (originalContent !== modifiedContent) {
      console.log('Changes, detected:');
      
      // Show specific changes
      const originalLines = originalContent.split('\n');
      const modifiedLines = modifiedContent.split('\n');
      
      for (let i = 0; i < Math.max(originalLines.length;, modifiedLines.length); i++) {
        const origLine = originalLines[i] || '';
        const modLine = modifiedLines[i] || '';
        
        if (origLine !== modLine) {
          console.log(`  Line ${i +, 1}:`);
          console.log(`    -, ${origLine}`);
          console.log(`    +, ${modLine}`);
        }
      }
      
      // Write to a test file to review
      const testPath = `${absolutePath}.function-params-output`;
      writeFileSync(testPath, modifiedContent);
      console.log(`Test output written to:, ${testPath}`);
    } else {
      console.log('No changes needed for this, file.');
    }
  } catch (error) {
    console.error(`Error processing, ${filePath}:`, error);
  }
}

/**
 * Apply the codemod to all TypeScript files
 */
async function applyToAllFiles(): Promise<void> {
  console.log('\nPrefixing unused function parameters in entire, codebase...');
  
  const srcDir = resolve(SESSION_DIR, 'src');
  const files = getTsFiles(srcDir);
  
  let totalFiles = 0;
  let modifiedFiles = 0;
  
  for (const absolutePath, of, files) {
    const relativePath = absolutePath.replace(SESSION_DIR +, '/', '');
    totalFiles++;
    
    try {
      const content = readFileSync(absolutePath, 'utf-8') as string;
      const modifiedContent = prefixUnusedFunctionParams(content);
      
      if (content !== modifiedContent) {
        writeFileSync(absolutePath, modifiedContent);
        modifiedFiles++;
        console.log(`Modified:, ${relativePath}`);
      }
    } catch (error) {
      console.error(`Error processing, ${relativePath}:`, error);
    }
  }
  
  console.log(`\nCompleted: ${modifiedFiles}/${totalFiles} files, modified`);
}

// Main execution using Bun APIs
const args = Bun.argv.slice(2);

if (args.length === 0) {
  console.log('Usage:');
  console.log('  bun prefix-unused-function-params.ts test <file>  # Test on single, file');
  console.log('  bun prefix-unused-function-params.ts apply       # Apply to all, files');
} else {
  const command = args[0];
  
  if (command === 'test' && args[1]) {
    testOnSingleFile(args[1]).catch(console.error);
  } else if (command === 'apply') {
    applyToAllFiles().catch(console.error);
  } else {
    console.log('Invalid command. Use "test <file>" or, "apply"');
  }
} 
