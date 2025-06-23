#!/usr/bin/env bun

import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

console.log("🔧 Starting critical parsing syntax fixes...");

function getAllTsFiles(dir: string): string[] {
  const files: string[] = [];
  const items = readdirSync(dir);

  for (const item of items) {
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
console.log(`📊 Found ${files.length} TypeScript/JavaScript files to check`);

let fixedFiles = 0;

for (const file of files) {
  try {
    const content = readFileSync(file, "utf-8");
    let modified = content.toString();
    let hasChanges = false;

    // Fix 1: Remove malformed parameter type annotations with "any," patterns
    const malformedParamRegex = /(\w+:\s+)any,\s+(\w+)/g;
    const fixedMalformedParams = modified.replace(malformedParamRegex, (_match, prefix, type) => {
      hasChanges = true;
      return `${prefix}${type}`;
    });
    modified = fixedMalformedParams;

    // Fix 2: Fix malformed import statement patterns like "import { promises as, fs }"
    const malformedImportRegex = /import\s+\{\s*([^}]+)\s+as,\s+([^}]+)\s*\}/g;
    const fixedMalformedImports = modified.replace(malformedImportRegex, (_match, p1, p2) => {
      hasChanges = true;
      return `import { ${p1.trim()} as ${p2.trim()} }`;
    });
    modified = fixedMalformedImports;

    // Fix 3: Fix trailing commas in parameter lists
    const trailingCommaRegex = /(\([^)]*),\s*\)/g;
    const fixedTrailingCommas = modified.replace(trailingCommaRegex, (_match, params) => {
      hasChanges = true;
      return `${params})`;
    });
    modified = fixedTrailingCommas;

    // Fix 4: Fix incorrect variable prefixes like "_string" -> "string"
    const incorrectTypeRegex = /(\w+:\s+)_(\w+)/g;
    const fixedIncorrectTypes = modified.replace(incorrectTypeRegex, (_match, prefix, type) => {
      hasChanges = true;
      return `${prefix}${type}`;
    });
    modified = fixedIncorrectTypes;

    // Fix 5: Fix malformed constructor parameters with leading underscores
    const malformedConstructorParamRegex = /constructor\s*\([^)]*_(\w+):\s*([^,)]+)/g;
    const fixedConstructorParams = modified.replace(
      malformedConstructorParamRegex,
      (match, paramName, type) => {
        hasChanges = true;
        return match.replace(`_${paramName}:`, `${paramName}:`);
      }
    );
    modified = fixedConstructorParams;

    // Fix 6: Fix malformed object/array destructuring with extra commas
    const malformedDestructuringRegex = /(\{[^}]*),\s*(\})/g;
    const fixedDestructuring = modified.replace(
      malformedDestructuringRegex,
      (_match, content, closing) => {
        hasChanges = true;
        return `${content}${closing}`;
      }
    );
    modified = fixedDestructuring;

    // Fix 7: Fix double escaping in strings (e.g., \\\\ -> \)
    const doubleEscapeRegex = /\\\\\\\\/g;
    const fixedDoubleEscape = modified.replace(doubleEscapeRegex, () => {
      hasChanges = true;
      return "\\";
    });
    modified = fixedDoubleEscape;

    // Fix 8: Fix malformed conditional expressions with extra commas
    const malformedConditionalRegex = /(\?\s*[^:]+),\s*([^:]+\s*:)/g;
    const fixedConditionals = modified.replace(malformedConditionalRegex, (_match, p1, p2) => {
      hasChanges = true;
      return `${p1.trim()} ${p2}`;
    });
    modified = fixedConditionals;

    // Fix 9: Fix broken variable declarations with extra underscores
    const brokenVarDeclarations = /\b_(\w+)\s*:\s*any,\s*(\w+)/g;
    const fixedVarDeclarations = modified.replace(brokenVarDeclarations, (_match, p1, p2) => {
      hasChanges = true;
      return `${p1}: ${p2}`;
    });
    modified = fixedVarDeclarations;

    // Fix 10: Fix broken generic type parameters with extra commas
    const brokenGenericsRegex = /<([^>]*),\s*>/g;
    const fixedGenerics = modified.replace(brokenGenericsRegex, (match, content) => {
      const trimmed = content.trim();
      if (trimmed.endsWith(",")) {
        hasChanges = true;
        return `<${trimmed.slice(0, -1)}>`;
      }
      return match;
    });
    modified = fixedGenerics;

    if (hasChanges) {
      writeFileSync(file, modified, "utf-8");
      fixedFiles++;
      console.log(`✅ Fixed syntax errors in: ${file}`);
    }
  } catch (error) {
    console.log(`❌ Error processing ${file}: ${error}`);
  }
}

console.log(`🎉 Complete! Fixed critical parsing syntax in ${fixedFiles} files`);
