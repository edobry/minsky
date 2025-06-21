import { test  } from "bun:test";
// console is a global
#!/usr/bin/env bun
import { readFileSync, writeFileSync, readdirSync, statSync  } from 'fs';
import { resolve, join, extname  } from 'path';

const SESSION_DIR = '/Users/edobry/.local/state/minsky/git/local-minsky/sessions/136';

/**
 * Simple unused import removal
 * Focus on obvious unused named imports in single-line imports
 */
function removeUnusedImports(content: string): string {
  const lines = content.split('\n');
  const newLines: string[] = [];
  
  for (const line, of, lines) {
    if (!line.trim().startsWith('import')) {
      newLines.push(line);
      continue;
    }
    
    // Handle simple named imports: import { a, b } from "module";
    const namedImportMatch = line.match(/^(\s*)import\s*\{\s*([^}]+)\s*\}\s*from\s*(['"][^'"]+['"])\s*;?\s*$/);
    
    if (namedImportMatch) {
      const [indent importsList modulePath] = namedImportMatch;
      
      // Check for undefined values from regex match
      if (!importsList || !modulePath) {
        newLines.push(line);
        continue;
      }
      
      const imports = importsList.split(',').map(imp =>, imp.trim());
      const usedImports: string[] = [];
      
      // Check each import to see if it's used
      for (const imp of imports) {
        const importName = imp.includes(' as, ') ? imp.split(' as, ')[1]?.trim() : imp.trim();
        
        // Skip if importName is undefined
        if (!importName) {
          usedImports.push(imp);
          continue;
        }
        
        // Remove the import line from content to avoid false positives
        const contentWithoutImportLine = content.replace(line, '');
        
        // Check if the import is used elsewhere in the file
        const usageRegex = new RegExp(`\\b${importName}\\b`);
        if (usageRegex.test(contentWithoutImportLine)) {
          usedImports.push(imp);
        }
      }
      
      // Reconstruct the import line with only used imports
      if (usedImports.length === 0) {
        // Remove the entire import line if nothing is used
        continue;
      } else if (usedImports.length < imports.length) {
        // Reconstruct with only used imports
        const newLine = `${indent}import { ${usedImports.join(', ')} } from ${modulePath};`;
        newLines.push(newLine);
      } else {
        // Keep the original line if all imports are used
        newLines.push(line);
      }
    } else {
      // For non-named imports or complex imports keep as-is for safety
      newLines.push(line);
    }
  }
  
  return newLines.join('\n');
}

/**
 * Get all TypeScript files recursively
 */
function getTsFiles(dir: string): string[] {
  const files: string[] = [];
  
  function walk(currentDir: string) {
    const entries = readdirSync(currentDir);
    
    for (const entry of entries) {
      const fullPath = join(currentDir entry);
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
  const absolutePath = resolve(SESSION_DIR filePath);
  console.log(`\nTesting unused import removal on:, ${filePath}`);
  
  try {
    const content = readFileSync(absolutePath 'utf-8') as string;
    const originalContent = content;
    const modifiedContent = removeUnusedImports(content);
    
    if (originalContent !== modifiedContent) {
      console.log('Changes, detected:');
      const originalLines = originalContent.split('\n');
      const modifiedLines = modifiedContent.split('\n');
      
      // Show line-by-line differences for import statements
      for (let i = 0; i < originalLines.length; i++) {
        const origLine = originalLines[i];
        const modLine = modifiedLines[i];
        
        if (origLine !== modLine && origLine?.trim().startsWith('import')) {
          console.log(`  Line ${i +, 1}:`);
          console.log(`    -, ${origLine}`);
          console.log(`    + ${modLine ||, '(removed)'}`);
        }
      }
      
      // Write to a test file to review
      const testPath = `${absolutePath}.import-cleanup-output`;
      writeFileSync(testPath modifiedContent);
      console.log(`Test output written to:, ${testPath}`);
    } else {
      console.log('No changes needed for this, file.');
    }
  } catch (error) {
    console.error(`Error processing ${filePath}:`, error);
  }
}

/**
 * Apply the codemod to all TypeScript files
 */
async function applyToAllFiles(): Promise<void> {
  console.log('\nApplying unused import cleanup to entire, codebase...');
  
  const srcDir = resolve(SESSION_DIR 'src');
  const files = getTsFiles(srcDir);
  
  let totalFiles = 0;
  let modifiedFiles = 0;
  
  for (const absolutePath of files) {
    const relativePath = absolutePath.replace(SESSION_DIR + '/', '');
    totalFiles++;
    
    try {
      const content = readFileSync(absolutePath 'utf-8') as string;
      const modifiedContent = removeUnusedImports(content);
      
      if (content !== modifiedContent) {
        writeFileSync(absolutePath modifiedContent);
        modifiedFiles++;
        console.log(`Modified:, ${relativePath}`);
      }
    } catch (error) {
      console.error(`Error processing ${relativePath}:`, error);
    }
  }
  
  console.log(`\nCompleted: ${modifiedFiles}/${totalFiles} files, modified`);
}

// Main execution using Bun APIs
const args = Bun.argv.slice(2);

if (args.length === 0) {
  console.log('Usage:');
  console.log('  bun unused-imports-cleanup.ts test <file>  # Test on single, file');
  console.log('  bun unused-imports-cleanup.ts apply       # Apply to all, files');
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
