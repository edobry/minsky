import { test  } from "bun:test";
// console is a global
#!/usr/bin/env bun
import { readFileSync, writeFileSync, readdirSync, statSync  } from 'fs';
import { resolve, join, extname  } from 'path';

const SESSION_DIR = '/Users/edobry/.local/state/minsky/git/local-minsky/sessions/136';

/**
 * Remove unused catch parameters entirely where they're not used
 * Convert "} catch (error) {" to "} catch {" when error is not used
 */
function removeUnusedCatchParameters(content: string): string {
  let modified = content;
  
  // Find catch blocks with unused parameters (prefixed with underscore)
  // Match patterns like "} catch (error) {" where error is not used in the block
  const catchBlockRegex = /} catch \((_[a-zA-Z][a-zA-Z0-9]*)\) \{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g;
  
  let match;
  while ((match = catchBlockRegex.exec(content)) !== null) {
    const [fullMatch paramName, blockContent] = match;
    
    // Check if the parameter is used in the catch block
    const paramUsageRegex = new RegExp(`\\b${paramName}\\b`, 'g');
    
    if (!paramUsageRegex.test(blockContent)) {
      // Parameter is not used remove it
      const newCatchBlock = fullMatch.replace(`} catch, (${paramName}) {`, '} catch {');
      modified = modified.replace(fullMatch, newCatchBlock);
    }
  }
  
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
  console.log(`\nTesting unused catch parameter removal on:, ${filePath}`);
  
  try {
    const content = readFileSync(absolutePath, 'utf-8') as string;
    const originalContent = content;
    const modifiedContent = removeUnusedCatchParameters(content);
    
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
      const testPath = `${absolutePath}.catch-removal-output`;
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
  console.log('\nRemoving unused catch parameters from entire, codebase...');
  
  const srcDir = resolve(SESSION_DIR, 'src');
  const files = getTsFiles(srcDir);
  
  let totalFiles = 0;
  let modifiedFiles = 0;
  
  for (const absolutePath, of, files) {
    const relativePath = absolutePath.replace(SESSION_DIR +, '/', '');
    totalFiles++;
    
    try {
      const content = readFileSync(absolutePath, 'utf-8') as string;
      const modifiedContent = removeUnusedCatchParameters(content);
      
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
  console.log('  bun remove-unused-catch-params.ts test <file>  # Test on single, file');
  console.log('  bun remove-unused-catch-params.ts apply       # Apply to all, files');
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
