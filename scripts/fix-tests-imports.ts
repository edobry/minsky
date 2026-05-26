#!/usr/bin/env bun
/**
 * Fix tests/ directory imports that still point to src/domain/...
 * after the domain package extraction in mt#2108.
 *
 * Pattern: any relative import containing "src/domain/" becomes @minsky/domain/subpath
 * Also handles .js extension stripping for domain imports.
 */
import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";

const SESSION_ROOT =
  "/Users/edobry/.local/state/minsky/sessions/6433342f-5995-4e00-8ee7-74c0ea993715";
const TESTS_DIR = join(SESSION_ROOT, "tests");

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

  // Match relative imports containing src/domain/
  // e.g. "@minsky/domain/session/types" → "@minsky/domain/session/types"
  //      "@minsky/domain/git" → "@minsky/domain/git"
  //      "@minsky/domain/configuration/index" → "@minsky/domain/configuration/index"
  newContent = newContent.replace(
    /(['"])(\.\.\/)+src\/domain\/([^'"]+)\1/g,
    (match, quote, dots, subpath) => {
      // Strip .js extension if present (TypeScript doesn't need it)
      const cleanSubpath = subpath.replace(/\.js$/, "");
      return `${quote}@minsky/domain/${cleanSubpath}${quote}`;
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

const testFiles = getAllTsFiles(TESTS_DIR);
console.log(`Scanning ${testFiles.length} files in tests/ for src/domain/ imports...`);

let totalFixed = 0;
for (const file of testFiles) {
  totalFixed += processFile(file);
}

console.log(`\nFixed ${totalFixed} file(s).`);
