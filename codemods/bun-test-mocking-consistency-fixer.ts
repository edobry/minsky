<<<<<<< HEAD
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
import { glob } from "glob";

interface FixResult {
=======
import { Project, SourceFile, SyntaxKind } from "ts-morph";
import { readdirSync, statSync } from "fs";
import { join } from "path";

export interface FixResult {
>>>>>>> task#276
  changed: boolean;
  reason: string;
  transformations: number;
}

/**
<<<<<<< HEAD
 * Fix bun:test mocking inconsistencies in a single file
 */
export function fixBunTestMockingInFile(sourceFile: SourceFile): FixResult {
  const filePath = sourceFile.getFilePath();

  // Only process test files for safety
  if (!filePath.includes('.test.ts')) {
    return { changed: false, reason: 'Not a test file', transformations: 0 };
  }

  // Check if file imports from "bun:test"
  const bunTestImports = sourceFile.getImportDeclarations()
    .filter(imp => imp.getModuleSpecifierValue() === "bun:test");

  if (bunTestImports.length === 0) {
    return { changed: false, reason: 'File does not import from bun:test', transformations: 0 };
  }

  // Check if file already imports 'mock' from bun:test
  const mockImported = bunTestImports.some(imp =>
    imp.getNamedImports().some(namedImport =>
      namedImport.getName() === "mock"
    )
  );

  let transformationCount = 0;
  let needsMockImport = false;

  // Find and replace vi.fn() calls with mock()
  sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression).forEach(callExpr => {
    const expression = callExpr.getExpression();

    // Check for vi.fn() pattern
    if (expression.getKind() === SyntaxKind.PropertyAccessExpression) {
      const propAccess = expression.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
      const object = propAccess.getExpression();
      const property = propAccess.getName();

      if (object.getKind() === SyntaxKind.Identifier &&
          object.asKindOrThrow(SyntaxKind.Identifier).getText() === "vi" &&
          property === "fn") {

        // Transform vi.fn() → mock()
        const args = callExpr.getArguments();
        if (args.length === 0) {
          // vi.fn() → mock(() => {})
          callExpr.replaceWithText("mock(() => {})");
        } else {
          // vi.fn(callback) → mock(callback)
          const argsText = args.map(arg => arg.getText()).join(", ");
          callExpr.replaceWithText(`mock(${argsText})`);
        }

        transformationCount++;
        needsMockImport = true;
=======
 * Fixes bun:test vs vitest mocking consistency by converting vi.fn() to mock()
 * in test files that import from "bun:test"
 */
export function fixMockingConsistencyInFile(sourceFile: SourceFile): FixResult {
  // Safety check: Only process test files
  const fileName = sourceFile.getBaseName();
  if (!fileName.includes('.test.') && !fileName.includes('_test_') && 
      !fileName.includes('.spec.') && !fileName.includes('_spec_')) {
    return { changed: false, reason: 'Not a test file - skipped for safety', transformations: 0 };
  }

  // Check if file imports from "bun:test"
  const bunTestImport = sourceFile.getImportDeclarations()
    .find(imp => imp.getModuleSpecifierValue() === "bun:test");
  
  if (!bunTestImport) {
    return { changed: false, reason: 'No bun:test import found - not a bun test file', transformations: 0 };
  }

  // Check if mock is imported from bun:test
  const mockImport = bunTestImport.getNamedImports()
    .find(imp => imp.getName() === "mock");
  
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
>>>>>>> task#276
      }
    }
  });

<<<<<<< HEAD
    // Add mock import if needed and not already present
  if (needsMockImport && !mockImported && bunTestImports.length > 0) {
    const firstBunTestImport = bunTestImports[0];
    const namedImports = firstBunTestImport.getNamedImports();

    // Add 'mock' to existing named imports
    const importNames = namedImports.map(ni => ni.getName());
    importNames.push("mock");
    importNames.sort(); // Keep imports sorted

    // Replace the import declaration with updated named imports
    const importText = `import { ${importNames.join(", ")} } from "bun:test";`;
    firstBunTestImport.replaceWithText(importText);
  }

  if (transformationCount > 0) {
    return {
      changed: true,
      reason: `Fixed ${transformationCount} vi.fn() → mock() transformations in bun:test file`,
      transformations: transformationCount
    };
  }

  return { changed: false, reason: 'No vi.fn() calls found to transform', transformations: 0 };
}

/**
 * Apply bun:test mocking consistency fixes to multiple files
 */
export function fixBunTestMockingInFiles(filePaths: string[]): { filePath: string; result: FixResult }[] {
  const project = new Project();
  const results: { filePath: string; result: FixResult }[] = [];
=======
  if (transformationCount > 0) {
    return { 
      changed: true, 
      reason: `Converted ${transformationCount} vi.fn() calls to mock() for bun:test compatibility`,
      transformations: transformationCount 
    };
  }

  return { changed: false, reason: 'No vi.fn() calls found to convert', transformations: 0 };
}

/**
 * Processes multiple test files to fix mocking consistency
 */
export function fixMockingConsistency(filePaths: string[]): FixResult[] {
  const project = new Project();
  const results: FixResult[] = [];
>>>>>>> task#276

  for (const filePath of filePaths) {
    try {
      const sourceFile = project.addSourceFileAtPath(filePath);
<<<<<<< HEAD
      const result = fixBunTestMockingInFile(sourceFile);

      if (result.changed) {
        sourceFile.saveSync();
      }

      results.push({ filePath, result });
    } catch (error) {
      console.error(`❌ Error processing ${filePath}:`, error);
      results.push({
        filePath,
        result: {
          changed: false,
          reason: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
          transformations: 0
        }
=======
      const result = fixMockingConsistencyInFile(sourceFile);
      
      if (result.changed) {
        sourceFile.saveSync();
      }
      
      results.push(result);
    } catch (error) {
      console.error(`❌ Error processing ${filePath}:`, error);
      results.push({ 
        changed: false, 
        reason: `Error: ${error instanceof Error ? error.message : String(error)}`,
        transformations: 0 
>>>>>>> task#276
      });
    }
  }

  return results;
}

/**
<<<<<<< HEAD
 * Fix all bun:test mocking inconsistencies in the project
 */
export async function fixAllBunTestMocking(pattern: string = "src/**/*.test.ts"): Promise<void> {
  console.log("🔧 Starting systematic bun:test mocking consistency fixes...");

  const testFiles = await glob(pattern);
  console.log(`📁 Found ${testFiles.length} test files to analyze`);

  const results = fixBunTestMockingInFiles(testFiles);

  let totalTransformations = 0;
  let filesChanged = 0;

  results.forEach(({ filePath, result }) => {
    if (result.changed) {
      console.log(`✅ ${filePath}: ${result.reason}`);
      totalTransformations += result.transformations;
      filesChanged++;
    } else if (result.reason.includes('Error')) {
      console.log(`❌ ${filePath}: ${result.reason}`);
    }
  });

  console.log(`\n🎉 Systematic bun:test mocking fixes completed!`);
  console.log(`📊 Files changed: ${filesChanged}`);
  console.log(`🔧 Total transformations: ${totalTransformations}`);
  console.log(`📈 Systematic category target: vi.fn() → mock() consistency`);
}

// Main execution for direct usage
if (require.main === module) {
  fixAllBunTestMocking().catch(console.error);
}
=======
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
        if (!entry.startsWith('.') && entry !== 'node_modules' && entry !== 'dist') {
          traverseDirectory(fullPath);
        }
      } else if (stat.isFile() && (
        entry.includes('.test.') || entry.includes('_test_') ||
        entry.includes('.spec.') || entry.includes('_spec_')
      )) {
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
      const bunTestImport = sourceFile.getImportDeclarations()
        .find(imp => imp.getModuleSpecifierValue() === "bun:test");
      
      if (bunTestImport) {
        const fileText = sourceFile.getFullText();
        if (fileText.includes('vi.fn(')) {
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
  
  const successCount = results.filter(r => r.changed).length;
  const totalTransformations = results.reduce((sum, r) => sum + r.transformations, 0);
  
  console.log(`✅ Fixed ${successCount} files with ${totalTransformations} total transformations`);
  
  return results;
} 
>>>>>>> task#276
