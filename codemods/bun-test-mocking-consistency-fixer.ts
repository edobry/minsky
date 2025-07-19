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
  changed: boolean;
  reason: string;
  transformations: number;
}

/**
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
      }
    }
  });

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

  for (const filePath of filePaths) {
    try {
      const sourceFile = project.addSourceFileAtPath(filePath);
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
      });
    }
  }

  return results;
}

/**
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
