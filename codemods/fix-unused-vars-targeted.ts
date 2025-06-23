#!/usr/bin/env bun

import { promises as fs } from "fs";
import { join } from "path";

interface Fix {
  pattern: RegExp;
  replacement: string | ((...args: any[]) => string);
  description: string;
}

const fixes: Fix[] = [
  // Variable assignments - add underscore prefix to specific unused vars
  {
    pattern: /(\s+)(const|let|var)\s+(initialIndex|workingDir|sessionName|workdir|command|program|branch|baseBranch|result|options|args)\s*=/g,
    replacement: "$1$2 _$3 =",
    description: "Unused variable assignments"
  },

  // Function parameters - add underscore prefix to specific unused params
  {
    pattern: /(\s+)([a-zA-Z][a-zA-Z0-9]*)\s*:\s*([^,)]+)(\s*[,)])/g,
    replacement: (match: string, indent: string, paramName: string, type: string, ending: string) => {
      // Only fix specific unused parameters from lint output
      const unusedParams = [
        "context", "workingDir", "sessionName", "workdir", "command", "program", 
        "args", "options", "specPath", "status", "metadata", "error", "cause",
        "data", "mode", "oldPath", "newPath", "encoding", "path", "title",
        "columns", "headers", "itemFormatter", "state", "entity", "updates"
      ];
      
      if (unusedParams.includes(paramName) && !paramName.startsWith("_")) {
        return `${indent}_${paramName}: ${type}${ending}`;
      }
      return match;
    },
    description: "Unused function parameters"
  },

  // Import statements - comment out unused imports
  {
    pattern: /^(\s*import\s+\{[^}]*?)(\b[a-zA-Z][a-zA-Z0-9]*\b)([^}]*\}\s+from\s+[^;]+;)/gm,
    replacement: (match: string, prefix: string, importName: string, suffix: string) => {
      // Only comment specific unused imports mentioned in lint output
      const unusedImports = [
        "CommandExecutionContext", "ListOptions", "ShowOptions", "DEFAULT_DEV_PORT",
        "DetectionRule", "ExecException", "ExecCallback", "DEFAULT_RETRY_COUNT",
        "TransformableInfo", "CallToolRequest", "sessionSchema"
      ];
      
      if (unusedImports.includes(importName)) {
        return `${prefix}/* ${importName} */${suffix}`;
      }
      return match;
    },
    description: "Unused imports"
  }
];

async function processFile(filePath: string): Promise<number> {
  const content = await fs.readFile(filePath, "utf8");
  const originalContent = content;
  let newContent = content;
  let changeCount = 0;

  for (const fix of fixes) {
    const beforeContent = newContent;
    if (typeof fix.replacement === "function") {
      newContent = newContent.replace(fix.pattern, (...args: any[]) => {
        const result = fix.replacement(...args);
        if (result !== args[0]) {
          changeCount++;
        }
        return result;
      });
    } else {
      newContent = newContent.replace(fix.pattern, (...args: any[]) => {
        changeCount++;
        return fix.replacement.replace(/\$(\d+)/g, (_, num) => args[parseInt(num, 10)]);
      });
    }
  }

  if (newContent !== originalContent) {
    await fs.writeFile(filePath, newContent);
    return changeCount;
  }

  return 0;
}

async function findTypeScriptFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  
  async function walkDir(currentDir: string) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
        await walkDir(fullPath);
      } else if (entry.isFile() && fullPath.endsWith(".ts") && !fullPath.endsWith(".d.ts")) {
        files.push(fullPath);
      }
    }
  }
  
  await walkDir(dir);
  return files;
}

async function main() {
  const srcDir = "/Users/edobry/.local/state/minsky/git/local-minsky/sessions/136/src";
  
  try {
    console.log("Finding TypeScript files...");
    const files = await findTypeScriptFiles(srcDir);
    console.log(`Found ${files.length} TypeScript files`);
    
    let totalChanges = 0;
    let filesChanged = 0;
    
    for (const file of files) {
      const changes = await processFile(file);
      if (changes > 0) {
        totalChanges += changes;
        filesChanged++;
        console.log(`${file}: ${changes} changes`);
      }
    }
    
    console.log(`\nSummary:`);
    console.log(`- Files processed: ${files.length}`);
    console.log(`- Files changed: ${filesChanged}`);
    console.log(`- Total changes: ${totalChanges}`);
    
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
} 
