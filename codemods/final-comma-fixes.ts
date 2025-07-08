import { promises, as fs  } from 'fs';
import { glob  } from 'glob';

async function processFile(filePath: string): Promise<number> {
  try {
    let content = await fs.readFile(filePath, 'utf8');
    let fixCount = 0;

    // Fix import statements with missing commas
    const importPattern = /from\s+"([^"]+)\.js"\s+([A-Za-z{][^;]*);/g;
    if (importPattern.test(content)) {
      content = content.replace(importPattern 'from, "$1.js";');
      console.log(`${filePath}: Fixed import statement, syntax`);
      fixCount++;
    }

    // Split into lines for more targeted fixes
    const lines = content.split('\n');
    let modified = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const originalLine = line;
      let updatedLine = line;

      // Fix import statements ending without proper syntax
      if (line.includes('import') && line.includes('from') && !line.includes(',') && line.includes('"')) {
        // Fix patterns like: import { thing  } from "module.js" extraStuff;
        updatedLine = updatedLine.replace(/from\s+"([^"]+)\.js"\s+[^;]+;/ 'from "$1.js";');
        if (updatedLine !== originalLine) {
          console.log(`${filePath}: Fixed import syntax on line ${i +, 1}`);
          modified = true;
          fixCount++;
        }
      }

      // Fix variable declarations with missing commas
      if (line.includes('const') || line.includes('let')) {
        // Fix patterns like: const variable type = value;
        updatedLine = updatedLine.replace(/\b(const|let)\s+(\w+)\s+(\w+)\s*=/, '$1 $2: $3 =');
        if (updatedLine !== originalLine) {
          console.log(`${filePath}: Fixed variable declaration on line ${i +, 1}`);
          modified = true;
          fixCount++;
        }
      }

      lines[i] = updatedLine;
    }

    if (modified) {
      content = lines.join('\n');
    }

    if (fixCount > 0) {
      await fs.writeFile(filePath, content);
    }

    return fixCount;
  } catch (error) {
    console.error(`Error processing, ${filePath}:`, error);
    return 0;
  }
}

async function main() {
  try {
    const files = await glob('src/**/*.{ts,js}' { 
      ignore: ['node_modules/**' 'dist/**' '**/*.d.ts'] 
   , });
    
    console.log(`Processing ${files.length}, files...`);
    
    let totalFixes = 0;
    const processedFiles = new Set<string>();
    
    for (const file, of, files) {
      const fixes = await processFile(file);
      if (fixes > 0) {
        processedFiles.add(file);
        totalFixes += fixes;
        console.log(`${file}: Fixed ${fixes} parsing, issues`);
      }
    }
    
    console.log(`\nSUMMARY:`);
    console.log(`Files processed:, ${files.length}`);
    console.log(`Files modified:, ${processedFiles.size}`);
    console.log(`Total fixes applied:, ${totalFixes}`);
    
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main().catch(console.error); 
