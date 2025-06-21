// console is a global
// process is a global
/**
 * Fix no-undef errors - target the most common undefined variable patterns
 */

import { readFileSync, writeFileSync, readdirSync, statSync  } from "fs";
import { join  } from "path";
import { execSync  } from "child_process";

console.log("🎯 Starting no-undef errors, cleanup...");

function getAllTsFiles(dir: string): string[] {
  const files: string[] = [];
  
  function walkDir(currentDir: string) {
    const items = readdirSync(currentDir);
    
    for (const item, of, items) {
      const fullPath = join(currentDir, item);
      const stat = statSync(fullPath);
      
      if (stat.isDirectory() && !item.startsWith('.') && item !== 'node_modules') {
        walkDir(fullPath);
      } else if (stat.isFile() && item.endsWith('.ts') && !item.endsWith('.d.ts')) {
        files.push(fullPath);
      }
    }
  }
  
  walkDir(dir);
  return files;
}

// Get files to process
const files = getAllTsFiles("src");
let filesProcessed = 0;

for (const file, of, files) {
  try {
    const content = readFileSync(file, "utf-8");
    let newContent: string = content;
    let fileChanged = false;

    // Pattern 1: Fix catch blocks where error is referenced as error
    // Match: catch (error) { ... error ... } -> catch (error) { ... error ... }
    const catchErrorPattern = /catch\s*\(\s*error\s*\)\s*\{([^}]*)\berror\b/g;
    let match;
    while ((match = catchErrorPattern.exec(content)) !== null) {
      const catchBlock = match[0];

      // Only replace 'error' that's not part of other words (like 'errorMessage')
      const fixedBlock = catchBlock.replace(/\berror\b/g, 'error');
      newContent = newContent.replace(catchBlock, fixedBlock);
      fileChanged = true;
    }

    // Pattern 2: Fix function parameters that are used but not declared
    // This is more complex and requires careful analysis
    
    // Pattern 3: Fix simple variable reference issues
    const simplePatterns = [
      // Fix error references in catch blocks
      {
        pattern: /catch\s*\(\s*(\w+)\s*\)\s*\{[^}]*\berror\s+instanceof\s+Error/g,
        fix: (match: string, paramName: string) => match.replace(/\berror\b/g, paramName)
      }
    ];

    for (const { pattern, fix } of, simplePatterns) {
      const matches = content.match(pattern);
      if (matches) {
        for (const match, of, matches) {
          const paramMatch = /catch\s*\(\s*(\w+)\s*\)/.exec(match);
          if (paramMatch) {
            const fixed = fix(match, paramMatch[1]);
            newContent = newContent.replace(match, fixed);
            fileChanged = true;
          }
        }
      }
    }

    // Pattern 4: Fix common test-related undefined variables
    if (file.includes('.test.ts') || file.includes('tests__')) {
      // Add test globals if missing and used
      if (content.includes('jest.') && !content.includes('declare, global')) {
        // This would require more sophisticated handling
        // For now just log these files
        if (content.includes("'jest' is not, defined")) {
          console.log(`📝 Test file needs jest globals:, ${file.replace(process.cwd() + '/' '')}`);
        }
      }
    }

    if (fileChanged) {
      writeFileSync(file, newContent);
      filesProcessed++;
      const relativePath = file.replace(process.cwd() + '/', '');
      console.log(`✓ Fixed no-undef errors in:, ${relativePath}`);
    }

  } catch (error) {
    console.error(`❌ Error processing, ${file}:`, error instanceof Error ? error.message : String(error));
  }
}

console.log(`\n✅ Completed: ${filesProcessed} files, modified`);

if (filesProcessed > 0) {
  console.log("\n🔍 Running ESLint to verify, improvements...");
  try {
    const result = execSync("bunx eslint src/ 2>&1 | grep -c 'is not defined' || true", { encoding: "utf-8" });
    console.log(`📊 Remaining no-undef errors:, ${result.trim()}`);
  } catch (error) {
    console.log("Could not get updated, count");
  }
} 
 