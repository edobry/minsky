#!/usr/bin/env bun

import { CodemodBase, CodemodIssue, CodemodOptions } from "./utils/codemod-framework";
import {
  CallExpression,
  SyntaxKind,
  ImportDeclaration,
  VariableDeclaration,
  PropertyAccessExpression,
  AsExpression
} from "ts-morph";

/**
 * Comprehensive Jest-to-Bun Test Migration Codemod for Task #305
 *
 * This codemod systematically migrates Jest patterns to Bun test patterns:
 * 1. jest.fn() → mock()
 * 2. .mockImplementation() → = mock()
 * 3. .mockReturnValue() → = mock(() => value)
 * 4. .mockResolvedValue() → = mock(() => Promise.resolve(value))
 * 5. .mockRejectedValue() → = mock(() => Promise.reject(error))
 * 6. .mockReturnValueOnce() → = mock(() => value)
 * 7. .mockResolvedValueOnce() → = mock(() => Promise.resolve(value))
 * 8. jest.spyOn() → spyOn()
 * 9. jest.mock() → mockModule()
 * 10. Import statement updates: jest → bun:test
 * 11. it() → test() (already handled by fix-it-to-test.ts)
 *
 * Follows AST-first development principles for 6x effectiveness over regex approaches.
 */
export class JestToBunComprehensiveMigration extends CodemodBase {

  constructor(options: CodemodOptions = {}) {
    super({
      includePatterns: ["**/*.test.ts", "**/*.spec.ts", "src/**/*.ts", "tests/**/*.ts"],
      excludePatterns: [
        "**/node_modules/**",
        "**/codemods/**",
        "**/compatibility/**", // Skip compatibility layer
        "**/*.d.ts"
      ],
      ...options
    });
  }

  protected findIssues(): void {
    this.log("🔍 Finding Jest patterns for migration to Bun...");

    const sourceFiles = this.project.getSourceFiles();

    for (const sourceFile of sourceFiles) {
      this.findJestImports(sourceFile);
      this.findJestFnCalls(sourceFile);
      this.findJestMockCalls(sourceFile);
      this.findJestSpyOnCalls(sourceFile);
      this.findMockMethodCalls(sourceFile);
      this.findVariableDeclarators(sourceFile);

      this.metrics.filesProcessed++;
    }

    this.log(`📊 Found ${this.metrics.issuesFound} Jest patterns to migrate`);
  }

  private findJestImports(sourceFile: any): void {
    const importDeclarations = sourceFile.getImportDeclarations();

    for (const importDecl of importDeclarations) {
      const moduleSpecifier = importDecl.getModuleSpecifierValue();

      if (moduleSpecifier === "jest" ||
          moduleSpecifier.includes("@jest/") ||
          moduleSpecifier === "@testing-library/jest-dom") {

        this.addIssue({
          file: sourceFile.getFilePath(),
          line: importDecl.getStartLineNumber(),
          column: importDecl.getStart() - importDecl.getStartLinePos() + 1,
          description: "Jest import should be migrated to Bun test import",
          context: importDecl.getFullText().trim(),
          severity: "error",
          type: "jest-import",
          original: moduleSpecifier,
          suggested: "bun:test"
        });
      }
    }
  }

  private findJestFnCalls(sourceFile: any): void {
    const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

    for (const callExpr of callExpressions) {
      const expression = callExpr.getExpression();

      // Check for jest.fn() calls
      if (expression.getKind() === SyntaxKind.PropertyAccessExpression) {
        const propAccess = expression;
        const object = propAccess.getExpression();
        const property = propAccess.getName();

        if (object.getText() === "jest" && property === "fn") {
          this.addIssue({
            file: sourceFile.getFilePath(),
            line: callExpr.getStartLineNumber(),
            column: callExpr.getStart() - callExpr.getStartLinePos() + 1,
            description: "jest.fn() should be migrated to mock()",
            context: callExpr.getFullText().trim(),
            severity: "error",
            type: "jest-fn",
            original: "jest.fn()",
            suggested: "mock()"
          });
        }
      }
    }
  }

  private findJestMockCalls(sourceFile: any): void {
    const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

    for (const callExpr of callExpressions) {
      const expression = callExpr.getExpression();

      if (expression.getKind() === SyntaxKind.PropertyAccessExpression) {
        const propAccess = expression;
        const object = propAccess.getExpression();
        const property = propAccess.getName();

        if (object.getText() === "jest" && property === "mock") {
          this.addIssue({
            file: sourceFile.getFilePath(),
            line: callExpr.getStartLineNumber(),
            column: callExpr.getStart() - callExpr.getStartLinePos() + 1,
            description: "jest.mock() should be migrated to mockModule()",
            context: callExpr.getFullText().trim(),
            severity: "error",
            type: "jest-mock",
            original: "jest.mock",
            suggested: "mockModule"
          });
        }

        if (object.getText() === "jest" && property === "spyOn") {
          this.addIssue({
            file: sourceFile.getFilePath(),
            line: callExpr.getStartLineNumber(),
            column: callExpr.getStart() - callExpr.getStartLinePos() + 1,
            description: "jest.spyOn() should be migrated to spyOn()",
            context: callExpr.getFullText().trim(),
            severity: "error",
            type: "jest-spyon",
            original: "jest.spyOn",
            suggested: "spyOn"
          });
        }
      }
    }
  }

  private findJestSpyOnCalls(sourceFile: any): void {
    // This is handled in findJestMockCalls for consistency
  }

  private findMockMethodCalls(sourceFile: any): void {
    const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

    for (const callExpr of callExpressions) {
      const expression = callExpr.getExpression();

      if (expression.getKind() === SyntaxKind.PropertyAccessExpression) {
        const propAccess = expression;
        const property = propAccess.getName();
        const object = propAccess.getExpression();
        const objectText = object.getText();

        // Skip spyOn().mockImplementation() - it works in Bun
        if (objectText.includes("spyOn")) {
          continue;
        }

        const mockMethods = [
          "mockImplementation",
          "mockReturnValue",
          "mockResolvedValue",
          "mockRejectedValue",
          "mockReturnValueOnce",
          "mockResolvedValueOnce",
          "mockRejectedValueOnce"
        ];

        if (mockMethods.includes(property)) {
          let suggestion = "";
          const args = callExpr.getArguments();
          const firstArg = args.length > 0 ? args[0].getText() : "";

          switch (property) {
            case "mockImplementation":
              suggestion = `${objectText} = mock(${firstArg || "() => {}"})`;
              break;
            case "mockReturnValue":
            case "mockReturnValueOnce":
              suggestion = `${objectText} = mock(() => ${firstArg || "undefined"})`;
              break;
            case "mockResolvedValue":
            case "mockResolvedValueOnce":
              suggestion = `${objectText} = mock(() => Promise.resolve(${firstArg || "undefined"}))`;
              break;
            case "mockRejectedValue":
            case "mockRejectedValueOnce":
              suggestion = `${objectText} = mock(() => Promise.reject(${firstArg || "new Error()"}))`;
              break;
          }

          this.addIssue({
            file: sourceFile.getFilePath(),
            line: callExpr.getStartLineNumber(),
            column: callExpr.getStart() - callExpr.getStartLinePos() + 1,
            description: `${property}() should be migrated to Bun mock assignment`,
            context: callExpr.getFullText().trim(),
            severity: "error",
            type: "mock-method",
            original: `.${property}()`,
            suggested: suggestion
          });
        }
      }
    }
  }

  private findVariableDeclarators(sourceFile: any): void {
    const variableDeclarators = sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration);

    for (const varDecl of variableDeclarators) {
      const init = varDecl.getInitializer();

      if (init && init.getKind() === SyntaxKind.CallExpression) {
        const callExpr = init;
        const expression = callExpr.getExpression();

        if (expression.getKind() === SyntaxKind.PropertyAccessExpression) {
          const propAccess = expression;
          const object = propAccess.getExpression();
          const property = propAccess.getName();

          if (object.getText() === "jest" && property === "fn") {
            this.addIssue({
              file: sourceFile.getFilePath(),
              line: varDecl.getStartLineNumber(),
              column: varDecl.getStart() - varDecl.getStartLinePos() + 1,
              description: "Variable declaration with jest.fn() should use mock()",
              context: varDecl.getFullText().trim(),
              severity: "error",
              type: "jest-fn-variable",
              original: "jest.fn()",
              suggested: "mock()"
            });
          }
        }
      }
    }
  }

  protected addIssue(issue: Omit<CodemodIssue, 'line' | 'column'> & { line: number; column: number }): void {
    this.issues.push(issue);
    this.metrics.issuesFound++;
  }

  protected fixIssues(): void {
    this.log("🔧 Applying Jest-to-Bun migrations...");

    const sourceFiles = this.project.getSourceFiles();

    for (const sourceFile of sourceFiles) {
      let changesInFile = 0;

      // Fix imports first
      changesInFile += this.fixJestImports(sourceFile);

      // Fix calls
      changesInFile += this.fixJestFnCalls(sourceFile);
      changesInFile += this.fixJestMockCalls(sourceFile);
      changesInFile += this.fixMockMethodCalls(sourceFile);

      if (changesInFile > 0) {
        this.metrics.fileChanges.set(sourceFile.getFilePath(), changesInFile);
        this.metrics.issuesFixed += changesInFile;
      }
    }

    this.log(`🎉 Applied ${this.metrics.issuesFixed} Jest-to-Bun migrations`);
  }

  private fixJestImports(sourceFile: any): number {
    let changes = 0;
    const importDeclarations = sourceFile.getImportDeclarations();

    for (const importDecl of importDeclarations) {
      const moduleSpecifier = importDecl.getModuleSpecifierValue();

      if (moduleSpecifier === "jest") {
        // Replace jest import with bun:test import
        const namedImports = importDecl.getNamedImports();
        const importNames: string[] = [];

        // Map common Jest imports to Bun equivalents
        for (const namedImport of namedImports) {
          const name = namedImport.getName();
          switch (name) {
            case "jest":
              // jest object not needed in Bun
              break;
            default:
              importNames.push(name);
          }
        }

        // Add essential Bun imports
        const bunImports = ["mock", "spyOn"];
        for (const bunImport of bunImports) {
          if (!importNames.includes(bunImport)) {
            importNames.push(bunImport);
          }
        }

        if (importNames.length > 0) {
          importDecl.setModuleSpecifier("bun:test");
          const newImportText = `import { ${importNames.join(", ")} } from "bun:test"`;
          importDecl.replaceWithText(newImportText);
        } else {
          importDecl.remove();
        }

        changes++;
        this.log(`✅ Fixed import: ${sourceFile.getBaseName()}`);
      }
    }

    return changes;
  }

  private fixJestFnCalls(sourceFile: any): number {
    let changes = 0;
    const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

    for (const callExpr of callExpressions) {
      const expression = callExpr.getExpression();

      if (expression.getKind() === SyntaxKind.PropertyAccessExpression) {
        const propAccess = expression;
        const object = propAccess.getExpression();
        const property = propAccess.getName();

        if (object.getText() === "jest" && property === "fn") {
          // Replace jest.fn() with mock()
          const args = callExpr.getArguments();
          const argText = args.length > 0 ? callExpr.getArguments().map(arg => arg.getText()).join(", ") : "";

          callExpr.replaceWithText(`mock(${argText})`);
          changes++;
          this.log(`✅ Fixed jest.fn(): ${sourceFile.getBaseName()}:${callExpr.getStartLineNumber()}`);
        }
      }
    }

    return changes;
  }

  private fixJestMockCalls(sourceFile: any): number {
    let changes = 0;
    const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

    for (const callExpr of callExpressions) {
      const expression = callExpr.getExpression();

      if (expression.getKind() === SyntaxKind.PropertyAccessExpression) {
        const propAccess = expression;
        const object = propAccess.getExpression();
        const property = propAccess.getName();

        if (object.getText() === "jest" && property === "mock") {
          // Replace jest.mock() with mockModule()
          const args = callExpr.getArguments();
          const argText = args.map(arg => arg.getText()).join(", ");

          callExpr.replaceWithText(`mockModule(${argText})`);
          changes++;
          this.log(`✅ Fixed jest.mock(): ${sourceFile.getBaseName()}:${callExpr.getStartLineNumber()}`);
        }

        if (object.getText() === "jest" && property === "spyOn") {
          // Replace jest.spyOn() with spyOn()
          const args = callExpr.getArguments();
          const argText = args.map(arg => arg.getText()).join(", ");

          callExpr.replaceWithText(`spyOn(${argText})`);
          changes++;
          this.log(`✅ Fixed jest.spyOn(): ${sourceFile.getBaseName()}:${callExpr.getStartLineNumber()}`);
        }
      }
    }

    return changes;
  }

  private fixMockMethodCalls(sourceFile: any): number {
    let changes = 0;
    const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

    for (const callExpr of callExpressions) {
      const expression = callExpr.getExpression();

      if (expression.getKind() === SyntaxKind.PropertyAccessExpression) {
        const propAccess = expression;
        const property = propAccess.getName();
        const object = propAccess.getExpression();
        const objectText = object.getText();

        // Skip spyOn().mockImplementation() - it works in Bun
        if (objectText.includes("spyOn")) {
          continue;
        }

        const args = callExpr.getArguments();
        const firstArg = args.length > 0 ? args[0].getText() : "";

        let replacement = "";

        switch (property) {
          case "mockImplementation":
            replacement = `${objectText} = mock(${firstArg || "() => {}"})`;
            break;
          case "mockReturnValue":
          case "mockReturnValueOnce":
            replacement = `${objectText} = mock(() => ${firstArg || "undefined"})`;
            break;
          case "mockResolvedValue":
          case "mockResolvedValueOnce":
            replacement = `${objectText} = mock(() => Promise.resolve(${firstArg || "undefined"}))`;
            break;
          case "mockRejectedValue":
          case "mockRejectedValueOnce":
            replacement = `${objectText} = mock(() => Promise.reject(${firstArg || "new Error()"}))`;
            break;
          default:
            continue;
        }

        if (replacement) {
          // Find the statement containing this call expression
          let statement = callExpr.getParent();
          while (statement && statement.getKind() !== SyntaxKind.ExpressionStatement) {
            statement = statement.getParent();
          }

          if (statement) {
            statement.replaceWithText(replacement + ";");
            changes++;
            this.log(`✅ Fixed .${property}(): ${sourceFile.getBaseName()}:${callExpr.getStartLineNumber()}`);
          }
        }
      }
    }

    return changes;
  }
}

// CLI execution
if (import.meta.main) {
  const codemod = new JestToBunComprehensiveMigration({
    verbose: true,
    dryRun: process.argv.includes("--dry-run")
  });

  codemod.execute().catch(console.error);
}

export default JestToBunComprehensiveMigration;
