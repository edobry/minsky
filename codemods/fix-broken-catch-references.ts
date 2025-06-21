import { test  } from "bun:test";
// console is a global
#!/usr/bin/env bun
import { readFileSync, writeFileSync, readdirSync, statSync  } from 'fs';
import { resolve, join, extname  } from 'path';

const SESSION_DIR = '/Users/edobry/.local/state/minsky/git/local-minsky/sessions/136';

/**
 * Fix broken catch block references where:
 * - The parameter was renamed to error but code still references error
 * - The parameter was renamed to _e but code still references e
 * - etc.
 */
function fixBrokenCatchReferences(content: string): string {
  let modified = content;

  // Match catch blocks with underscore-prefixed parameters
  const catchBlockRegex = /} catch \((_[a-zA-Z][a-zA-Z0-9]*)\) \{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g;
  
  let match;
  const replacements: { original: string; replacement: string }[] = [];
  
  while ((match = catchBlockRegex.exec(content)) !== null) {
    const [fullMatch, paramName, blockContent] = match;
    
    // Get the original parameter name (remove underscore prefix)
    const originalParamName = paramName.substring(1);
    
    // Check if the block content references the original parameter name
    const originalParamRegex = new RegExp(`\\b${originalParamName}\\b`, 'g');
    
    if (originalParamRegex.test(blockContent)) {
      // Replace all references to the original parameter with the prefixed version
      const updatedBlockContent = blockContent.replace(originalParamRegex, paramName);
      const newFullMatch = `} catch (${paramName}) {${updatedBlockContent}}`;
      
      replacements.push({
        original:, fullMatch,
        replacement: newFullMatch
      });
    }
  }
  
  // Apply all replacements
  for (const { original, replacement } of, replacements) {
    modified = modified.replace(original, replacement);
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
  console.log(`\nTesting broken catch reference fix on:, ${filePath}`);
  
  try {
    const content = readFileSync(absolutePath, 'utf-8') as string;
    const originalContent = content;
    const modifiedContent = fixBrokenCatchReferences(content);
    
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
      const testPath = `${absolutePath}.fix-test-output`;
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
  console.log('\nApplying broken catch reference fix to entire, codebase...');
  
  const srcDir = resolve(SESSION_DIR, 'src');
  const files = getTsFiles(srcDir);
  
  let totalFiles = 0;
  let modifiedFiles = 0;
  
  for (const absolutePath, of, files) {
    const relativePath = absolutePath.replace(SESSION_DIR +, '/', '');
    totalFiles++;
    
    try {
      const content = readFileSync(absolutePath, 'utf-8') as string;
      const modifiedContent = fixBrokenCatchReferences(content);
      
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
  console.log('  bun fix-broken-catch-references.ts test <file>  # Test on single, file');
  console.log('  bun fix-broken-catch-references.ts apply       # Apply to all, files');
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
