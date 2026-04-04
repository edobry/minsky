#!/usr/bin/env bun

/**
 * SESSION NAME → SESSION ID RENAME CODEMOD (mt#651)
 *
 * PURPOSE: Rename all "sessionName" references to "sessionId" across the codebase,
 * consolidate SessionNameSchema into SessionIdSchema, and update related function names.
 *
 * APPROACH: Two-phase — AST analysis to find targets, then safe full-text replacement.
 * Uses ts-morph only for analysis (counting, reporting), not for mutation.
 * Actual file edits use word-boundary regex on the raw file text, which avoids
 * the AST tree-corruption issues that `replaceWithText` causes with cascading edits.
 *
 * TRANSFORMATIONS:
 * 1. Identifier renames: sessionName → sessionId (variables, parameters, properties)
 * 2. Schema consolidation: SessionNameSchema → SessionIdSchema (remove alias)
 * 3. Type renames: SessionName → SessionId
 * 4. Function renames: generateSessionName → generateSessionId, etc.
 * 5. String literal updates: "Session name" → "Session ID", "session name" → "session ID"
 *
 * SCOPE: All TypeScript files in src/ and tests/
 */

import { readFileSync, writeFileSync } from "fs";
import { globSync } from "glob";

// ========================
// RENAME MAPPINGS
// ========================

/**
 * Ordered from longest to shortest to prevent partial matches.
 * e.g., "SessionNameSchema" must be replaced before "SessionName"
 */
const IDENTIFIER_RENAMES: Array<{ from: string; to: string }> = [
  // Longest compound names first
  { from: "extractTaskIdFromSessionName", to: "extractTaskIdFromSessionId" },
  { from: "isMultiBackendSessionName", to: "isMultiBackendSessionId" },
  { from: "taskIdToSessionName", to: "taskIdToSessionId" },
  { from: "sessionNameToTaskId", to: "sessionIdToTaskId" },
  { from: "generateSessionName", to: "generateSessionId" },
  { from: "isUuidSessionName", to: "isUuidSessionId" },

  // Suffix patterns — match compound names like actualSessionName, resolveSessionName
  // These use suffix matching (no leading \b) to catch compound camelCase identifiers
  { from: "SessionName", to: "SessionId" },
  { from: "sessionName", to: "sessionId" },
];

/** String literal replacements (applied to quoted string content) */
const STRING_RENAMES: Array<{ from: string; to: string }> = [
  { from: "Session name cannot be empty", to: "Session ID cannot be empty" },
  { from: "Session identifier (name or task ID)", to: "Session identifier (ID or task ID)" },
  { from: "session-name", to: "session-id" },
  { from: "Session Name", to: "Session ID" },
  { from: "Session name", to: "Session ID" },
  { from: "session name", to: "session ID" },
];

// ========================
// IMPLEMENTATION
// ========================

interface FileResult {
  path: string;
  identifierChanges: number;
  stringChanges: number;
}

function applyRenames(filePath: string, dryRun: boolean): FileResult | null {
  const originalContent = readFileSync(filePath, "utf-8");
  let content = originalContent;
  let identifierChanges = 0;
  let stringChanges = 0;

  // Phase 1: Apply identifier renames.
  // Specific function names use word boundaries on both sides.
  // The last two entries (SessionName, sessionName) use suffix matching
  // (trailing \b only) to catch compound names like actualSessionName.
  const suffixPatterns = new Set(["SessionName", "SessionId", "sessionName", "sessionId"]);
  for (const { from, to } of IDENTIFIER_RENAMES) {
    const isSuffix = suffixPatterns.has(from);
    const regex = isSuffix
      ? new RegExp(`${escapeRegex(from)}\\b`, "g")
      : new RegExp(`\\b${escapeRegex(from)}\\b`, "g");
    const matches = content.match(regex);
    if (matches) {
      identifierChanges += matches.length;
      content = content.replace(regex, to);
    }
  }

  // Phase 2: Apply string content renames.
  // These target specific phrases in string literals and comments.
  for (const { from, to } of STRING_RENAMES) {
    // Use plain string replacement (not word-boundary) since these are phrases
    const count = content.split(from).length - 1;
    if (count > 0) {
      stringChanges += count;
      content = content.replaceAll(from, to);
    }
  }

  if (content === originalContent) {
    return null; // No changes needed
  }

  if (!dryRun) {
    writeFileSync(filePath, content, "utf-8");
  }

  return {
    path: filePath,
    identifierChanges,
    stringChanges,
  };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ========================
// MAIN EXECUTION
// ========================

function main(): void {
  const dryRun = process.argv.includes("--dry-run");
  const verbose = process.argv.includes("--verbose");

  console.log("=== SESSION NAME → SESSION ID RENAME CODEMOD (mt#651) ===\n");
  if (dryRun) console.log("*** DRY RUN — no files will be modified ***\n");

  console.log("Identifier renames (order matters — longest first):");
  for (const { from, to } of IDENTIFIER_RENAMES) {
    console.log(`  ${from} → ${to}`);
  }
  console.log("\nString literal renames:");
  for (const { from, to } of STRING_RENAMES) {
    console.log(`  "${from}" → "${to}"`);
  }
  console.log("");

  // Find all TypeScript files
  const files = globSync(["src/**/*.ts", "tests/**/*.ts", "scripts/**/*.ts"], {
    ignore: ["**/*.d.ts", "**/node_modules/**", "codemods/**"],
  });

  console.log(`Found ${files.length} TypeScript files to process\n`);

  const results: FileResult[] = [];
  let totalIdentifier = 0;
  let totalString = 0;
  let filesModified = 0;

  for (const filePath of files) {
    try {
      const result = applyRenames(filePath, dryRun);
      if (result) {
        results.push(result);
        totalIdentifier += result.identifierChanges;
        totalString += result.stringChanges;
        filesModified++;

        if (verbose) {
          console.log(
            `  ${result.path}: ${result.identifierChanges} identifiers, ${result.stringChanges} strings`
          );
        }
      }
    } catch (error) {
      console.error(`Error processing ${filePath}: ${error}`);
    }
  }

  // Summary
  console.log("\n=== SUMMARY ===");
  console.log(`Files scanned:  ${files.length}`);
  console.log(`Files modified: ${filesModified}`);
  console.log(`Identifier renames: ${totalIdentifier}`);
  console.log(`String renames:     ${totalString}`);
  console.log(`Total changes:      ${totalIdentifier + totalString}`);

  if (dryRun) {
    console.log("\n*** DRY RUN — no files were modified. Run without --dry-run to apply. ***");
  } else {
    console.log("\nAll changes applied successfully.");
  }

  // Show top modified files
  if (results.length > 0) {
    console.log("\nTop modified files:");
    results
      .sort(
        (a, b) => b.identifierChanges + b.stringChanges - (a.identifierChanges + a.stringChanges)
      )
      .slice(0, 15)
      .forEach((r) => {
        console.log(`  ${r.identifierChanges + r.stringChanges} changes: ${r.path}`);
      });
  }
}

if (import.meta.main) {
  main();
}
