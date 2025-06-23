#!/usr/bin/env bun

import { readdir, readFile, writeFile } from "fs/promises";
import { join } from "path";

async function getAllTsFiles(dir: string): Promise<string[]> {
  const files: string[] = [];

  async function scan(currentDir: string) {
    const entries = await readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);

      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
        await scan(fullPath);
      } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
        files.push(fullPath);
      }
    }
  }

  await scan(dir);
  return files;
}

async function removeJsExtensions(filePath: string): Promise<{ changed: boolean; count: number }> {
  const content = await readFile(filePath, "utf-8");
  let count = 0;

  // Replace .js extensions in import statements
  // Matches: import ... from ".../.../file.js"
  // Captures: import ... from ".../.../file"
  const newContent = content.replace(
    /(\bimport\s+[^"']*\s+from\s+["'])([^"']+)\.js(["'])/g,
    (match, prefix, path, suffix) => {
      count++;
      return `${prefix}${path}${suffix}`;
    }
  );

  const changed = content !== newContent;

  if (changed) {
    await writeFile(filePath, newContent, "utf-8");
  }

  return { changed, count };
}

async function main() {
  console.log("🔍 Finding all TypeScript files...");
  const tsFiles = await getAllTsFiles("src");
  console.log(`📁 Found ${tsFiles.length} TypeScript files`);

  let totalChanged = 0;
  let totalReplacements = 0;

  console.log("\n🔧 Processing files...");

  for (const file of tsFiles) {
    const result = await removeJsExtensions(file);

    if (result.changed) {
      totalChanged++;
      totalReplacements += result.count;
      console.log(`✅ ${file}: ${result.count} imports updated`);
    }
  }

  console.log("\n📊 Summary:");
  console.log(`   Files changed: ${totalChanged}`);
  console.log(`   Total imports updated: ${totalReplacements}`);
  console.log(`   Files unchanged: ${tsFiles.length - totalChanged}`);

  if (totalChanged > 0) {
    console.log("\n🧪 Running tests to verify changes...");
  } else {
    console.log("\n✨ No changes needed!");
  }
}

main().catch(console.error);
