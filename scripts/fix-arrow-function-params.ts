#!/usr/bin/env bun

import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join, extname } from "path";

interface FixPattern {
  pattern: RegExp;
  replacement: string;
}

// Common patterns for arrow function parameter fixes
const patterns: FixPattern[] = [
  // _command parameter used as command
  {
    pattern: /(\w+:\s*(?:async\s*)?\()(_command)(\s*:\s*unknown\s*\)\s*=>\s*[^}]*?)\bcommand\b/g,
    replacement: "$1command$3command",
  },
  // _path parameter used as path
  {
    pattern: /(\w+:\s*(?:async\s*)?\()(_path)(\s*:\s*unknown\s*\)\s*=>\s*[^}]*?)\bpath\b/g,
    replacement: "$1path$3path",
  },
  // _sessionName parameter used as sessionName
  {
    pattern:
      /(\w+:\s*(?:async\s*)?\()(_sessionName)(\s*:\s*unknown\s*\)\s*=>\s*[^}]*?)\bsessionName\b/g,
    replacement: "$1sessionName$3sessionName",
  },
  // _taskId parameter used as taskId
  {
    pattern: /(\w+:\s*(?:async\s*)?\()(_taskId)(\s*:\s*unknown\s*\)\s*=>\s*[^}]*?)\btaskId\b/g,
    replacement: "$1taskId$3taskId",
  },
  // _id parameter used as id
  {
    pattern: /(\w+:\s*(?:async\s*)?\()(_id)(\s*:\s*unknown\s*\)\s*=>\s*[^}]*?)\bid\b/g,
    replacement: "$1id$3id",
  },
  // _name parameter used as name
  {
    pattern: /(\w+:\s*(?:async\s*)?\()(_name)(\s*:\s*unknown\s*\)\s*=>\s*[^}]*?)\bname\b/g,
    replacement: "$1name$3name",
  },
];

// Simpler single-line patterns for common cases
const simplePatterns: FixPattern[] = [
  // Single line arrow functions
  {
    pattern: /(\(\s*)(_command)(\s*:\s*unknown\s*\)\s*=>\s*[^{;]*?)\bcommand\b/,
    replacement: "$1command$3command",
  },
  {
    pattern: /(\(\s*)(_path)(\s*:\s*unknown\s*\)\s*=>\s*[^{;]*?)\bpath\b/,
    replacement: "$1path$3path",
  },
  {
    pattern: /(\(\s*)(_sessionName)(\s*:\s*unknown\s*\)\s*=>\s*[^{;]*?)\bsessionName\b/,
    replacement: "$1sessionName$3sessionName",
  },
  {
    pattern: /(\(\s*)(_taskId)(\s*:\s*unknown\s*\)\s*=>\s*[^{;]*?)\btaskId\b/,
    replacement: "$1taskId$3taskId",
  },
  { pattern: /(\(\s*)(_id)(\s*:\s*unknown\s*\)\s*=>\s*[^{;]*?)\bid\b/, replacement: "$1id$3id" },
  {
    pattern: /(\(\s*)(_name)(\s*:\s*unknown\s*\)\s*=>\s*[^{;]*?)\bname\b/,
    replacement: "$1name$3name",
  },
];

function fixArrowFunctionParams(content: string): { content: string; changeCount: number } {
  let newContent = content;
  let totalChanges = 0;

  // Apply all patterns
  [...patterns, ...simplePatterns].forEach(({ pattern, replacement }) => {
    const before = newContent;
    newContent = newContent.replace(pattern, replacement);
    const matches = (before.match(pattern) || []).length;
    totalChanges += matches;
  });

  return {
    content: newContent,
    changeCount: totalChanges,
  };
}

function findTsFiles(dir: string): string[] {
  const files: string[] = [];

  function walk(currentDir: string) {
    const entries = readdirSync(currentDir);

    for (const entry of entries) {
      const fullPath = join(currentDir, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        if (!["node_modules", "dist", ".git"].includes(entry)) {
          walk(fullPath);
        }
      } else if (extname(entry) === ".ts") {
        files.push(fullPath);
      }
    }
  }

  walk(dir);
  return files;
}

async function main() {
  const files = findTsFiles("src");
  console.log(`Found ${files.length} TypeScript files to process`);

  let totalFiles = 0;
  let totalChanges = 0;

  for (const file of files) {
    try {
      const content = readFileSync(file, "utf8").toString();
      const { content: newContent, changeCount } = fixArrowFunctionParams(content);

      if (changeCount > 0) {
        writeFileSync(file, newContent, "utf8");
        console.log(`✅ Fixed ${changeCount} arrow function parameters in ${file}`);
        totalFiles++;
        totalChanges += changeCount;
      }
    } catch (error) {
      console.error(`❌ Error processing ${file}:`, error);
    }
  }

  console.log("\n📊 Summary:");
  console.log(`   Files modified: ${totalFiles}`);
  console.log(`   Total fixes: ${totalChanges}`);
}

if (import.meta.main) {
  await main();
}
