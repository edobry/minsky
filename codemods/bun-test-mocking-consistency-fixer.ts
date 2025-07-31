/**
 * AST Codemod: Bun Test Mocking Consistency Fixer
 *
 * Systematic fix for bun:test vs vitest mocking inconsistencies.
 *
 * PROBLEM: Test files correctly import from "bun:test" but incorrectly use
 * vitest syntax (vi.fn()) instead of bun:test syntax (mock()).
 *
 * SOLUTION: Transform vi.fn() → mock() in files that import from "bun:test"
 *
 * Target: 9th systematic category in AST codemod optimization series
 */

import { Project, SourceFile, SyntaxKind } from "ts-morph";
import { readdirSync, statSync } from "fs";
import { join } from "path";

export interface FixResult {
  changed: boolean;
  reason: string;
  transformations: number;
}

/**
 * Fixes bun:test vs vitest mocking consistency by converting vi.fn() to mock()
 * in test files that import from "bun:test"
 */
export function fixMockingConsistencyInFile(sourceFile: SourceFile): FixResult {
  // Safety check: Only process test files
  const fileName = sourceFile.getBaseName();
  if (
    !fileName.includes(".test.") &&
    !fileName.includes("_test_") &&
    !fileName.includes(".spec.") &&
    !fileName.includes("_spec_")
  ) {
    return { changed: false, reason: "Not a test file - skipped for safety", transformations: 0 };
  }

  // Check if file imports from "bun:test"
  const bunTestImport = sourceFile
    .getImportDeclarations()
    .find((imp) => imp.getModuleSpecifierValue() === "bun:test");

  if (!bunTestImport) {
    return {
      changed: false,
      reason: "No bun:test import found - not a bun test file",
      transformations: 0,
    };
  }

  // Check if mock is imported from bun:test
  const mockImport = bunTestImport.getNamedImports().find((imp) => imp.getName() === "mock");

  if (!mockImport) {
    // Add mock to the import statement
    bunTestImport.addNamedImport("mock");
  }

  let transformationCount = 0;

  // Find all vi.fn() calls and replace with mock()
  sourceFile.forEachDescendant((node) => {
    if (node.getKind() === SyntaxKind.CallExpression) {
      const callExpr = node.asKindOrThrow(SyntaxKind.CallExpression);
      const expression = callExpr.getExpression();

      // Check if this is vi.fn()
      if (expression.getKind() === SyntaxKind.PropertyAccessExpression) {
        const propAccess = expression.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
        const object = propAccess.getExpression();
        const property = propAccess.getName();

        if (object.getText() === "vi" && property === "fn") {
          // Replace vi.fn() with mock()
          const args = callExpr.getArguments();
          if (args.length === 0) {
            // vi.fn() → mock(() => {})
            callExpr.replaceWithText("mock(() => {})");
          } else {
            // vi.fn(implementation) → mock(implementation)
            const argText = args[0].getText();
            callExpr.replaceWithText(`mock(${argText})`);
          }
          transformationCount++;
        }
      }
    }
  });

  if (transformationCount > 0) {
    return {
      changed: true,
      reason: `Converted ${transformationCount} vi.fn() calls to mock() for bun:test compatibility`,
      transformations: transformationCount,
    };
  }

  return { changed: false, reason: "No vi.fn() calls found to convert", transformations: 0 };
}

/**
 * Processes multiple test files to fix mocking consistency
 */
export function fixMockingConsistency(filePaths: string[]): FixResult[] {
  const project = new Project();
  const results: FixResult[] = [];

  for (const filePath of filePaths) {
    try {
      const sourceFile = project.addSourceFileAtPath(filePath);
      const result = fixMockingConsistencyInFile(sourceFile);

      if (result.changed) {
        sourceFile.saveSync();
      }

      results.push(result);
    } catch (error) {
      // Only log errors in non-test environments to avoid test noise
      if (!process.env.NODE_ENV?.includes('test') && !process.env.BUN_ENV?.includes('test')) {
        console.error(`❌ Error processing ${filePath}:`, error);
      }
      results.push({
        changed: false,
        reason: `Error: ${error instanceof Error ? error.message : String(error)}`,
        transformations: 0,
      });
    }
  }

  return results;
}

/**
 * Find all test files in a directory recursively
 */
export function findTestFiles(directory: string): string[] {
  const testFiles: string[] = [];

  function traverseDirectory(dir: string) {
    const entries = readdirSync(dir);

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        // Skip node_modules and other common directories
        if (!entry.startsWith(".") && entry !== "node_modules" && entry !== "dist") {
          traverseDirectory(fullPath);
        }
      } else if (
        stat.isFile() &&
        (entry.includes(".test.") ||
          entry.includes("_test_") ||
          entry.includes(".spec.") ||
          entry.includes("_spec_"))
      ) {
        testFiles.push(fullPath);
      }
    }
  }

  traverseDirectory(directory);
  return testFiles;
}

/**
 * Main function to fix mocking consistency across all test files
 */
export function fixAllMockingConsistency(projectRoot: string = "."): FixResult[] {
  console.log("🔍 Finding test files with mocking consistency issues...");

  const testFiles = findTestFiles(projectRoot);
  const project = new Project();
  const problematicFiles: string[] = [];

  // First pass: identify files with vi.fn() that import from bun:test
  for (const filePath of testFiles) {
    try {
      const sourceFile = project.addSourceFileAtPath(filePath);

      // Check if file imports from bun:test and has vi.fn()
      const bunTestImport = sourceFile
        .getImportDeclarations()
        .find((imp) => imp.getModuleSpecifierValue() === "bun:test");

      if (bunTestImport) {
        const fileText = sourceFile.getFullText();
        if (fileText.includes("vi.fn(")) {
          problematicFiles.push(filePath);
        }
      }
    } catch (error) {
      console.error(`Error analyzing ${filePath}:`, error);
    }
  }

  console.log(`📁 Found ${problematicFiles.length} test files with mocking consistency issues`);

  if (problematicFiles.length === 0) {
    console.log("✅ No mocking consistency issues found!");
    return [];
  }

  // Second pass: fix the identified files
  console.log("🔧 Fixing mocking consistency issues...");
  const results = fixMockingConsistency(problematicFiles);

  const successCount = results.filter((r) => r.changed).length;
  const totalTransformations = results.reduce((sum, r) => sum + r.transformations, 0);

  console.log(`✅ Fixed ${successCount} files with ${totalTransformations} total transformations`);

  return results;
}

// Main execution for direct usage
if (require.main === module) {
  const results = fixAllMockingConsistency(".");
  process.exit(results.some((r) => !r.changed && r.reason.includes("Error")) ? 1 : 0);
}
