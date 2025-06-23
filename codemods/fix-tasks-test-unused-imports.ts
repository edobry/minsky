#!/usr/bin/env bun
/**
 * Targeted script to fix unused imports in tasks.test.ts
 * The generic codemod missed these because they're more complex patterns
 */

import { readFileSync, writeFileSync } from "fs";

const filePath = "src/adapters/__tests__/integration/tasks.test.ts";

console.log("🔧 Fixing unused imports in tasks.test.ts...");

// Read the current file
const content = readFileSync(filePath, "utf-8") as string;
const lines = content.split("\n");

// Fix the imports by removing unused ones
const modifiedLines = lines.map((line, index) => {
  // Fix line 2-8 which contains the domain imports
  if (index >= 1 && index <= 7 && line.includes("import {")) {
    // This is the multi-line import from domain/tasks.js
    // Remove getTaskFromParams, listTasksFromParams, getTaskStatusFromParams, setTaskStatusFromParams
    // Keep only type Task and TASK_STATUS
    if (
      line.includes("getTaskFromParams") ||
      line.includes("listTasksFromParams") ||
      line.includes("getTaskStatusFromParams") ||
      line.includes("setTaskStatusFromParams")
    ) {
      return ""; // Remove the entire line
    }
    // Keep the closing of the import with only the used items
    if (line.includes("type Task") || line.includes("TASK_STATUS")) {
      return line;
    }
  }

  // Fix line 13 which contains createMockObject
  if (index >= 9 && index <= 15 && line.includes("createMockObject")) {
    // Remove createMockObject from the import
    return line.replace(/,\s*createMockObject/, "").replace(/createMockObject,\s*/, "");
  }

  return line;
});

// Clean up empty lines and fix the import structure
const cleanedLines = modifiedLines
  .filter((line) => line.trim() !== "")
  .map((line) => {
    // Fix any remaining import formatting issues
    if (line.includes("} from") && line.includes(",,")) {
      return line.replace(/,,+/g, ",");
    }
    if (line.includes("} from") && line.includes(", }")) {
      return line.replace(", }", " }");
    }
    return line;
  });

// Write the file back
const modifiedContent = cleanedLines.join("\n");
writeFileSync(filePath, modifiedContent);

console.log("✅ Fixed unused imports in tasks.test.ts");
console.log("🗑️  Removed:");
console.log("  - getTaskFromParams");
console.log("  - listTasksFromParams");
console.log("  - getTaskStatusFromParams");
console.log("  - setTaskStatusFromParams");
console.log("  - createMockObject");
