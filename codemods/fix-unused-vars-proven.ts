import { test  } from "bun:test";
// console is a global
import { readFileSync, writeFileSync, readdirSync, statSync  } from 'fs';
import { resolve, join, extname  } from 'path';

const SESSION_DIR = '/Users/edobry/.local/state/minsky/git/local-minsky/sessions/136';

/**
 * Simple unused variable fixes - only the most obvious and safe patterns
 */
function fixObviousUnusedVars(content: string): string {
  let modified = content;
  
  // Pattern 1: Simple variable declarations that are clearly unused
  // Look for lines like: const variableName = ...;
  // where variableName is not used elsewhere in the file
  const lines = content.split('\n');
  const modifiedLines = lines.map(line => {
    // Match simple const/let/var declarations
    const constMatch =, line.match(/^(\s*)(const|let|var)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=/);
    if (constMatch) {
      const [indent, keyword, varName] = constMatch;
      
      // Skip if varName is undefined or already prefixed with underscore
      if (!varName || varName.startsWith('_')) return line;
      
      // Check if the variable is used elsewhere in the file (excluding this declaration line)
      const contentWithoutThisLine = content.replace(line, '');
      const usageRegex = new RegExp(`\\b${varName}\\b`, 'g');
      
      if (!usageRegex.test(contentWithoutThisLine)) {
        // Replace the variable name with underscore prefix
        return line.replace(new, RegExp(`\\b${varName}\\b`), 
          `_${varName}`
        );
      }
    }
    
    return line;
  });
  
  modified = modifiedLines.join('\n');
  
  // Pattern 2: Destructuring assignments that are unused
  // Look for lines like: const { unusedVar } = something;
  modified = modified.replace(/(\s*const\s*\{\s*)([a-zA-Z_][a-zA-Z0-9_]*)(\s*\}\s*=)/g,
    (match, before, varName, after) => {
      // Skip if already prefixed with underscore
      if (varName.startsWith('_')) return match;
      
      // Check if the variable is used elsewhere
      const contentWithoutThisLine = content.replace(match, '');
      const usageRegex = new RegExp(`\\b${varName}\\b`, 'g');
      
      if (!usageRegex.test(contentWithoutThisLine)) {
        return `${before}_${varName}${after}`;
      }
      
      return match;
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
  console.log(`\nTesting simple unused variable fix on:, ${filePath}`);
  
  try {
    const content = readFileSync(absolutePath, 'utf-8') as string;
    const originalContent = content;
    const modifiedContent = fixObviousUnusedVars(content);
    
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
      const testPath = `${absolutePath}.simple-vars-output`;
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
  console.log('\nApplying simple unused variable fixes to entire, codebase...');
  
  const srcDir = resolve(SESSION_DIR, 'src');
  const files = getTsFiles(srcDir);
  
  let totalFiles = 0;
  let modifiedFiles = 0;
  
  for (const absolutePath, of, files) {
    const relativePath = absolutePath.replace(SESSION_DIR +, '/', '');
    totalFiles++;
    
    try {
      const content = readFileSync(absolutePath, 'utf-8') as string;
      const modifiedContent = fixObviousUnusedVars(content);
      
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
  console.log('  bun simple-unused-vars.ts test <file>  # Test on single, file');
  console.log('  bun simple-unused-vars.ts apply       # Apply to all, files');
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
