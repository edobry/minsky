#!/usr/bin/env bun
/**
 * Import rewrite script for mt#2108 domain extraction.
 *
 * After moving:
 *   src/domain/      → packages/domain/src/
 *   src/errors/      → packages/domain/src/errors/
 *   src/schemas/     → packages/domain/src/schemas/
 *   src/config-setup.ts → packages/domain/src/config-setup.ts
 *   src/composition/{domain,container,types,test}.ts → packages/domain/src/composition/
 *   src/utils/{git-exec,parse-diff,rules-helpers,package-manager}.ts → packages/domain/src/utils/
 *
 * Two rewrite passes:
 *
 * Pass A — files in src/ that had relative imports into the now-moved locations.
 *   Their relative paths now point to non-existent locations and need to become
 *   @minsky/domain/... imports.
 *
 * Pass B — files in packages/domain/src/ that have relative imports escaping
 *   the domain package boundary (../../utils/logger etc.). These need to become
 *   either @minsky/shared/... or @minsky/domain/... imports depending on where
 *   the target now lives.
 */

import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join, dirname, relative, resolve } from "path";

const SESSION_ROOT =
  "/Users/edobry/.local/state/minsky/sessions/6433342f-5995-4e00-8ee7-74c0ea993715";
const SRC_DIR = join(SESSION_ROOT, "src");
const DOMAIN_PKG_SRC = join(SESSION_ROOT, "packages/domain/src");
const _SHARED_PKG_SRC = join(SESSION_ROOT, "packages/shared/src");

// ─── old src locations that are now in packages/domain/src ───────────────────
// These are the directories/files that were MOVED OUT of src/
const _MOVED_TO_DOMAIN: Array<[string, string]> = [
  // [old src/ path fragment (rel to SRC_DIR), sub-path in packages/domain/src/]
  ["domain", ""], // src/domain/X → packages/domain/src/X
  ["errors", "errors"], // src/errors/X → packages/domain/src/errors/X
  ["schemas", "schemas"], // src/schemas/X → packages/domain/src/schemas/X
  ["config-setup", "config-setup"], // src/config-setup.ts → packages/domain/src/config-setup.ts
  // composition files: src/composition/{domain,container,types,test}.ts
  // → packages/domain/src/composition/{...}.ts
];

// Composition files moved individually (not whole directory)
const MOVED_COMPOSITION_FILES = ["domain", "container", "types", "test"];

// Utils moved to packages/domain/src/utils/
const MOVED_DOMAIN_UTILS = ["git-exec", "parse-diff", "rules-helpers", "package-manager"];

// ─── utils now in @minsky/shared ────────────────────────────────────────────
const SHARED_UTILS: Array<[string, string]> = [
  ["logger", "@minsky/shared/logger"],
  ["exec", "@minsky/shared/exec"],
  ["paths", "@minsky/shared/paths"],
  ["process", "@minsky/shared/process"],
  ["fs", "@minsky/shared/fs"],
  ["constants", "@minsky/shared/constants"],
  ["array-safety", "@minsky/shared/array-safety"],
  ["safe-truncate", "@minsky/shared/safe-truncate"],
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

// ─── Pass A: rewrite imports in src/ files ───────────────────────────────────

/**
 * Compute the target @minsky/domain/... path for an old src/ import path.
 * importPath is a relative import string from a file in src/.
 * resolved is the absolute path that importPath resolves to.
 *
 * Returns new import string, or null if no rewrite needed.
 */
function rewriteSrcImport(_filePath: string, importPath: string, resolved: string): string | null {
  // Was it pointing into src/domain/?
  const relToSrc = relative(SRC_DIR, resolved);

  // src/domain/X → @minsky/domain/X
  if (relToSrc.startsWith("domain/") || relToSrc === "domain") {
    const rest = relToSrc.startsWith("domain/") ? relToSrc.slice("domain/".length) : "";
    return rest ? `@minsky/domain/${rest}` : "@minsky/domain";
  }

  // src/errors/X → @minsky/domain/errors/X
  if (relToSrc.startsWith("errors/") || relToSrc === "errors") {
    const rest = relToSrc.startsWith("errors/") ? relToSrc.slice("errors/".length) : "";
    return rest ? `@minsky/domain/errors/${rest}` : "@minsky/domain/errors";
  }

  // src/schemas/X → @minsky/domain/schemas/X
  if (relToSrc.startsWith("schemas/") || relToSrc === "schemas") {
    const rest = relToSrc.startsWith("schemas/") ? relToSrc.slice("schemas/".length) : "";
    return rest ? `@minsky/domain/schemas/${rest}` : "@minsky/domain/schemas";
  }

  // src/config-setup → @minsky/domain/config-setup
  if (relToSrc === "config-setup") {
    return "@minsky/domain/config-setup";
  }

  // src/composition/{domain,container,types,test} → @minsky/domain/composition/X
  if (relToSrc.startsWith("composition/")) {
    const rest = relToSrc.slice("composition/".length);
    const base = rest.split("/")[0] ?? "";
    if (MOVED_COMPOSITION_FILES.includes(base)) {
      return `@minsky/domain/composition/${rest}`;
    }
  }

  // src/utils/git-exec etc. → @minsky/domain/utils/X
  if (relToSrc.startsWith("utils/")) {
    const rest = relToSrc.slice("utils/".length);
    const base = rest.split("/")[0] ?? "";
    if (MOVED_DOMAIN_UTILS.includes(base)) {
      return `@minsky/domain/utils/${rest}`;
    }
    // @minsky/shared utils
    for (const [name, pkg] of SHARED_UTILS) {
      if (base === name) {
        const suffix = rest.slice(name.length);
        return pkg + suffix;
      }
    }
  }

  return null;
}

// ─── Pass B: rewrite imports in packages/domain/src/ files ──────────────────

/**
 * For a file in packages/domain/src/, compute what a broken relative import should become.
 *
 * The import resolves to `resolved` which is OUTSIDE packages/domain/src/.
 * We need to map it to a package import.
 */
function rewriteDomainPkgImport(
  filePath: string,
  importPath: string,
  resolved: string
): string | null {
  // Still inside domain package? No rewrite needed.
  if (resolved.startsWith(`${DOMAIN_PKG_SRC}/`) || resolved === DOMAIN_PKG_SRC) return null;

  // Map relative imports that used to point to src/ locations

  // The OLD relative paths from domain files were computed from src/domain/
  // Now that the file is in packages/domain/src/, the same relative path
  // resolves to the WRONG place. We need to figure out what was intended.
  //
  // Strategy: look at the IMPORT STRUCTURE, not the resolved path.
  // An import like "../../utils/logger" from packages/domain/src/git/git-service.ts
  // resolves to packages/domain/utils/logger (wrong).
  // Originally from src/domain/git/git-service.ts it would resolve to src/utils/logger.
  //
  // We detect the pattern by analyzing the import path segments.

  const fileRelToDomainSrc = relative(DOMAIN_PKG_SRC, filePath);
  const depth = fileRelToDomainSrc.split("/").length - 1; // depth below packages/domain/src/

  // Count ".." in import path
  const parts = importPath.split("/");
  let dotDotCount = 0;
  for (const p of parts) {
    if (p === "..") dotDotCount++;
    else break;
  }

  // If dotDotCount > depth, the import was meant to escape src/ (now domain pkg src/)
  // and reach sibling directories under the old src/ root.
  if (dotDotCount <= depth) return null; // relative import within domain package — leave alone

  // The import escapes the domain package. What was it pointing to originally?
  // From src/domain/X (depth d), ../../utils/logger means go up d+1 to src/, then into utils/logger
  // From packages/domain/src/X (depth d), same ../../utils/logger goes up d+1 to packages/domain/, then utils/logger
  //
  // We need to figure out the INTENDED target in old src/ terms.
  // The path after the ".." traversal gives us the sub-path.

  const afterDotDot = parts.slice(dotDotCount).join("/");

  // afterDotDot is the path relative to "old src/" that was intended.
  // E.g. "utils/logger" → src/utils/logger → now @minsky/shared/logger
  // E.g. "errors/index" → src/errors/index → now @minsky/domain/errors/index
  // E.g. "schemas/tasks" → src/schemas/tasks → now @minsky/domain/schemas/tasks
  // E.g. "adapters/..." → src/adapters/... → still in src/, need new relative path
  // E.g. "mcp/..." → src/mcp/... → still in src/, need new relative path
  // E.g. "composition/types" → src/composition/types → now @minsky/domain/composition/types

  // Utils now in @minsky/shared
  if (afterDotDot.startsWith("utils/") || afterDotDot === "utils") {
    const rest = afterDotDot.startsWith("utils/") ? afterDotDot.slice("utils/".length) : "";
    const base = rest.split("/")[0] ?? "";
    for (const [name, pkg] of SHARED_UTILS) {
      if (base === name) {
        const suffix = rest.slice(name.length);
        return pkg + suffix;
      }
    }
    // Domain-specific utils now in @minsky/domain/utils/
    if (MOVED_DOMAIN_UTILS.includes(base)) {
      // Compute relative from current file to packages/domain/src/utils/
      const targetPath = join(DOMAIN_PKG_SRC, "utils", rest);
      const fromDir = dirname(filePath);
      const rel = relative(fromDir, targetPath).replace(/\\/g, "/");
      return rel.startsWith(".") ? rel : `./${rel}`;
    }
    // Other utils still in src/ — need relative path from domain package back to src/
    // packages/domain/src/ → packages/domain/ → packages/ → session_root/ → src/
    const targetInSrc = join(SRC_DIR, afterDotDot);
    const fromDir = dirname(filePath);
    const rel = relative(fromDir, targetInSrc).replace(/\\/g, "/");
    return rel.startsWith(".") ? rel : `./${rel}`;
  }

  // Errors now in @minsky/domain/errors/
  if (afterDotDot.startsWith("errors/") || afterDotDot === "errors") {
    const rest = afterDotDot.startsWith("errors/") ? afterDotDot.slice("errors/".length) : "";
    const targetPath = join(DOMAIN_PKG_SRC, "errors", rest);
    const fromDir = dirname(filePath);
    const rel = relative(fromDir, targetPath).replace(/\\/g, "/");
    return rel.startsWith(".") ? rel : `./${rel}`;
  }

  // Schemas now in @minsky/domain/schemas/
  if (afterDotDot.startsWith("schemas/") || afterDotDot === "schemas") {
    const rest = afterDotDot.startsWith("schemas/") ? afterDotDot.slice("schemas/".length) : "";
    const targetPath = join(DOMAIN_PKG_SRC, "schemas", rest);
    const fromDir = dirname(filePath);
    const rel = relative(fromDir, targetPath).replace(/\\/g, "/");
    return rel.startsWith(".") ? rel : `./${rel}`;
  }

  // config-setup now in @minsky/domain/config-setup
  if (afterDotDot === "config-setup") {
    const targetPath = join(DOMAIN_PKG_SRC, "config-setup.ts");
    const fromDir = dirname(filePath);
    const rel = relative(fromDir, targetPath.replace(/\.ts$/, "")).replace(/\\/g, "/");
    return rel.startsWith(".") ? rel : `./${rel}`;
  }

  // Composition files moved to @minsky/domain/composition/
  if (afterDotDot.startsWith("composition/")) {
    const rest = afterDotDot.slice("composition/".length);
    const base = rest.split("/")[0] ?? "";
    if (MOVED_COMPOSITION_FILES.includes(base)) {
      const targetPath = join(DOMAIN_PKG_SRC, "composition", rest);
      const fromDir = dirname(filePath);
      const rel = relative(fromDir, targetPath).replace(/\\/g, "/");
      return rel.startsWith(".") ? rel : `./${rel}`;
    }
  }

  // Domain sub-paths (e.g. ../../../domain/session/types)
  if (afterDotDot.startsWith("domain/") || afterDotDot === "domain") {
    const rest = afterDotDot.startsWith("domain/") ? afterDotDot.slice("domain/".length) : "";
    const targetPath = join(DOMAIN_PKG_SRC, rest);
    const fromDir = dirname(filePath);
    const rel = relative(fromDir, targetPath).replace(/\\/g, "/");
    return rel.startsWith(".") ? rel : `./${rel}`;
  }

  // Anything still in src/ (adapters, mcp, etc.) — compute new relative path
  if (
    afterDotDot.startsWith("adapters/") ||
    afterDotDot.startsWith("mcp/") ||
    afterDotDot.startsWith("cli/") ||
    afterDotDot.startsWith("commands/") ||
    afterDotDot.startsWith("cockpit/") ||
    afterDotDot.startsWith("types/") ||
    afterDotDot.startsWith("hooks/") ||
    afterDotDot.startsWith("tools/") ||
    afterDotDot.startsWith("routers/") ||
    afterDotDot.startsWith("transports/")
  ) {
    const targetInSrc = join(SRC_DIR, afterDotDot);
    const fromDir = dirname(filePath);
    const rel = relative(fromDir, targetInSrc).replace(/\\/g, "/");
    return rel.startsWith(".") ? rel : `./${rel}`;
  }

  // git/... import (e.g. ../../../git from session/commands)
  if (afterDotDot === "git" || afterDotDot.startsWith("git/")) {
    // src/git/ was NOT moved — still in src/git/
    const targetInSrc = join(SRC_DIR, afterDotDot);
    const fromDir = dirname(filePath);
    const rel = relative(fromDir, targetInSrc).replace(/\\/g, "/");
    return rel.startsWith(".") ? rel : `./${rel}`;
  }

  return null;
}

// ─── Apply rewrites to file content ─────────────────────────────────────────

function processFile(filePath: string): number {
  const content = readFileSync(filePath, "utf-8");
  let newContent = content;
  let count = 0;

  // Match all import/export from "..." patterns
  // Also match dynamic import("...")
  const importRegex = /(['"])(\.\.?\/[^'"]+)\1/g;
  let match: RegExpExecArray | null;

  const replacements: Map<string, string> = new Map();

  while ((match = importRegex.exec(content)) !== null) {
    const _quote = match[1] ?? "";
    const importPath = match[2] ?? "";

    if (replacements.has(importPath)) continue;

    const fileDir = dirname(filePath);
    const resolved = resolve(fileDir, importPath);

    const isInDomainPkg = filePath.startsWith(`${DOMAIN_PKG_SRC}/`) || filePath === DOMAIN_PKG_SRC;
    const isInSrc = filePath.startsWith(`${SRC_DIR}/`) && !isInDomainPkg;

    let newPath: string | null = null;

    if (isInSrc) {
      newPath = rewriteSrcImport(filePath, importPath, resolved);
    } else if (isInDomainPkg) {
      newPath = rewriteDomainPkgImport(filePath, importPath, resolved);
    }

    if (newPath && newPath !== importPath) {
      replacements.set(importPath, newPath);
    }
  }

  if (replacements.size === 0) return 0;

  // Apply replacements — replace exact import strings
  for (const [from, to] of replacements) {
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Match both single and double quoted versions in from/export/dynamic import
    const regex = new RegExp(`(["'])(${escaped})\\1`, "g");
    const before = newContent;
    newContent = newContent.replace(regex, `$1${to}$1`);
    if (newContent !== before) count++;
  }

  if (newContent !== content) {
    writeFileSync(filePath, newContent, "utf-8");
    const relPath = filePath.replace(`${SESSION_ROOT}/`, "");
    console.log(`[rewrite] ${relPath}: ${replacements.size} path(s)`);
    for (const [from, to] of replacements) {
      console.log(`  "${from}" → "${to}"`);
    }
  }

  return count;
}

// ─── Main ────────────────────────────────────────────────────────────────────

const allFiles = [...getAllTsFiles(SRC_DIR), ...getAllTsFiles(DOMAIN_PKG_SRC)];

console.log(`Processing ${allFiles.length} TypeScript files...`);

let totalRewrites = 0;
let totalFiles = 0;

for (const file of allFiles) {
  const count = processFile(file);
  if (count > 0) {
    totalRewrites += count;
    totalFiles++;
  }
}

console.log(`\nDone: rewrote ${totalRewrites} import path(s) across ${totalFiles} files.`);
