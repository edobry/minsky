/**
 * Fix Mock Imports Script
 *
 * This script updates test files to correctly import the mock function from bun:test
 * instead of trying to use it without importing.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

// Files to process
const FILES_TO_PROCESS = [
  "tests/adapters/cli/session-directory.test.ts",
  "tests/adapters/cli/session-remaining.test.ts",
  "tests/adapters/cli/session-update.test.ts",
  "tests/adapters/cli/session.test.ts",
];

// Process each file
for (const filePath of FILES_TO_PROCESS) {
  try {
    console.log(`Processing ${filePath}...`);
    const absolutePath = join(process.cwd(), filePath);

    // Read file content
    let content = readFileSync(absolutePath, "utf8");

    // Check if mock is already imported
    const hasMockImport =
      content.includes("import { mock }") ||
      content.includes("import {mock}") ||
      (content.includes("import {") &&
        content.includes("mock") &&
        content.includes('} from "bun:test"'));

    // Update import if needed
    if (!hasMockImport) {
      // Replace the bun:test import with one that includes mock
      content = content.replace(
        /import\s*{([^}]*)}\s*from\s*['"]bun:test['"]/g,
        (match, imports) => {
          // Check if mock is already in the imports
          if (imports.includes("mock")) {
            return match;
          }

          // Add mock to the imports
          const newImports = `${imports.trim()}, mock`;
          return `import {${newImports}} from "bun:test"`;
        }
      );
    }

    // Write updated content back to file
    writeFileSync(absolutePath, content, "utf8");
    console.log(`✓ Updated ${filePath}`);
  } catch (error) {
    console.error(`Error processing ${filePath}:`, error);
  }
}

console.log("Done updating mock imports.");
