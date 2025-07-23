#!/usr/bin/env bun

/**
 * AST Codemod: Jest to Bun Pattern Migration
 *
 * PROBLEM: Files contain Jest patterns that need systematic migration to Bun equivalents
 * - jest.fn() → mock()
 * - .mockReturnValue() → mock(() => value)
 * - .mockResolvedValue() → mock(() => Promise.resolve(value))
 * - .mockRejectedValue() → mock(() => Promise.reject(error))
 * - .mockImplementation() → mock(implementation) (except for spyOn chains)
 *
 * SOLUTION: Systematic AST-based transformation following established patterns
 * Target: Task #305 - Systematic Jest Pattern Migration & ESLint Rule Re-enablement
 */

import { Project, SourceFile, CallExpression, Node, SyntaxKind } from "ts-morph";
import {
  CodemodBase,
  CodemodIssue,
  CodemodMetrics,
  CodemodOptions,
} from "./utils/codemod-framework.js";

interface JestPattern {
  type:
    | "jest.fn"
    | "mockReturnValue"
    | "mockResolvedValue"
    | "mockRejectedValue"
    | "mockImplementation"
    | "mockResolvedValueOnce"
    | "mockRejectedValueOnce";
  node: CallExpression;
  replacement: string;
  originalText: string;
}

export class JestToBunMigrationCodemod extends CodemodBase {
  protected readonly name = "Jest to Bun Migration";
  protected readonly description = "Migrates Jest patterns to Bun test equivalents";

  protected findIssues(): void {
    const sourceFiles = this.project.getSourceFiles();

    for (const sourceFile of sourceFiles) {
      this.metrics.filesProcessed++;
      const patterns = this.findJestPatterns(sourceFile);

      for (const pattern of patterns) {
        const lineAndColumn = this.getLineAndColumn(pattern.node);

        this.addIssue({
          file: sourceFile.getFilePath(),
          line: lineAndColumn.line,
          column: lineAndColumn.column,
          description: `Jest pattern '${pattern.type}' needs migration to Bun equivalent`,
          context: this.getContext(pattern.node),
          severity: "warning",
          type: pattern.type,
        });
      }
    }
  }

  protected fixIssues(): void {
    const sourceFiles = this.project.getSourceFiles();

    for (const sourceFile of sourceFiles) {
      const patterns = this.findJestPatterns(sourceFile);

      if (patterns.length > 0) {
        // Apply transformations in reverse order to avoid position shifts
        patterns.reverse().forEach((pattern) => {
          try {
            pattern.node.replaceWithText(pattern.replacement);
            this.recordFix(sourceFile.getFilePath());
          } catch (error) {
            this.metrics.errors.push(
              `Failed to transform ${pattern.type} in ${sourceFile.getFilePath()}: ${error}`
            );
          }
        });
      }
    }
  }

  private findJestPatterns(sourceFile: SourceFile): JestPattern[] {
    const patterns: JestPattern[] = [];

    sourceFile.forEachDescendant((node) => {
      if (Node.isCallExpression(node)) {
        const pattern = this.analyzeCallExpression(node);
        if (pattern) {
          patterns.push(pattern);
        }
      }
    });

    return patterns;
  }

  private analyzeCallExpression(callExpr: CallExpression): JestPattern | null {
    const expr = callExpr.getExpression();
    const originalText = callExpr.getText();

    // Handle jest.fn() calls
    if (
      Node.isPropertyAccessExpression(expr) &&
      expr.getExpression().getText() === "jest" &&
      expr.getName() === "fn"
    ) {
      const args = callExpr.getArguments();
      const argText = args.length > 0 ? args.map((arg) => arg.getText()).join(", ") : "";

      return {
        type: "jest.fn",
        node: callExpr,
        replacement: `mock(${argText})`,
        originalText,
      };
    }

    // Handle .mockXXX() method calls
    if (Node.isPropertyAccessExpression(expr)) {
      const methodName = expr.getName();
      const objectExpr = expr.getExpression();
      const args = callExpr.getArguments();

      switch (methodName) {
        case "mockImplementation":
          // Don't transform spyOn().mockImplementation() - it works in Bun
          if (objectExpr.getText().includes("spyOn")) {
            return null;
          }

          const implementation = args.length > 0 ? args[0].getText() : "() => {}";
          return {
            type: "mockImplementation",
            node: callExpr,
            replacement: `${objectExpr.getText()} = mock(${implementation})`,
            originalText,
          };

        case "mockReturnValue":
          const returnValue = args.length > 0 ? args[0].getText() : "undefined";
          return {
            type: "mockReturnValue",
            node: callExpr,
            replacement: `${objectExpr.getText()} = mock(() => ${returnValue})`,
            originalText,
          };

        case "mockResolvedValue":
        case "mockResolvedValueOnce":
          const resolvedValue = args.length > 0 ? args[0].getText() : "undefined";
          return {
            type: methodName as any,
            node: callExpr,
            replacement: `${objectExpr.getText()} = mock(() => Promise.resolve(${resolvedValue}))`,
            originalText,
          };

        case "mockRejectedValue":
        case "mockRejectedValueOnce":
          const rejectedValue = args.length > 0 ? args[0].getText() : 'new Error("mock rejection")';
          return {
            type: methodName as any,
            node: callExpr,
            replacement: `${objectExpr.getText()} = mock(() => Promise.reject(${rejectedValue}))`,
            originalText,
          };
      }
    }

    return null;
  }
}

// CLI runner
async function main() {
  const codemod = new JestToBunMigrationCodemod({
    includePatterns: ["src/**/*.ts", "tests/**/*.ts"],
    excludePatterns: ["**/node_modules/**", "**/*.d.ts"],
    verbose: true,
  });

  console.log("🔄 Starting Jest to Bun pattern migration...");
  await codemod.execute();

  console.log("\n✅ Jest to Bun migration completed!");
}

if (import.meta.main) {
  main().catch(console.error);
}
