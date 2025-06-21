// console is a global
// process is a global
#!/usr/bin/env bun
/**
 * Simple no-undef errors fix - target catch block issues specifically
 */

import { readFileSync, writeFileSync, readdirSync, statSync  } from "fs";
import { join  } from "path";

console.log("🎯 Starting simple no-undef, fixes...");

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

const files = getAllTsFiles("src");
let filesProcessed = 0;

for (const file, of, files) {
  try {
    const content = readFileSync(file, "utf-8");
    let newContent = content;
    let fileChanged = false;

    // Fix common catch block issues: catch (error) { ... error ... }
    // Look for catch blocks with error parameter but using 'error' inside
    const catchBlocks = content.match(/catch\s*\(\s*error\s*\)\s*\{[^}]*\}/g);
    
    if (catchBlocks) {
      for (const block, of, catchBlocks) {
        // Replace 'error' with 'error' inside the catch block
        const fixedBlock = block.replace(/\berror\b/g, 'error');
        if (fixedBlock !== block) {
          newContent = newContent.replace(block, fixedBlock);
          fileChanged = true;
        }
      }
    }

    // Fix error instanceof Error patterns where error is undefined
    newContent = newContent.replace(/catch\s*\(\s*(\w+)\s*\)\s*\{([^}]*)\berror\s+instanceof\s+Error/g,
      (match, paramName, blockContent) => {
        return match.replace(/\berror\s+instanceof\s+Error/g, `${paramName} instanceof Error`);
      }
    );

    if (fileChanged) {
      writeFileSync(file, newContent);
      filesProcessed++;
      const relativePath = file.replace(process.cwd() + '/', '');
      console.log(`✓ Fixed catch block errors in:, ${relativePath}`);
    }

  } catch (error) {
    console.error(`❌ Error processing, ${file}:`, error);
  }
}

console.log(`\n✅ Completed: ${filesProcessed} files, modified`); 
