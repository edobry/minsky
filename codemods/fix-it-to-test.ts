#!/usr/bin/env bun

import { CodemodBase, CodemodIssue, CodemodOptions } from "./utils/codemod-framework";
import { CallExpression, SyntaxKind } from "ts-morph";

/**
 * Codemod to fix Jest-style 'it(' calls to Bun-style 'test(' calls
 *
 * This addresses the common issue when migrating from Jest to Bun test patterns
 * where 'it' is used but not imported, causing ReferenceError.
 */
export class FixItToTestCodemod extends CodemodBase {
  constructor(options: CodemodOptions = {}) {
    super({
      includePatterns: ["**/*.test.ts", "**/*.spec.ts"],
      excludePatterns: ["**/node_modules/**"],
      ...options,
    });
  }

  protected findIssues(): void {
    this.log("🔍 Finding 'it(' calls that should be 'test(' calls...");

    const sourceFiles = this.project.getSourceFiles();

    for (const sourceFile of sourceFiles) {
      // Check if file imports 'it' from bun:test or jest
      const hasItImport = sourceFile.getImportDeclarations().some((importDecl) => {
        const namedImports = importDecl.getNamedImports();
        return namedImports.some((namedImport) => namedImport.getName() === "it");
      });

      // Find all call expressions that use 'it'
      const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

      for (const callExpr of callExpressions) {
        const expression = callExpr.getExpression();

        // Check if this is an 'it(' call
        if (expression.getKind() === SyntaxKind.Identifier && expression.getText() === "it") {
          // If 'it' is not imported, this is likely an issue
          if (!hasItImport) {
            const issue: CodemodIssue = {
              file: sourceFile.getFilePath(),
              line: callExpr.getStartLineNumber(),
              column: callExpr.getStart() - callExpr.getStartLinePos() + 1,
              description: "Jest-style 'it(' call should be 'test(' for Bun compatibility",
              context: callExpr.getFullText().trim(),
              severity: "error",
              type: "jest-bun-migration",
              original: "it(",
              suggested: "test(",
            };

            this.issues.push(issue);
            this.metrics.issuesFound++;
          }
        }
      }

      this.metrics.filesProcessed++;
    }

    this.log(`📊 Found ${this.metrics.issuesFound} 'it(' calls to fix`);
  }

  protected fixIssues(): void {
    this.log("🔧 Fixing 'it(' calls to 'test(' calls...");

    const sourceFiles = this.project.getSourceFiles();

    for (const sourceFile of sourceFiles) {
      let changesInFile = 0;

      // Check if file imports 'it' from bun:test or jest
      const hasItImport = sourceFile.getImportDeclarations().some((importDecl) => {
        const namedImports = importDecl.getNamedImports();
        return namedImports.some((namedImport) => namedImport.getName() === "it");
      });

      // Skip files that legitimately import 'it'
      if (hasItImport) {
        continue;
      }

      // Find and fix all 'it(' calls
      const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

      for (const callExpr of callExpressions) {
        const expression = callExpr.getExpression();

        // Check if this is an 'it(' call
        if (expression.getKind() === SyntaxKind.Identifier && expression.getText() === "it") {
          // Replace 'it' with 'test'
          expression.replaceWithText("test");
          changesInFile++;
          this.metrics.issuesFixed++;

          this.log(
            `✅ Fixed: ${sourceFile.getBaseName()}:${callExpr.getStartLineNumber()} - it() → test()`
          );
        }
      }

      if (changesInFile > 0) {
        this.metrics.fileChanges.set(sourceFile.getFilePath(), changesInFile);
      }
    }

    this.log(`🎉 Fixed ${this.metrics.issuesFixed} 'it(' calls`);
  }
}

// CLI execution
if (import.meta.main) {
  const codemod = new FixItToTestCodemod({
    verbose: true,
    dryRun: process.argv.includes("--dry-run"),
  });

  codemod.execute().catch(console.error);
}
