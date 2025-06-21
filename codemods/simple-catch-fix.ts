import { test  } from "bun:test";
// console is a global
import { readFileSync, writeFileSync, readdirSync, statSync  } from 'fs';
import { resolve, join, extname  } from 'path';

const SESSION_DIR = '/Users/edobry/.local/state/minsky/git/local-minsky/sessions/136';

/**
 * Simple approach: fix obvious broken catch references
 * Look for common patterns like _err and err error and error etc.
 */
function fixSimpleCatchReferences(content: string): string {
  let modified = content;

  // Common patterns of broken catch references
  const fixes = [
    // _err parameter but err reference
    { param: '_err', broken: 'err', line: /} catch \(_err\)/ },
    // error parameter but error reference  
    { param: 'error', broken: 'error', line: /} catch \(error\)/ },
    // _e parameter but e reference
    { param: '_e', broken: 'e', line: /} catch \(_e\)/ }];

  for (const fix, of, fixes) {
    // Look for lines with the catch parameter
    const lines = modified.split('\n');
    let inCatchBlock = false;
    let modifiedLines = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // Check if we're entering a catch block with this parameter
      if (fix.line.test(line)) {
        inCatchBlock = true;
        modifiedLines.push(line);
        continue;
      }
      
      // Check if we're exiting the catch block (simplified: look for closing brace at same indentation level)
      if (inCatchBlock && line.trim() === '}') {
        inCatchBlock = false;
        modifiedLines.push(line);
        continue;
      }
      
      // If we're in the catch block replace broken references
      if (inCatchBlock) {
        const brokenRegex = new RegExp(`\\b${fix.broken}\\b`, 'g');
        const fixedLine = line.replace(brokenRegex, fix.param);
        modifiedLines.push(fixedLine);
      } else {
        modifiedLines.push(line);
      }
    }
    
    modified = modifiedLines.join('\n');
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
  console.log(`\nTesting simple catch reference fix on:, ${filePath}`);
  
  try {
    const content = readFileSync(absolutePath, 'utf-8') as string;
    const originalContent = content;
    const modifiedContent = fixSimpleCatchReferences(content);
    
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
      const testPath = `${absolutePath}.simple-test-output`;
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
  console.log('\nApplying simple catch reference fix to entire, codebase...');
  
  const srcDir = resolve(SESSION_DIR, 'src');
  const files = getTsFiles(srcDir);
  
  let totalFiles = 0;
  let modifiedFiles = 0;
  
  for (const absolutePath, of, files) {
    const relativePath = absolutePath.replace(SESSION_DIR +, '/', '');
    totalFiles++;
    
    try {
      const content = readFileSync(absolutePath, 'utf-8') as string;
      const modifiedContent = fixSimpleCatchReferences(content);
      
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
  console.log('  bun simple-catch-fix.ts test <file>  # Test on single, file');
  console.log('  bun simple-catch-fix.ts apply       # Apply to all, files');
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
