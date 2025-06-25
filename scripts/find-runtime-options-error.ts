#!/usr/bin/env bun

import { readFileSync, readdirSync, statSync } from "fs";
import { join, extname } from "path";

interface OptionsReference {
  file: string;
  line: number;
  content: string;
  context: string[];
}

function findOptionsReferences(dir: string): OptionsReference[] {
  const results: OptionsReference[] = [];

  function scanDirectory(currentDir: string) {
    try {
      const items = readdirSync(currentDir);

      for (const item of items) {
        const fullPath = join(currentDir, item);
        const stat = statSync(fullPath);

        if (stat.isDirectory()) {
          // Skip node_modules and other irrelevant directories
          if (
            !item.startsWith(".") &&
            item !== "node_modules" &&
            item !== "dist" &&
            item !== "coverage" &&
            item !== "test-tmp"
          ) {
            scanDirectory(fullPath);
          }
        } else if (stat.isFile() && extname(item) === ".ts") {
          scanFile(fullPath);
        }
      }
    } catch (error) {
      console.error(`Error scanning directory ${currentDir}:`, error);
    }
  }

  function scanFile(filePath: string) {
    try {
      const content = readFileSync(filePath, "utf-8") as string;
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Look for _options references (but not in comments or strings)
        if (
          line.includes("_options") &&
          !line.trim().startsWith("//") &&
          !line.trim().startsWith("*") &&
          !line.includes("typeof _options")
        ) {
          // Get context lines
          const contextStart = Math.max(0, i - 3);
          const contextEnd = Math.min(lines.length - 1, i + 3);
          const context = lines.slice(contextStart, contextEnd + 1);

          results.push({
            file: filePath.replace(`${process.cwd()}/`, ""),
            line: i + 1,
            content: line.trim(),
            context,
          });
        }
      }
    } catch (error) {
      console.error(`Error reading file ${filePath}:`, error);
    }
  }

  scanDirectory(dir);
  return results;
}

console.log("🔍 Searching for runtime _options references...\n");

const srcResults = findOptionsReferences("src");

console.log(`Found ${srcResults.length} potential _options references:\n`);

// Group by file
const byFile = srcResults.reduce(
  (acc, ref) => {
    if (!acc[ref.file]) acc[ref.file] = [];
    acc[ref.file].push(ref);
    return acc;
  },
  {} as Record<string, OptionsReference[]>
);

for (const [file, refs] of Object.entries(byFile)) {
  console.log(`📁 ${file}`);
  for (const ref of refs) {
    console.log(`  Line ${ref.line}: ${ref.content}`);

    // Show context for potential runtime issues
    console.log("    Context:");
    ref.context.forEach((contextLine, idx) => {
      const lineNum = ref.line - 3 + idx;
      const marker = lineNum === ref.line ? ">>>" : "   ";
      console.log(`    ${marker} ${lineNum}: ${contextLine}`);
    });
    console.log("");
  }
  console.log("");
}

// Look specifically for function calls that might be causing the runtime error
console.log("🎯 Looking for potential runtime execution paths...\n");

const runtimePatterns = [
  /_options\s*\./, // _options.property
  /_options\s*\[/, // _options[key]
  /_options\s*\?/, // _options?.property
  /typeof\s+_options/, // typeof _options
  /\b_options\b(?!\s*[=:])/, // _options used as value (not assignment/declaration)
];

for (const [file, refs] of Object.entries(byFile)) {
  for (const ref of refs) {
    for (const pattern of runtimePatterns) {
      if (pattern.test(ref.content)) {
        console.log(`⚠️  POTENTIAL RUNTIME ISSUE: ${file}:${ref.line}`);
        console.log(`    ${ref.content}`);
        console.log("");
        break;
      }
    }
  }
}
