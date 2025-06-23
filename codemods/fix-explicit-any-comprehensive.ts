#!/usr/bin/env bun

import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

// Get all TypeScript files recursively
function getAllTsFiles(dir: string): string[] {
  const files: string[] = [];

  function traverse(currentDir: string) {
    const entries = readdirSync(currentDir);

    for (const entry of entries) {
      const fullPath = join(currentDir, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        // Skip node_modules and other unwanted directories
        if (!["node_modules", ".git", "dist", "build", "codemods"].includes(entry)) {
          traverse(fullPath);
        }
      } else if (entry.endsWith(".ts")) {
        files.push(fullPath);
      }
    }
  }

  traverse(dir);
  return files;
}

const files = getAllTsFiles(".");
let totalChanges = 0;
const changedFiles = new Set<string>();

for (const file of files) {
  const content = readFileSync(file, "utf8") as string;
  let newContent = content;
  let fileChanges = 0;

  // Comprehensive any type replacements for actual patterns found
  const anyReplacements = [
    // Type assertions: (foo as any)
    { pattern: /\(\s*([^)]+)\s+as\s+any\s*\)/g, replacement: "($1 as unknown)" },

    // Function parameters: (param: any)
    { pattern: /\(\s*([^:,)]+):\s*any\s*\)/g, replacement: "($1: unknown)" },
    { pattern: /,\s*([^:,)]+):\s*any\s*\)/g, replacement: ", $1: unknown)" },
    { pattern: /,\s*([^:,)]+):\s*any\s*,/g, replacement: ", $1: unknown," },

    // Variable declarations: : any =
    { pattern: /:\s*any\s*=/g, replacement: ": unknown =" },

    // Array types: any[]
    { pattern: /:\s*any\[\]/g, replacement: ": unknown[]" },

    // Return types: ): any
    { pattern: /\):\s*any\s*{/g, replacement: "): unknown {" },
    { pattern: /\):\s*any\s*=>/g, replacement: "): unknown =>" },
    { pattern: /\):\s*any\s*;/g, replacement: "): unknown;" },

    // Generic constraints: <T = any>, <T extends any>
    { pattern: /<([^>=]+)\s*=\s*any>/g, replacement: "<$1 = unknown>" },
    { pattern: /<([^>]+)\s+extends\s+any>/g, replacement: "<$1 extends unknown>" },

    // Record types: Record<string, any>
    { pattern: /Record<([^,>]+),\s*any>/g, replacement: "Record<$1, unknown>" },

    // Object type: any as object type
    { pattern: /as\s+any\s*\[\]/g, replacement: "as unknown[]" },
    { pattern: /as\s+any\s*\{/g, replacement: "as Record<string, unknown> {" },

    // Union types: any |
    { pattern: /:\s*any\s*\|/g, replacement: ": unknown |" },
    { pattern: /\|\s*any\s*\|/g, replacement: "| unknown |" },
    { pattern: /\|\s*any\s*$/gm, replacement: "| unknown" },

    // Common patterns in tests and mocks
    {
      pattern: /expect\([^)]*\)\.toEqual\(any\)/g,
      replacement: "expect($&).toEqual(expect.anything())",
    },
    { pattern: /\.mockReturnValue\(any\)/g, replacement: ".mockReturnValue(expect.anything())" },
  ];

  for (const fix of anyReplacements) {
    const matches = newContent.match(fix.pattern);
    if (matches) {
      newContent = newContent.replace(fix.pattern, fix.replacement);
      fileChanges += matches.length;
      console.log(`  ${file}: Fixed ${matches.length} instances of pattern`);
    }
  }

  if (fileChanges > 0) {
    writeFileSync(file, newContent);
    changedFiles.add(file);
    totalChanges += fileChanges;
    console.log(`✅ ${file}: ${fileChanges} explicit any fixes`);
  }
}

console.log(`\n🎯 EXPLICIT ANY CLEANUP COMPLETE:`);
console.log(`   Files modified: ${changedFiles.size}`);
console.log(`   Total fixes: ${totalChanges}`);
