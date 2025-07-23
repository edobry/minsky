#!/usr/bin/env bun

/**
 * AST Codemod: Session Update Mock Infrastructure Fixer
 *
 * SYSTEMATIC AST CODEMOD - Session Update Test Mock Infrastructure
 *
 * Problem: Session Update tests failing because sessionDB mock is missing getSessionWorkdir method
 * - Error: "deps.sessionDB.getSessionWorkdir is not a function"
 * - Root cause: mockSessionProvider (used as sessionDB) missing getSessionWorkdir method
 * - Pattern: 4 tests failing with identical error at same line in session.ts:719
 *
 * This codemod:
 * 1. Adds missing getSessionWorkdir method to mockSessionProvider
 * 2. Ensures method returns appropriate mock workdir path
 * 3. Aligns with existing mock infrastructure patterns
 *
 * Target Files:
 * - src/domain/session-update.test.ts
 *
 * Expected Impact: +4 passing tests (Session Update test failures)
 */

import { Project, SourceFile, SyntaxKind } from "ts-morph";

interface SessionUpdateMockFixResult {
  filePath: string;
  changed: boolean;
  reason: string;
}

export function fixSessionUpdateMockInfrastructure(
  sourceFile: SourceFile
): SessionUpdateMockFixResult {
  const filePath = sourceFile.getFilePath();

  // Only process the specific test file
  if (!filePath.includes("session-update.test.ts")) {
    return {
      filePath,
      changed: false,
      reason: "Not the target session-update test file - skipped",
    };
  }

  let fixed = false;

  // Find the mockSessionProvider object literal and add the missing method
  const variableStatements = sourceFile.getVariableStatements();

  for (const varStatement of variableStatements) {
    const declarations = varStatement.getDeclarations();

    for (const declaration of declarations) {
      const name = declaration.getName();

      if (name === "mockSessionProvider") {
        const initializer = declaration.getInitializer();

        if (initializer && initializer.getKind() === SyntaxKind.ObjectLiteralExpression) {
          const objectLiteral = initializer.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);

          // Check if getSessionWorkdir method already exists
          const existingMethods = objectLiteral
            .getProperties()
            .filter((prop) => prop.getKind() === SyntaxKind.PropertyAssignment)
            .map((prop) => prop.asKindOrThrow(SyntaxKind.PropertyAssignment))
            .filter((prop) => prop.getName() === "getSessionWorkdir");

          if (existingMethods.length === 0) {
            // Add the missing getSessionWorkdir method
            objectLiteral.addPropertyAssignment({
              name: "getSessionWorkdir",
              initializer: 'createMock(() => Promise.resolve("/mock/session/workdir"))',
            });

            fixed = true;
            console.log(
              `✅ Added missing getSessionWorkdir method to mockSessionProvider in ${filePath}`
            );
          }
        }
      }
    }
  }

  // Alternative approach: Find and update the beforeEach block if the above doesn't work
  if (!fixed) {
    const content = sourceFile.getFullText();

    // Pattern to find the mockSessionProvider assignment in beforeEach
    const mockSessionProviderPattern = /mockSessionProvider = \{([^}]+)\};/s;
    const match = content.match(mockSessionProviderPattern);

    if (match) {
      const objectContent = match[1];

      // Check if getSessionWorkdir is already present
      if (!objectContent.includes("getSessionWorkdir")) {
        // Add the missing method
        const newObjectContent =
          objectContent.trim() +
          ',\n      getSessionWorkdir: createMock(() => Promise.resolve("/mock/session/workdir"))';

        const newContent = content.replace(
          mockSessionProviderPattern,
          `mockSessionProvider = {\n${newObjectContent}\n    };`
        );

        sourceFile.replaceWithText(newContent);
        fixed = true;
        console.log(
          `✅ Added missing getSessionWorkdir method to mockSessionProvider via text replacement in ${filePath}`
        );
      }
    }
  }

  if (fixed) {
    sourceFile.saveSync();
    return {
      filePath,
      changed: true,
      reason:
        "Added missing getSessionWorkdir method to mockSessionProvider - fixes sessionDB dependency issue",
    };
  }

  return {
    filePath,
    changed: false,
    reason:
      "No Session Update mock infrastructure issues found or getSessionWorkdir already exists",
  };
}

export function fixSessionUpdateMockInfrastructureTests(
  filePaths: string[]
): SessionUpdateMockFixResult[] {
  const project = new Project({
    tsConfigFilePath: "./tsconfig.json",
    skipAddingFilesFromTsConfig: true,
  });

  // Add source files to project
  for (const filePath of filePaths) {
    project.addSourceFileAtPath(filePath);
  }

  const results: SessionUpdateMockFixResult[] = [];

  for (const sourceFile of project.getSourceFiles()) {
    const result = fixSessionUpdateMockInfrastructure(sourceFile);
    results.push(result);
  }

  return results;
}

// Self-executing main function for standalone usage
if (import.meta.main) {
  const sessionUpdateTestFiles = [
    "/Users/edobry/.local/state/minsky/sessions/task#276/src/domain/session-update.test.ts",
  ];

  console.log("🔧 Fixing Session Update test mock infrastructure...");
  const results = fixSessionUpdateMockInfrastructureTests(sessionUpdateTestFiles);

  const changedCount = results.filter((r) => r.changed).length;
  console.log(`\n🎯 Fixed Session Update mock infrastructure in ${changedCount} test files!`);

  if (changedCount > 0) {
    console.log("\n🧪 You can now run: bun test src/domain/session-update.test.ts");
  }
}
