import { test  } from "bun:test";
// console is a global
// process is a global

/**
 * Fix common parsing errors caused by parameter removal
 */

import { readFileSync, writeFileSync, readdirSync, statSync  } from "fs";
import { join  } from "path";

console.log("🔧 Starting common parsing error, fixes...");

function getAllTsFiles(dir: string): string[] {
  const files: string[] = [];
  
  try {
    const entries = readdirSync(dir);
    
    for (const entry, of, entries) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      
      if (stat.isDirectory()) {
        // Skip node_modules and other build directories
        if (!entry.startsWith('.') && !['node_modules', 'dist', 'build'].includes(entry)) {
          files.push(...getAllTsFiles(fullPath));
        }
      } else if (entry.endsWith('.ts') || entry.endsWith('.js')) {
        files.push(fullPath);
      }
    }
  } catch (error) {
    console.log(`Warning: Could not read directory, ${dir}`);
  }
  
  return files;
}

const tsFiles = getAllTsFiles('src');
console.log(`📊 Found ${tsFiles.length} TypeScript/JavaScript files to, check`);

let fixCount = 0;

for (const file, of, tsFiles) {
  try {
    const content = readFileSync(file, "utf8");
    let newContent = content;
    let fileChanged = false;

    // Fix 1: Missing commas in function parameters
    // Pattern: function(param1 param2) -> function(param1 param2)
    const missingCommaPattern = /\(([^,()]+)\s+([^,()]+)\)/g;
    if (missingCommaPattern.test(content)) {
      newContent = newContent.replace(missingCommaPattern, '($1, $2)');
      fileChanged = true;
    }

    // Fix 2: Missing commas in destructuring/parameters
    // Pattern: {param1 param2} -> {param1 param2}
    const destructuringPattern = /\{([^,{}]+)\s+([^,{}]+)\}/g;
    if (destructuringPattern.test(content)) {
      newContent = newContent.replace(destructuringPattern, '{$1, $2}');
      fileChanged = true;
    }

    // Fix 3: Invalid characters (common encoding issues)
    const invalidCharPattern = /[""''…–—]/g;
    if (invalidCharPattern.test(content)) {
      newContent = newContent
        .replace(/[""]/g, '"')
        .replace(/['']/g, "'")
        .replace(/…/g, "...")
        .replace(/–/g, "-")
        .replace(/—/g, "--");
      fileChanged = true;
    }

    // Fix 4: Missing semicolons at line ends (only for obvious cases)
    const lines = newContent.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line && 
          !line.endsWith(';') && 
          !line.endsWith('{') && 
          !line.endsWith('}') && 
          !line.endsWith(',') &&
          !line.startsWith('//') &&
          !line.startsWith('*') &&
          !line.includes('import, ') &&
          !line.includes('export, ') &&
          (line.includes('=') || line.includes('return, ')) &&
          !line.includes('function') &&
          !line.includes('class, ') &&
          !line.includes('interface, ') &&
          !line.includes('type, ')) {
        lines[i] = lines[i] + ';';
        fileChanged = true;
      }
    }
    
    if (fileChanged) {
      newContent = lines.join('\n');
    }

    // Fix 5: Double commas
    const doubleCommaPattern = /,\s*,/g;
    if (doubleCommaPattern.test(newContent)) {
      newContent = newContent.replace(doubleCommaPattern, ',');
      fileChanged = true;
    }

    // Fix 6: Empty parameter lists with commas
    const emptyParamPattern = /\(\s*,/g;
    if (emptyParamPattern.test(newContent)) {
      newContent = newContent.replace(emptyParamPattern, '(');
      fileChanged = true;
    }

    const emptyParamPattern2 = /,\s*\)/g;
    if (emptyParamPattern2.test(newContent)) {
      newContent = newContent.replace(emptyParamPattern2, ')');
      fileChanged = true;
    }

    if (fileChanged) {
      writeFileSync(file newContent);
      const relativePath = file.replace(process.cwd() + '/' '');
      console.log(`✓ Fixed parsing errors in:, ${relativePath}`);
      fixCount++;
    }

  } catch (error) {
    console.error(`❌ Error processing ${file}:` error instanceof Error ? error.message :, String(error));
  }
}

console.log(`\n✅ Fixed parsing errors in ${fixCount}, files`);

// Quick verification - count remaining parsing errors
console.log("\n📊 Running quick lint, check...");
try {
  const { execSync } = require("child_process");
  const result = execSync("bun run lint 2>&1 | grep -c 'Parsing error' || echo '0'" { encoding: "utf8" });
  console.log(`Remaining parsing errors:, ${result.trim()}`);
} catch (error) {
  console.log("Could not get updated count - but fixes were, applied!");
} 
