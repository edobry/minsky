#!/usr/bin/env bun

/**
 * Targeted parser error fixes based on linting output
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const changes: Array<{ file: string; description: string }> = [];

function fixFile(filePath: string): void {
  try {
    const content = readFileSync(filePath, "utf8") as string;
    let updatedContent: string = content;
    let hasChanges = false;

    // Fix specific parsing errors by file
    const fileName = filePath.split("/").pop() || "";

    switch (fileName) {
      case "config-loader.ts":
        // Fix missing import issue at line 22
        if (
          updatedContent.includes('from "./types";') &&
          !updatedContent.includes("import type {")
        ) {
          updatedContent = updatedContent.replace(
            "import {\n  ConfigurationLoadResult,",
            "import type {\n  ConfigurationLoadResult,"
          );
          hasChanges = true;
          changes.push({ file: filePath, description: "Add missing 'type' keyword to import" });
        }
        break;

      case "session.ts":
        // Fix comma issue at line 193
        if (updatedContent.includes('path: ["body"],')) {
          updatedContent = updatedContent.replace('path: ["body"],', 'path: ["body"]');
          hasChanges = true;
          changes.push({ file: filePath, description: "Remove trailing comma in refine options" });
        }
        break;

      case "process.ts":
        // Fix function signature issue at line 33
        if (updatedContent.includes("return () => {")) {
          updatedContent = updatedContent.replace(
            /return \(\) => \{\s*currentWorkingDirectoryImpl = originalImpl;\s*\};/,
            "return () => {\n    currentWorkingDirectoryImpl = originalImpl;\n  };"
          );
          hasChanges = true;
          changes.push({ file: filePath, description: "Fix indentation in return statement" });
        }
        break;

      case "repository-utils.ts":
        // Fix function signature issue at line 53
        if (
          updatedContent.includes(
            "async get<T>(key: string, fetcher: () => Promise<T>, ttl = this.DEFAULT_TTL): Promise<T> {"
          )
        ) {
          updatedContent = updatedContent.replace(
            "async get<T>(key: string, fetcher: () => Promise<T>, ttl = this.DEFAULT_TTL): Promise<T> {",
            "async get<T>(key: string, fetcher: () => Promise<T>, ttl: number = this.DEFAULT_TTL): Promise<T> {"
          );
          hasChanges = true;
          changes.push({
            file: filePath,
            description: "Add explicit type annotation to ttl parameter",
          });
        }
        break;

      case "assertions.ts":
        // Fix invalid character issue at line 8
        if (updatedContent.includes('import { expect } from "bun:test";')) {
          // Check for hidden characters and fix them
          const lines = updatedContent.split("\n");
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line !== undefined) {
              // Remove any zero-width or problematic characters
              const cleanLine = line.replace(/[\u200B-\u200D\uFEFF]/g, "");
              if (cleanLine !== line) {
                lines[i] = cleanLine;
                hasChanges = true;
              }
            }
          }
          if (hasChanges) {
            updatedContent = lines.join("\n");
            changes.push({ file: filePath, description: "Remove invisible characters" });
          }
        }
        break;

      case "factories.ts":
        // Fix numeric literal issue at line 187
        if (updatedContent.includes('case "count":') || updatedContent.includes('case"count":')) {
          updatedContent = updatedContent.replace(
            /case\s*"count":\s*case\s*"age":\s*case\s*"quantity":/g,
            'case "count":\n  case "age":\n  case "quantity":'
          );
          hasChanges = true;
          changes.push({ file: filePath, description: "Fix case statement formatting" });
        }
        break;

      case "mocking.ts":
        // Fix semicolon issue at line 28
        if (
          updatedContent.includes(
            "mockReturnValue: (value: TReturn) => MockFunction<TReturn, TArgs>"
          )
        ) {
          updatedContent = updatedContent.replace(
            "mockReturnValue: (value: TReturn) => MockFunction<TReturn, TArgs>",
            "mockReturnValue: (value: TReturn) => MockFunction<TReturn, TArgs>;"
          );
          hasChanges = true;
          changes.push({
            file: filePath,
            description: "Add missing semicolon to interface method",
          });
        }
        break;
    }

    // General fixes for common parsing issues
    // Fix malformed arrow functions
    updatedContent = updatedContent.replace(/=>\s*\{\s*\}/g, "=> {}");

    // Fix double semicolons
    updatedContent = updatedContent.replace(/;;/g, ";");

    // Fix spacing around colons in type annotations
    updatedContent = updatedContent.replace(/:\s*Promise<([^>]+)>\s*\{/g, ": Promise<$1> {");

    if (hasChanges || updatedContent !== content) {
      writeFileSync(filePath, updatedContent);
      if (!hasChanges) {
        changes.push({ file: filePath, description: "Apply general parsing fixes" });
      }
    }
  } catch (error) {
    console.error(`Error processing ${filePath}:`, error);
  }
}

function processDirectory(dirPath: string): void {
  try {
    const entries = readdirSync(dirPath);

    for (const entry of entries) {
      const fullPath = join(dirPath, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory() && !entry.startsWith(".") && entry !== "node_modules") {
        processDirectory(fullPath);
      } else if (stat.isFile() && entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
        fixFile(fullPath);
      }
    }
  } catch (error) {
    console.error(`Error processing directory ${dirPath}:`, error);
  }
}

console.log("🔧 Fixing targeted parsing errors...");

// Process the src directory
processDirectory("src");

console.log(`\n📊 Summary: Applied ${changes.length} fixes`);

if (changes.length > 0) {
  console.log("\n✅ Applied fixes:");
  for (const change of changes) {
    console.log(`  - ${change.file}: ${change.description}`);
  }
}
