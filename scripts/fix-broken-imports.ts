#!/usr/bin/env bun
/**
 * Fix remaining broken imports after the domain package move.
 *
 * Approach: for each relative import in packages/domain/src/, check if the
 * resolved path exists on the filesystem. If it doesn't exist, figure out
 * where it was intended to go (old src/ location) and rewrite it.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { join, dirname, relative, resolve } from "path";

const SESSION_ROOT =
  "/Users/edobry/.local/state/minsky/sessions/6433342f-5995-4e00-8ee7-74c0ea993715";
const SRC_DIR = join(SESSION_ROOT, "src");
const DOMAIN_PKG_SRC = join(SESSION_ROOT, "packages/domain/src");
const _SHARED_PKG_SRC = join(SESSION_ROOT, "packages/shared/src");

// Mapping from "old src/ path relative to SRC_DIR" → package import
const SRC_TO_PACKAGE: Array<[string, string]> = [
  // @minsky/shared utilities (these files now have re-export stubs in src/)
  ["utils/logger", "@minsky/shared/logger"],
  ["utils/exec", "@minsky/shared/exec"],
  ["utils/paths", "@minsky/shared/paths"],
  ["utils/process", "@minsky/shared/process"],
  ["utils/fs", "@minsky/shared/fs"],
  ["utils/constants", "@minsky/shared/constants"],
  ["utils/array-safety", "@minsky/shared/array-safety"],
  ["utils/safe-truncate", "@minsky/shared/safe-truncate"],
];

function getAllTsFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "build")
          continue;
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

/** Check if a module path resolves to an existing file (with .ts/.tsx extensions tried) */
function moduleExists(resolvedPath: string): boolean {
  // Try exact path
  if (existsSync(resolvedPath)) return true;
  // Try with .ts
  if (existsSync(`${resolvedPath}.ts`)) return true;
  // Try with .tsx
  if (existsSync(`${resolvedPath}.tsx`)) return true;
  // Try as index.ts
  if (existsSync(`${resolvedPath}/index.ts`)) return true;
  return false;
}

/**
 * Given a broken relative import (one that doesn't resolve to an existing file),
 * figure out what it should be rewritten to.
 */
function computeFixedImport(filePath: string, importPath: string, resolved: string): string | null {
  const fileDir = dirname(filePath);
  const fileRelToDomainSrc = relative(DOMAIN_PKG_SRC, filePath);
  const _depth = fileRelToDomainSrc.split("/").length - 1;

  const parts = importPath.split("/");
  let dotDotCount = 0;
  for (const p of parts) {
    if (p === "..") dotDotCount++;
    else break;
  }
  const _afterDotDot = parts.slice(dotDotCount).join("/");

  // The "intended" old src/ path is determined by how many levels up the import goes
  // beyond the depth of the file within domain/src.
  // If file is at depth=2 (e.g. packages/domain/src/errors/x.ts, afterDotDot = 2)
  // and import has dotDotCount=1 and afterDotDot="utils/constants",
  // it was intended to navigate from src/errors/ to src/utils/constants
  // (i.e. the file was moved but its OLD location was src/errors/x.ts)

  // Find the old location of the file: the file was moved from src/X to packages/domain/src/X
  // So the OLD file dir was: join(SRC_DIR, fileRelToDomainSrc, '..') = join(SRC_DIR, dirname(fileRelToDomainSrc))
  const fileRelToSrcEquivalent = fileRelToDomainSrc; // same relative path
  const oldFileDir = join(SRC_DIR, dirname(fileRelToSrcEquivalent));

  // Resolve the import from the old location
  const resolvedFromOldLocation = resolve(oldFileDir, importPath);
  const oldRelToSrc = relative(SRC_DIR, resolvedFromOldLocation);

  // Check if that old path now lives in the domain package
  const nowInDomainPkg = join(DOMAIN_PKG_SRC, oldRelToSrc);
  if (moduleExists(nowInDomainPkg)) {
    // Rewrite to a relative path within the domain package
    const newRelPath = relative(fileDir, nowInDomainPkg).replace(/\\/g, "/");
    return newRelPath.startsWith(".") ? newRelPath : `./${newRelPath}`;
  }

  // Check if it maps to a @minsky/shared package
  for (const [srcFrag, pkg] of SRC_TO_PACKAGE) {
    if (oldRelToSrc === srcFrag || oldRelToSrc.startsWith(`${srcFrag}/`)) {
      const suffix = oldRelToSrc.slice(srcFrag.length);
      return pkg + suffix;
    }
  }

  // Check if it maps to the old src/ (still there, need long relative path)
  const stillInSrc = join(SRC_DIR, oldRelToSrc);
  if (moduleExists(stillInSrc)) {
    const newRelPath = relative(fileDir, stillInSrc).replace(/\\/g, "/");
    return newRelPath.startsWith(".") ? newRelPath : `./${newRelPath}`;
  }

  return null;
}

function processFile(filePath: string): number {
  const content = readFileSync(filePath, "utf-8");
  let newContent = content;
  let count = 0;

  const replacements: Map<string, string> = new Map();

  // Match all relative import strings
  const importRegex = /(['"])(\.\.?\/[^'"]+)\1/g;
  let match: RegExpExecArray | null;

  while ((match = importRegex.exec(content)) !== null) {
    const importPath = match[2] ?? "";
    if (replacements.has(importPath)) continue;

    const fileDir = dirname(filePath);
    const resolved = resolve(fileDir, importPath);

    // Only process imports that DON'T resolve to an existing file
    if (moduleExists(resolved)) continue;

    const fixed = computeFixedImport(filePath, importPath, resolved);
    if (fixed && fixed !== importPath) {
      replacements.set(importPath, fixed);
    } else if (!fixed) {
      const relPath = filePath.replace(`${SESSION_ROOT}/`, "");
      console.warn(`[warn] Cannot fix: ${relPath}: "${importPath}" → ${resolved} (no match found)`);
    }
  }

  if (replacements.size === 0) return 0;

  for (const [from, to] of replacements) {
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`(["'])(${escaped})\\1`, "g");
    const before = newContent;
    newContent = newContent.replace(regex, `$1${to}$1`);
    if (newContent !== before) count++;
  }

  if (newContent !== content) {
    writeFileSync(filePath, newContent, "utf-8");
    const relPath = filePath.replace(`${SESSION_ROOT}/`, "");
    console.log(`[fix] ${relPath}: ${replacements.size} path(s)`);
    for (const [from, to] of replacements) {
      console.log(`  "${from}" → "${to}"`);
    }
  }

  return count;
}

// Process only domain package files (where broken imports live)
const domainFiles = getAllTsFiles(DOMAIN_PKG_SRC);
console.log(`Scanning ${domainFiles.length} files in packages/domain/src/ for broken imports...`);

let totalFixed = 0;
let totalFiles = 0;

for (const file of domainFiles) {
  const count = processFile(file);
  if (count > 0) {
    totalFixed += count;
    totalFiles++;
  }
}

console.log(`\nFixed ${totalFixed} broken import(s) across ${totalFiles} files.`);
