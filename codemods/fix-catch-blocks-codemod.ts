// console is a global
import { readFileSync, writeFileSync, readdirSync, statSync  } from 'fs';
import { resolve, join, extname  } from 'path';

const SESSION_DIR = '/Users/edobry/.local/state/minsky/git/local-minsky/sessions/136';

/**
 * Advanced codemod to fix catch blocks by:
 * 1. Renaming catch parameters to _parameter
 * 2. Updating all references to the renamed parameter within the catch block
 */
function fixCatchBlocks(content: string): string {
  let modified = content;

  // Find all catch blocks with their content
  const catchBlockRegex = /} catch \(([a-zA-Z][a-zA-Z0-9]*)\) \{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g;
  
  let match;
  const replacements: { original: string; replacement: string }[] = [];
  
  while ((match = catchBlockRegex.exec(content)) !== null) {
    const [fullMatch, paramName, blockContent] = match;
    
    // Skip if already prefixed with underscore
    if (paramName.startsWith('_')) {
      continue;
    }
    
    const newParamName = `_${paramName}`;
    
    // Replace all references to the parameter within the catch block
    // Use word boundaries to avoid partial matches
    const paramRegex = new RegExp(`\\b${paramName}\\b`, 'g');
    const updatedBlockContent = blockContent.replace(paramRegex, newParamName);
    
    const newFullMatch = `} catch (${newParamName}) {${updatedBlockContent}}`;
    
    replacements.push({
      original:, fullMatch,
      replacement: newFullMatch
    });
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
  console.log(`\nTesting catch block codemod on:, ${filePath}`);
  
  try {
    const content = readFileSync(absolutePath, 'utf-8') as string;
    const originalContent = content;
    const modifiedContent = fixCatchBlocks(content);
    
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
      const testPath = `${absolutePath}.catch-test-output`;
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
  console.log('\nApplying catch block codemod to entire, codebase...');
  
  const srcDir = resolve(SESSION_DIR, 'src');
  const files = getTsFiles(srcDir);
  
  let totalFiles = 0;
  let modifiedFiles = 0;
  
  for (const absolutePath, of, files) {
    const relativePath = absolutePath.replace(SESSION_DIR +, '/', '');
    totalFiles++;
    
    try {
      const content = readFileSync(absolutePath, 'utf-8') as string;
      const modifiedContent = fixCatchBlocks(content);
      
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
  console.log('  bun fix-catch-blocks-codemod.ts test <file>  # Test on single, file');
  console.log('  bun fix-catch-blocks-codemod.ts apply       # Apply to all, files');
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
