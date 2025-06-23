#!/usr/bin/env bun

import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join, extname } from "path";

interface Fix {
  file: string;
  line: number;
  type: "catch-block" | "function-param";
  description: string;
  oldCode: string;
  newCode: string;
}

function getAllTsFiles(dir: string): string[] {
  const files: string[] = [];

  function traverse(currentDir: string) {
    const items = readdirSync(currentDir);

    for (const item of items) {
      const fullPath = join(currentDir, item);
      const stat = statSync(fullPath);

      if (stat.isDirectory() && !item.startsWith(".") && item !== "node_modules") {
        traverse(fullPath);
      } else if (stat.isFile() && extname(item) === ".ts") {
        files.push(fullPath);
      }
    }
  }

  traverse(dir);
  return files;
}

function fixFile(filePath: string): Fix[] {
  const fixes: Fix[] = [];
  const content = readFileSync(filePath, "utf8") as string;
  const lines = content.split("\n");
  let modified = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;

    // Fix catch blocks with underscore parameters that are used without underscore
    const catchMatch = line.match(/catch\s*\(\s*(_\w+)\s*\)/);
    if (catchMatch) {
      const underscoreVar = catchMatch[1];
      const varWithoutUnderscore = underscoreVar.slice(1);

      // Look for usage of the variable without underscore in the next 20 lines
      let foundUsage = false;
      for (let j = i + 1; j < Math.min(i + 21, lines.length); j++) {
        const nextLine = lines[j];

        // Skip if we hit another catch or function
        if (nextLine.includes("catch") || nextLine.includes("function")) break;
        if (nextLine.includes("}") && nextLine.trim() === "}") break;

        // Check for usage without underscore
        const regex = new RegExp(`\\b${varWithoutUnderscore}\\b(?!_)`);
        if (regex.test(nextLine) && !nextLine.includes(underscoreVar)) {
          foundUsage = true;
          break;
        }
      }

      if (foundUsage) {
        const oldLine = line;
        const newLine = line.replace(underscoreVar, varWithoutUnderscore);
        lines[i] = newLine;
        modified = true;

        fixes.push({
          file: filePath,
          line: lineNumber,
          type: "catch-block",
          description: `Fixed catch parameter: ${underscoreVar} → ${varWithoutUnderscore}`,
          oldCode: oldLine.trim(),
          newCode: newLine.trim(),
        });
      }
    }

    // Fix function parameters with underscores that are used without underscore
    const funcMatch = line.match(/function\s+\w+\s*\([^)]*(_\w+)[^)]*/);
    if (funcMatch) {
      const underscoreParam = funcMatch[1];
      const paramWithoutUnderscore = underscoreParam.slice(1);

      // Look for usage without underscore in function body
      let braceCount = 0;
      let inFunction = false;
      let foundUsage = false;

      for (let j = i; j < lines.length; j++) {
        const nextLine = lines[j];

        if (nextLine.includes("{")) {
          braceCount += (nextLine.match(/\{/g) || []).length;
          inFunction = true;
        }
        if (nextLine.includes("}")) {
          braceCount -= (nextLine.match(/\}/g) || []).length;
        }

        if (inFunction && braceCount === 0) break;

        if (inFunction && j > i) {
          const regex = new RegExp(`\\b${paramWithoutUnderscore}\\b(?!_)`);
          if (regex.test(nextLine) && !nextLine.includes(underscoreParam)) {
            foundUsage = true;
            break;
          }
        }
      }

      if (foundUsage) {
        const oldLine = line;
        const newLine = line.replace(underscoreParam, paramWithoutUnderscore);
        lines[i] = newLine;
        modified = true;

        fixes.push({
          file: filePath,
          line: lineNumber,
          type: "function-param",
          description: `Fixed function parameter: ${underscoreParam} → ${paramWithoutUnderscore}`,
          oldCode: oldLine.trim(),
          newCode: newLine.trim(),
        });
      }
    }

    // Fix arrow function parameters with underscores
    const arrowMatch = line.match(/\(\s*([^)]*_\w+[^)]*)\s*\)\s*=>/);
    if (arrowMatch) {
      const params = arrowMatch[1];
      const underscoreParams = params.match(/_\w+/g) || [];

      for (const underscoreParam of underscoreParams) {
        const paramWithoutUnderscore = underscoreParam.slice(1);

        // Look for usage in the arrow function body
        let braceCount = 0;
        let inFunction = false;
        let foundUsage = false;

        for (let j = i; j < lines.length; j++) {
          const nextLine = lines[j];

          if (nextLine.includes("{")) {
            braceCount += (nextLine.match(/\{/g) || []).length;
            inFunction = true;
          }
          if (nextLine.includes("}")) {
            braceCount -= (nextLine.match(/\}/g) || []).length;
          }

          if (inFunction && braceCount === 0) break;

          if (j > i) {
            const regex = new RegExp(`\\b${paramWithoutUnderscore}\\b(?!_)`);
            if (regex.test(nextLine) && !nextLine.includes(underscoreParam)) {
              foundUsage = true;
              break;
            }
          }
        }

        if (foundUsage) {
          const oldLine = line;
          const newLine = line.replace(underscoreParam, paramWithoutUnderscore);
          lines[i] = newLine;
          modified = true;

          fixes.push({
            file: filePath,
            line: lineNumber,
            type: "function-param",
            description: `Fixed arrow function parameter: ${underscoreParam} → ${paramWithoutUnderscore}`,
            oldCode: oldLine.trim(),
            newCode: newLine.trim(),
          });
        }
      }
    }
  }

  if (modified) {
    writeFileSync(filePath, lines.join("\n"), "utf8");
  }

  return fixes;
}

function main() {
  const srcDir = "src";
  const files = getAllTsFiles(srcDir);

  console.log(`Fixing variable naming issues in ${files.length} TypeScript files...\n`);

  let totalFixes = 0;
  const fixesByFile: Record<string, Fix[]> = {};

  for (const file of files) {
    const fixes = fixFile(file);
    if (fixes.length > 0) {
      fixesByFile[file] = fixes;
      totalFixes += fixes.length;
    }
  }

  if (totalFixes === 0) {
    console.log("✅ No variable naming issues to fix!");
    return;
  }

  console.log(`🔧 Applied ${totalFixes} fixes:\n`);

  for (const [file, fixes] of Object.entries(fixesByFile)) {
    console.log(`📁 ${file}`);
    for (const fix of fixes) {
      console.log(`  Line ${fix.line}: ${fix.description}`);
    }
    console.log();
  }

  console.log(`\nTotal fixes applied: ${totalFixes}`);
  console.log("\nNext steps:");
  console.log("1. Run tests to ensure nothing broke");
  console.log("2. Commit the changes");
  console.log("3. Run the checker script again to verify all issues are resolved");
}

if (import.meta.main) {
  main();
}
