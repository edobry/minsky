#!/usr/bin/env bun

/**
 * Fix Import Paths Script
 * 
 * The codemod calculated import paths incorrectly. This script fixes them
 * by calculating the correct relative path from each file to src/errors/index
 */

import { readFileSync, writeFileSync } from "fs";
import { dirname, relative, join } from "path";

// List of files that need fixing (from the grep output)
const filesToFix = [
  "src/utils/package-manager.ts",
  "src/mcp/tools/tasks.ts", 
  "src/mcp/inspector-launcher.ts",
  "src/mcp/server.ts",
  "src/mcp/command-mapper.ts",
  "src/adapters/mcp/session-workspace.ts",
  "src/adapters/mcp/session-edit-tools.ts",
  "src/adapters/mcp/session-files.ts",
  "src/adapters/shared/bridges/mcp-bridge.ts",
  "src/adapters/shared/error-handling.ts",
  "src/adapters/shared/commands/init.ts",
  "src/adapters/shared/commands/sessiondb.ts",
  "src/adapters/shared/commands/session.ts",
  "src/adapters/shared/commands/tasks.ts",
  "src/adapters/shared/command-registry.ts",
  "src/adapters/cli/tasks/specCommand.ts",
  "src/adapters/cli/utils/error-handler.ts",
  "src/adapters/cli/utils/index.ts",
  "src/scripts/task-title-migration.ts",
  "src/domain/tasks/taskCommands.ts",
  "src/domain/tasks/githubIssuesTaskBackend.ts",
  "src/domain/tasks/githubBackendConfig.ts",
  "src/domain/tasks/jsonFileTaskBackend.ts",
  "src/domain/repository.ts",
  "src/domain/workspace.ts",
  "src/domain/workspace/local-workspace-backend.ts",
  "src/domain/uri-utils.ts",
  "src/domain/storage/backends/sqlite-storage.ts",
  "src/domain/storage/backends/json-file-storage.ts",
  "src/domain/storage/json-file-storage.ts",
  "src/domain/storage/monitoring/health-monitor.ts",
  "src/domain/storage/migration/session-migrator.ts",
  "src/domain/storage/migration/migration-service.ts",
  "src/domain/rules.ts",
  "src/domain/session.ts",
  "src/domain/__tests__/session-pr-body-path.test.ts",
  "src/domain/__tests__/session-review.test.ts",
  "src/domain/__tests__/session-update.test.ts",
  "src/domain/__tests__/tasks.test.ts",
  "src/domain/repository-uri.ts",
  "src/domain/tasks.ts",
  "src/domain/git.ts",
  "src/domain/session/session-path-resolver.ts",
  "src/domain/session/session-workspace-service.ts",
  "src/domain/session/session-db-io.ts",
  "src/domain/session/session-db-adapter.ts",
];

function calculateCorrectImportPath(filePath: string): string {
  // Remove the src/ prefix to get the relative path within src
  const relativeFileDir = dirname(filePath.replace(/^src\//, ""));
  
  // Calculate relative path from file directory to errors directory
  const relativePath = relative(relativeFileDir, "errors");
  
  // If we're in the same directory level as errors, use ./errors
  // Otherwise use the calculated relative path
  if (relativePath === "errors") {
    return "./errors/index";
  } else if (relativePath === "") {
    return "./errors/index";
  } else {
    return `${relativePath}/index`;
  }
}

function fixImportInFile(filePath: string): boolean {
  try {
    const content = readFileSync(filePath, "utf-8") as string;
    const correctImportPath = calculateCorrectImportPath(filePath);
    
    // Pattern to match the incorrect import
    const importPattern = /import\s*\{\s*getErrorMessage\s*\}\s*from\s*["'][^"']*errors\/index["']/g;
    
    // Replace with correct import
    const newImport = `import { getErrorMessage } from "${correctImportPath}"`;
    const newContent = content.replace(importPattern, newImport);
    
    if (newContent !== content) {
      writeFileSync(filePath, newContent, "utf-8");
      console.log(`✅ Fixed import in ${filePath} -> ${correctImportPath}`);
      return true;
    } else {
      console.log(`⚠️  No import found to fix in ${filePath}`);
      return false;
    }
  } catch (error) {
    console.error(`❌ Error fixing ${filePath}:`, error);
    return false;
  }
}

function main() {
  console.log("🔧 Fixing incorrect import paths for getErrorMessage...");
  
  let fixedCount = 0;
  
  for (const file of filesToFix) {
    if (fixImportInFile(file)) {
      fixedCount++;
    }
  }
  
  console.log(`\n📊 Summary: Fixed ${fixedCount} out of ${filesToFix.length} files`);
  
  if (fixedCount > 0) {
    console.log("✅ Import paths have been corrected!");
  } else {
    console.log("ℹ️  No files needed fixing");
  }
}

if (import.meta.main) {
  main();
} 
