#!/usr/bin/env bun

/**
 * AST Codemod: Session Edit Tools CommandMapper Mock Signature Fixer
 *
 * SYSTEMATIC AST CODEMOD - Session Edit Tools Mock Infrastructure
 *
 * Problem: Session Edit Tools tests have mock setup with wrong CommandMapper.addCommand signature
 * - Mock expects: (name, description, schema, handler) - old signature
 * - Actual method expects: ({name, description, parameters, handler}) - object parameter
 *
 * This codemod:
 * 1. Updates mock implementation to match actual CommandMapper.addCommand signature
 * 2. Fixes mock data extraction to use object properties correctly
 * 3. Ensures mock captures the correct parameters for test verification
 *
 * Target Files:
 * - tests/adapters/mcp/session-edit-tools.test.ts
 *
 * Expected Impact: +7 passing tests (Session Edit Tools test failures)
 */

import { Project, SourceFile, SyntaxKind, CallExpression } from "ts-morph";

interface MockFixResult {
  filePath: string;
  changed: boolean;
  reason: string;
}

export function fixCommandMapperMockSignature(sourceFile: SourceFile): MockFixResult {
  const filePath = sourceFile.getFilePath();
  const content = sourceFile.getFullText();

  // Only process the specific test file
  if (!filePath.includes("session-edit-tools.test.ts")) {
    return {
      filePath,
      changed: false,
      reason: "Not the target session-edit-tools test file - skipped",
    };
  }

  // Look for the problematic mock implementation pattern
  const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
  let fixed = false;

  for (const callExpr of callExpressions) {
    // Find: commandMapper.addCommand.mockImplementation(...)
    if (callExpr.getExpression().getKind() === SyntaxKind.PropertyAccessExpression) {
      const propAccess = callExpr
        .getExpression()
        .asKindOrThrow(SyntaxKind.PropertyAccessExpression);

      // Check if this is commandMapper.addCommand.mockImplementation
      if (
        propAccess.getName() === "mockImplementation" &&
        propAccess.getExpression().getKind() === SyntaxKind.PropertyAccessExpression
      ) {
        const innerPropAccess = propAccess
          .getExpression()
          .asKindOrThrow(SyntaxKind.PropertyAccessExpression);

        if (innerPropAccess.getName() === "addCommand") {
          // Found the mock implementation - now fix the signature
          const args = callExpr.getArguments();
          if (args.length === 1) {
            const mockFunction = args[0];

            // Check if it's using the old signature (4 parameters)
            const functionText = mockFunction.getText();
            if (
              functionText.includes(
                "(name: string, description: string, schema: any, handler: any)"
              )
            ) {
              // Replace with new signature
              const newMockImplementation = `(command: { name: string; description: string; parameters?: any; handler: any }) => {
      registeredTools[command.name] = {
        name: command.name,
        description: command.description,
        schema: command.parameters,
        handler: command.handler,
      };
    }`;

              mockFunction.replaceWithText(newMockImplementation);
              fixed = true;

              console.log(`✅ Fixed CommandMapper.addCommand mock signature in ${filePath}`);
              break;
            }
          }
        }
      }
    }
  }

  if (fixed) {
    sourceFile.saveSync();
    return {
      filePath,
      changed: true,
      reason: "Updated CommandMapper.addCommand mock signature to match object-based API",
    };
  }

  return {
    filePath,
    changed: false,
    reason: "No CommandMapper.addCommand mock signature issues found",
  };
}

export function fixSessionEditToolsCommandMapperMocks(filePaths: string[]): MockFixResult[] {
  const project = new Project({
    tsConfigFilePath: "./tsconfig.json",
    skipAddingFilesFromTsConfig: true,
  });

  // Add source files to project
  for (const filePath of filePaths) {
    project.addSourceFileAtPath(filePath);
  }

  const results: MockFixResult[] = [];

  for (const sourceFile of project.getSourceFiles()) {
    const result = fixCommandMapperMockSignature(sourceFile);
    results.push(result);
  }

  return results;
}

// Self-executing main function for standalone usage
if (import.meta.main) {
  const sessionEditToolsTestFiles = [
    "/Users/edobry/.local/state/minsky/sessions/task#276/tests/adapters/mcp/session-edit-tools.test.ts",
  ];

  console.log("🔧 Fixing Session Edit Tools CommandMapper mock signature issues...");
  const results = fixSessionEditToolsCommandMapperMocks(sessionEditToolsTestFiles);

  const changedCount = results.filter((r) => r.changed).length;
  console.log(
    `\n🎯 Fixed CommandMapper.addCommand mock signatures in ${changedCount} Session Edit Tools test files!`
  );

  if (changedCount > 0) {
    console.log("\n🧪 You can now run: bun test tests/adapters/mcp/session-edit-tools.test.ts");
  }
}
