#!/usr/bin/env bun
/**
 * Fix remaining broken imports after domain extraction (mt#2108).
 *
 * Fixes:
 * 1. src/domain/X → @minsky/domain/X  (in scripts/, tests/ directories)
 * 2. src/utils/rules-helpers → @minsky/domain/utils/rules-helpers
 * 3. src/composition/X → @minsky/domain/composition/X
 * 4. .js extension stripping for domain imports
 * 5. .ts extension stripping for domain imports
 */
import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";

const SESSION_ROOT =
  "/Users/edobry/.local/state/minsky/sessions/6433342f-5995-4e00-8ee7-74c0ea993715";

// Directories to scan (besides src/ which was already handled)
const SCAN_DIRS = [join(SESSION_ROOT, "scripts"), join(SESSION_ROOT, "tests")];

function getAllTsFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        files.push(...getAllTsFiles(fullPath));
      } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
        files.push(fullPath);
      }
    }
  } catch {
    /* ignore unreadable dirs */
  }
  return files;
}

function processFile(filePath: string): number {
  const content = readFileSync(filePath, "utf-8");
  let newContent = content;

  // Fix 1: relative imports containing src/domain/ → @minsky/domain/
  // e.g. "@minsky/domain/session/types" → "@minsky/domain/session/types"
  //      "@minsky/domain/memory" → "@minsky/domain/memory"
  //      "(\"@minsky/domain/configuration/index.js\")" → "@minsky/domain/configuration/index"
  newContent = newContent.replace(
    /(['"])(\.\.\/)+src\/domain\/([^'"]+)\1/g,
    (match, quote, dots, subpath) => {
      // Strip .js or .ts extension if present
      const cleanSubpath = subpath.replace(/\.(js|ts)$/, "");
      return `${quote}@minsky/domain/${cleanSubpath}${quote}`;
    }
  );

  // Fix 2: inline type imports with relative src/domain path (no leading quote)
  // e.g. import("@minsky/domain/composition/types").AppContainerInterface
  newContent = newContent.replace(
    /import\((["'])(\.\.\/)+src\/composition\/([^'"]+)\1\)/g,
    (match, quote, dots, subpath) => {
      return `import(${quote}@minsky/domain/composition/${subpath}${quote})`;
    }
  );

  // Fix 3: relative imports to src/composition/ → @minsky/domain/composition/
  newContent = newContent.replace(
    /(['"])(\.\.\/)+src\/composition\/([^'"]+)\1/g,
    (match, quote, dots, subpath) => {
      return `${quote}@minsky/domain/composition/${subpath}${quote}`;
    }
  );

  // Fix 4: relative imports to src/utils/rules-helpers → @minsky/domain/utils/rules-helpers
  newContent = newContent.replace(
    /(['"])(\.\.\/)+src\/utils\/rules-helpers([^'"]*)\1/g,
    (match, quote, dots, suffix) => {
      return `${quote}@minsky/domain/utils/rules-helpers${suffix}${quote}`;
    }
  );

  if (newContent !== content) {
    writeFileSync(filePath, newContent, "utf-8");
    const relPath = filePath.replace(`${SESSION_ROOT}/`, "");
    console.log(`[fix] ${relPath}`);
    return 1;
  }
  return 0;
}

let totalFiles = 0;
let totalFixed = 0;

for (const dir of SCAN_DIRS) {
  const files = getAllTsFiles(dir);
  totalFiles += files.length;
  for (const file of files) {
    totalFixed += processFile(file);
  }
}

console.log(`\nScanned ${totalFiles} files. Fixed ${totalFixed} file(s).`);
