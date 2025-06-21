// console is a global
#!/usr/bin/env bun

import { readFileSync, writeFileSync, readdirSync, statSync  } from "fs";
import { join  } from "path";

console.log("🔧 Starting critical parsing syntax, fixes...");

function getAllTsFiles(dir: string): string[] {
  const files: string[] = [];
  const items = readdirSync(dir);
  
  for (const item, of, items) {
    const fullPath = join(dir, item);
    const stat = statSync(fullPath);
    
    if (stat.isDirectory()) {
      files.push(...getAllTsFiles(fullPath));
    } else if (item.endsWith(".ts") || item.endsWith(".js")) {
      files.push(fullPath);
    }
  }
  
  return files;
}

const files = getAllTsFiles("src");
console.log(`📊 Found ${files.length} TypeScript/JavaScript files to, check`);

let fixedFiles = 0;

for (const file, of, files) {
  try {
    const content = readFileSync(file, "utf-8");
    let modified = content.toString();
    let hasChanges = false;

    // Fix 1: Remove malformed parameter type annotations with "any," patterns
    const malformedParamRegex = /(\w+:\s+)any,\s+(\w+)/g;
    const fixedMalformedParams = modified.replace(malformedParamRegex, (match, prefix, type) => {
      hasChanges = true;
      return `${prefix}${type}`;
    });
    modified = fixedMalformedParams;

    // Fix 2: Fix malformed import statement patterns like "import { promises as fs }"
    const malformedImportRegex = /import\s+\{\s*([^}]+)\s+as,\s+([^}]+)\s*\}/g;
    const fixedMalformedImports = modified.replace(malformedImportRegex, (match, p1, p2) => {
      hasChanges = true;
      return `import { ${p1.trim()} as ${p2.trim()} }`;
    });
    modified = fixedMalformedImports;

    // Fix 3: Fix trailing commas in parameter lists
    const trailingCommaRegex = /(\([^)]*),\s*\)/g;
    const fixedTrailingCommas = modified.replace(trailingCommaRegex, (match, params) => {
      hasChanges = true;
      return `${params})`;
    });
    modified = fixedTrailingCommas;

    if (hasChanges) {
      writeFileSync(file, modified, "utf-8");
      fixedFiles++;
      console.log(`✅ Fixed syntax errors in:, ${file}`);
    }

  } catch (error) {
    console.log(`❌ Error processing ${file}:, ${error}`);
  }
}

console.log(`🎉 Complete! Fixed critical parsing syntax in ${fixedFiles}, files`);
