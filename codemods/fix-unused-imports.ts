#!/usr/bin/env bun
/**
 * Simple script to remove specific unused imports from session.test.ts
 * This serves as a proof of concept for automated unused import removal
 */

import { readFileSync, writeFileSync } from "fs";

const filePath = "src/adapters/__tests__/integration/session.test.ts";

// Read the current file
const content = readFileSync(filePath, "utf-8");
const lines = content.split("\n");

// Remove unused imports by filtering out specific lines
const modifiedLines = lines.filter((line, index) => {
  // Skip the unused import lines we identified
  if (index >= 1 && index <= 8) {
    // Keep only the bun:test import from the import block
    if (line.includes("getSessionFromParams") || 
        line.includes("listSessionsFromParams") ||
        line.includes("startSessionFromParams") ||
        line.includes("deleteSessionFromParams") ||
        line.includes("SessionDB") ||
        line.includes("type Session") ||
        line.includes("createSessionDeps")) {
      return false; // Remove this line
    }
  }
  
  // Remove specific unused import lines
  if (line.includes("GitService") && line.includes("import")) {
    return false;
  }
  if (line.includes("TaskService") && line.includes("import")) {
    return false;
  }
  if (line.includes("WorkspaceUtils") && line.includes("import")) {
    return false;
  }
  if (line.includes("createMockObject") && !line.includes("createMock,")) {
    // Remove createMockObject but keep createMock and setupTestMocks
    return line.replace(/,\s*createMockObject/, "").trim() !== "";
  }
  
  return true; // Keep this line
});

// Clean up the remaining import lines
const finalLines = modifiedLines.map(line => {
  // Clean up any trailing commas in import statements
  if (line.includes("} from") && line.includes(",,")) {
    return line.replace(/,,+/g, ",");
  }
  if (line.includes("} from") && line.endsWith(",")) {
    return line.slice(0, -1);
  }
  return line;
});

// Write the modified content back
const modifiedContent = finalLines.join("\n");
writeFileSync(filePath, modifiedContent);

console.log("✅ Removed unused imports from session.test.ts");

// Show what was removed
console.log("🗑️  Removed unused imports:");
console.log("  - getSessionFromParams");
console.log("  - listSessionsFromParams"); 
console.log("  - startSessionFromParams");
console.log("  - deleteSessionFromParams");
console.log("  - SessionDB");
console.log("  - type Session");
console.log("  - createSessionDeps");
console.log("  - GitService");
console.log("  - TaskService");
console.log("  - WorkspaceUtils");
console.log("  - createMockObject"); 
