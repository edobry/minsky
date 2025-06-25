#!/usr/bin/env bun

import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

function removeDebugLogging(filePath: string): boolean {
  const content = readFileSync(filePath, "utf8") as string;
  const lines = content.split("\n");
  let modified = false;

  const filteredLines = lines.filter((line) => {
    // Remove lines that contain debug logging
    if (
      line.includes("[DEBUG] Caught error in") ||
      line.includes("[DEBUG-OPTIONS]") ||
      (line.includes("console.log") &&
        line.includes("typeof error") &&
        line.includes("typeof _error"))
    ) {
      modified = true;
      return false;
    }
    return true;
  });

  if (modified) {
    writeFileSync(filePath, filteredLines.join("\n"));
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
  console.log("🧹 Removing debug logging statements...\n");

  const files = findTsFiles("src");
  let totalModified = 0;

  for (const file of files) {
    if (removeDebugLogging(file)) {
      console.log(`  ✅ Cleaned ${file}`);
      totalModified++;
    }
  }

  console.log(`\n📊 Cleaned debug logging from ${totalModified} files`);
}

main();
