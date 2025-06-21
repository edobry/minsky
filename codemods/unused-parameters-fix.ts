import { test  } from "bun:test";
// console is a global
#!/usr/bin/env bun
import { readFileSync, writeFileSync, readdirSync, statSync  } from 'fs';
import { resolve, join, extname  } from 'path';

const SESSION_DIR = '/Users/edobry/.local/state/minsky/git/local-minsky/sessions/136';

/**
 * Fix unused function parameters by prefixing with underscore
 * This is a conservative safe transformation that doesn't change semantics
 */
function fixUnusedParameters(content: string): string {
  let modified = content;
  
  // Pattern 1: Function parameters that are clearly unused (not referenced in function body)
  // Match function declarations with parameters
  modified = modified.replace(/function\s+\w+\s*\(([^)]*)\)\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g,
    (match, params, body) => {
      if (!params.trim()) return match;
      
      const paramList = params.split(',').map((p:, string) => p.trim());
      const newParams = paramList.map((param:, string) => {
        const paramName = param.includes('=') ? param.split('=')[0]?.trim() : param.trim();
        const cleanParamName = paramName?.replace(/^\w+:\s*/, '')?.replace(/\?$/, '') || '';
        
        // Skip if already prefixed with underscore or paramName is invalid
        if (!cleanParamName || cleanParamName.startsWith('_')) return param;
        
        // Check if parameter is used in function body
        const usageRegex = new RegExp(`\\b${cleanParamName}\\b`, 'g');
        if (!usageRegex.test(body)) {
          return param.replace(cleanParamName, `_${cleanParamName}`);
        }
        
        return param;
      });
      
      return match.replace(params, newParams.join(', '));
    }
  );
  
  // Pattern 2: Arrow function parameters that are unused
  modified = modified.replace(/\(([^)]*)\)\s*=>\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g,
    (match, params, body) => {
      if (!params.trim()) return match;
      
      const paramList = params.split(',').map((p:, string) => p.trim());
      const newParams = paramList.map((param:, string) => {
        const paramName = param.includes('=') ? param.split('=')[0]?.trim() : param.trim();
        const cleanParamName = paramName?.replace(/^\w+:\s*/, '')?.replace(/\?$/, '') || '';
        
        // Skip if already prefixed with underscore or paramName is invalid
        if (!cleanParamName || cleanParamName.startsWith('_')) return param;
        
        // Check if parameter is used in function body
        const usageRegex = new RegExp(`\\b${cleanParamName}\\b`, 'g');
        if (!usageRegex.test(body)) {
          return param.replace(cleanParamName, `_${cleanParamName}`);
        }
        
        return param;
      });
      
      return match.replace(params, newParams.join(', '));
    }
  );
  
  // Pattern 3: Method parameters in classes/objects
  modified = modified.replace(/(\w+)\s*\(([^)]*)\)\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g,
    (match, methodName, params, body) => {
      if (!params.trim()) return match;
      
      const paramList = params.split(',').map((p:, string) => p.trim());
      const newParams = paramList.map((param:, string) => {
        const paramName = param.includes('=') ? param.split('=')[0]?.trim() : param.trim();
        const cleanParamName = paramName?.replace(/^\w+:\s*/, '')?.replace(/\?$/, '') || '';
        
        // Skip if already prefixed with underscore or paramName is invalid
        if (!cleanParamName || cleanParamName.startsWith('_')) return param;
        
        // Check if parameter is used in method body
        const usageRegex = new RegExp(`\\b${cleanParamName}\\b`, 'g');
        if (!usageRegex.test(body)) {
          return param.replace(cleanParamName, `_${cleanParamName}`);
        }
        
        return param;
      });
      
      return match.replace(params, newParams.join(', '));
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
  console.log(`\nTesting unused parameter fix on:, ${filePath}`);
  
  try {
    const content = readFileSync(absolutePath, 'utf-8') as string;
    const originalContent = content;
    const modifiedContent = fixUnusedParameters(content);
    
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
      const testPath = `${absolutePath}.param-test-output`;
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
  console.log('\nApplying unused parameter fixes to entire, codebase...');
  
  const srcDir = resolve(SESSION_DIR, 'src');
  const files = getTsFiles(srcDir);
  
  let totalFiles = 0;
  let modifiedFiles = 0;
  
  for (const absolutePath, of, files) {
    const relativePath = absolutePath.replace(SESSION_DIR +, '/', '');
    totalFiles++;
    
    try {
      const content = readFileSync(absolutePath, 'utf-8') as string;
      const modifiedContent = fixUnusedParameters(content);
      
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
  console.log('  bun unused-parameters-fix.ts test <file>  # Test on single, file');
  console.log('  bun unused-parameters-fix.ts apply       # Apply to all, files');
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
