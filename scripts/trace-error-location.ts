#!/usr/bin/env bun

import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

// Add debug logging to all catch blocks to trace the error
function addDebugLogging(filePath: string): boolean {
  const content = readFileSync(filePath, "utf8") as string;
  const lines = (content).toString().split("\n");
  let modified = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Look for catch blocks
    if (line.includes("} catch (") && !line.includes("console.log")) {
      // Add debug logging right after the catch line
      const indent = line.match(/^(\s*)/)?.[1] || "  ";
      const debugLine = `${indent}  console.log('[DEBUG] Caught error in ${filePath}:${i + 1}:', typeof error !== 'undefined' ? 'error defined' : 'error undefined', typeof _error !== 'undefined' ? '_error defined' : '_error undefined');`;
      lines.splice(i + 1, 0, debugLine);
      modified = true;
      i++; // Skip the line we just added
    }
  }

  if (modified) {
    writeFileSync(filePath, lines.join("\n"));
    return true;
  }
  return false;
}

function findTsFiles(dir: string): string[] {
  const files: string[] = [];

  function traverse(currentDir: string) {
    const entries = readdirSync(currentDir);

    for (const entry of entries) {
      const fullPath = join(currentDir, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory() && !entry.startsWith(".") && entry !== "node_modules") {
        traverse(fullPath);
      } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
        files.push(fullPath);
      }
    }
  }

  traverse(dir);
  return files;
}

function main() {
  console.log("🔍 Adding debug logging to trace _error location...\n");

  // Focus on key directories that are likely to be called during tasks list
  const keyDirs = [
    "src/domain/tasks",
    "src/adapters/shared/commands",
    "src/adapters/cli",
    "src/mcp",
  ];

  let totalModified = 0;

  for (const dir of keyDirs) {
    console.log(`Processing ${dir}...`);
    const files = findTsFiles(dir);

    for (const file of files) {
      if (addDebugLogging(file)) {
        console.log(`  ✅ Added debug logging to ${file}`);
        totalModified++;
      }
    }
  }

  console.log(`\n📊 Added debug logging to ${totalModified} files`);
  console.log("\n🧪 Now run: minsky tasks list");
  console.log("Look for the last debug message before the error to find the exact location");
}

main();
