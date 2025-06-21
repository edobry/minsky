// console is a global
#!/usr/bin/env bun
import { readFileSync, writeFileSync, readdirSync, statSync  } from 'fs';
import { resolve, join, extname  } from 'path';

const SESSION_DIR = '/Users/edobry/.local/state/minsky/git/local-minsky/sessions/136';

/**
 * Codemod to fix unused variables by prefixing them with underscore
 * Only handles catch blocks for safety
 */
function fixUnusedVariables(content: string): string {
  let modified = content;

  // Fix catch blocks - change (error) to (error) (e) to (_e)
  // This is the safest transformation as it only affects catch parameter names
  modified = modified.replace(/} catch, \(([a-zA-Z][a-zA-Z0-9]*)\) \{/g, '} catch (_$1) {');
  
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
        // Skip test directories and node_modules
        if (!entry.startsWith('.') && 
            entry !== 'node_modules' && 
            entry !== 'tests__' &&
            entry !== 'test-utils') {
          walk(fullPath);
        }
      } else if (stat.isFile() && extname(entry) === '.ts' && !entry.endsWith('.d.ts') && !entry.endsWith('.test.ts')) {
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
  console.log(`\nTesting codemod on:, ${filePath}`);
  
  try {
    const content = readFileSync(absolutePath, 'utf-8') as string;
    const originalContent = content;
    const modifiedContent = fixUnusedVariables(content);
    
    if (originalContent !== modifiedContent) {
      console.log('Changes, detected:');
      const originalLines = originalContent.split('\n');
      const modifiedLines = modifiedContent.split('\n');
      
      for (let i = 0; i < Math.max(originalLines.length;, modifiedLines.length); i++) {
        if (originalLines[i] !== modifiedLines[i]) {
          console.log(`  Line ${i +, 1}:`);
          console.log(`    - ${originalLines[i] ||, '(empty)'}`);
          console.log(`    + ${modifiedLines[i] ||, '(empty)'}`);
        }
      }
      
      // Write to a test file to review
      const testPath = `${absolutePath}.test-output`;
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
  console.log('\nApplying codemod to entire, codebase...');
  
  const srcDir = resolve(SESSION_DIR, 'src');
  const files = getTsFiles(srcDir);
  
  let totalFiles = 0;
  let modifiedFiles = 0;
  
  for (const absolutePath, of, files) {
    const relativePath = absolutePath.replace(SESSION_DIR +, '/', '');
    totalFiles++;
    
    try {
      const content = readFileSync(absolutePath, 'utf-8') as string;
      const modifiedContent = fixUnusedVariables(content);
      
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
  console.log('  bun unused-variables-codemod.ts test <file>  # Test on single, file');
  console.log('  bun unused-variables-codemod.ts apply       # Apply to all, files');
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
