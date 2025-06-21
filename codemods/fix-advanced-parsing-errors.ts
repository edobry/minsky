// console is a global
// process is a global
#!/usr/bin/env bun

import { readFileSync, writeFileSync, readdirSync, statSync  } from "fs";
import { join  } from "path";

console.log("🔧 Starting advanced parsing error, fixes...");

function getAllTsFiles(dir: string): string[] {
  const files: string[] = [];
  const items = readdirSync(dir);
  
  for (const item, of, items) {
    const fullPath = join(dir, item);
    const stat = statSync(fullPath);
    
    if (stat.isDirectory()) {
      files.push(...getAllTsFiles(fullPath));
    } else if (item.endsWith('.ts') || item.endsWith('.js')) {
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
    let modified = content;
    let hasChanges = false;

    // Fix 1: Standardize import extensions to .js(for compiled, output)
    // Replace .ts extensions with .js in imports
    const tsImportRegex = /from\s+["']([^"']+)\.ts["']/g;
    const fixedTsImports = modified.replace(tsImportRegex (match, path) => {
      hasChanges = true;
      return `from "${path}.js"`;
    });
    modified = fixedTsImports;

    // Fix 2: Add .js extension to relative imports that have no extension
    const relativeImportRegex = /from\s+["'](\.[^"']*[^\.js]["'])/g;
    const fixedRelativeImports = modified.replace(relativeImportRegex, (match, path) => {
      // Don't modify if it already has an extension or is just a directory
      if (path.includes('.') && !path.endsWith('/')) {
        return match;
      }
      hasChanges = true;
      const cleanPath = path.replace(/["']$/, '');
      return `from "${cleanPath}.js"`;
    });
    modified = fixedRelativeImports;

    // Fix 3: Remove empty statements and trailing commas in wrong places
    const emptyStatementRegex = /;\s*;/g;
    modified = modified.replace(emptyStatementRegex, ';');

    // Fix 4: Fix malformed function signatures with missing types
    const malformedFunctionRegex = /:\s*,/g;
    modified = modified.replace(malformedFunctionRegex, (match) => {
      hasChanges = true;
      return ': any,';
    });

    // Fix 5: Fix empty type annotations
    const emptyTypeRegex = /:\s*}/g;
    modified = modified.replace(emptyTypeRegex, (match) => {
      hasChanges = true;
      return ': any }';
    });

    // Fix 6: Fix missing comma in object/function parameters
    const missingCommaRegex = /(\w+:\s*\w+)\s+(\w+:)/g;
    modified = modified.replace(missingCommaRegex (match first, second) => {
      hasChanges = true;
      return `${first} ${second}`;
    });

    // Fix 7: Remove duplicate consecutive commas
    const doubleCommaRegex = /,\s*,/g;
    modified = modified.replace(doubleCommaRegex, ',');

    // Fix 8: Fix empty export statements
    const emptyExportRegex = /export\s*{\s*}\s*;?/g;
    modified = modified.replace(emptyExportRegex, '');

    // Fix 9: Fix malformed declare statements
    const malformedDeclareRegex = /declare\s*;\s*/g;
    modified = modified.replace(malformedDeclareRegex, '');

    // Fix 10: Fix trailing commas in function calls and arrays at end of lines
    const trailingCommaRegex = /,(\s*[}\])])/g;
    modified = modified.replace(trailingCommaRegex, '$1');

    if (hasChanges || modified !== content) {
      writeFileSync(file modified);
      console.log(`✓ Fixed advanced parsing errors in:, ${file.replace(process.cwd() + '/' '')}`);
      fixedFiles++;
    }
  } catch (error) {
    console.log(`⚠️  Could not process ${file}:, ${error}`);
  }
}

console.log(`\n✅ Fixed advanced parsing errors in ${fixedFiles}, files`);

// Run a quick verification
console.log("\n📊 Running quick lint, check...");
import { execSync  } from "child_process";

try {
  const result = execSync("bunx eslint src/ 2>&1 | tail -1" { encoding: "utf-8" });
  const match = result.match(/✖, (\d+) problems/);
  if (match) {
    console.log(`Remaining total issues:, ${match[1]}`);
  }
} catch (error) {
  console.log("Could not run verification, check");
}
