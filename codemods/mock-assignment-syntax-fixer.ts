import { Project, SourceFile, SyntaxKind } from "ts-morph";
import { SimplifiedCodemodBase } from "./utils/codemod-framework";

/**
 * Mock Assignment Syntax Fixer
 *
 * This codemod fixes malformed mock assignment syntax patterns like:
 * - mock() = mock()
 * - mockExecAsync = mock().mockImplementation() = mock()
 * - Other invalid assignment chains
 */
export class MockAssignmentSyntaxFixer extends SimplifiedCodemodBase {
  constructor() {
    super("MockAssignmentSyntaxFixer", {
      description: "Fixes malformed mock assignment syntax in test files",
      explanation: "Removes invalid assignment patterns in mock expressions",
    });
  }

  protected async analyzeFile(sourceFile: SourceFile): Promise<boolean> {
    let hasIssues = false;

    // Find all assignment expressions
    const assignments = sourceFile
      .getDescendantsOfKind(SyntaxKind.BinaryExpression)
      .filter((expr) => expr.getOperatorToken().getKind() === SyntaxKind.EqualsToken);

    for (const assignment of assignments) {
      const leftSide = assignment.getLeft().getText();
      const rightSide = assignment.getRight().getText();

      // Pattern 1: mock() = mock()
      if (leftSide.includes("mock(") && rightSide.includes("mock(")) {
        console.log(`Found malformed mock assignment: ${assignment.getText()}`);
        hasIssues = true;
      }

      // Pattern 2: mockVar = mock().mockImplementation() = mock()
      if (leftSide.includes("mockImplementation") && rightSide.includes("mock(")) {
        console.log(`Found malformed mock chain assignment: ${assignment.getText()}`);
        hasIssues = true;
      }

      // Pattern 3: Check for = mock() in the middle of expressions
      const fullText = assignment.getText();
      if (fullText.includes(") = mock(") || fullText.includes(")) = mock(")) {
        console.log(`Found malformed mock expression with = mock() in middle: ${fullText}`);
        hasIssues = true;
      }
    }

    return hasIssues;
  }

  protected async transformFile(sourceFile: SourceFile): Promise<void> {
    // Find and fix malformed mock assignments
    const assignments = sourceFile
      .getDescendantsOfKind(SyntaxKind.BinaryExpression)
      .filter((expr) => expr.getOperatorToken().getKind() === SyntaxKind.EqualsToken);

    for (const assignment of assignments) {
      const fullText = assignment.getText();

      // Fix Pattern: mockVar = mock().chain() = mock()
      // Convert to proper mock chain
      if (fullText.includes(") = mock(")) {
        const parts = fullText.split(" = mock(");
        if (parts.length === 2) {
          // Extract the first part and the mock implementation from the second part
          const firstPart = parts[0];
          const secondMockPart = "mock(" + parts[1];

          // Create a proper mock chain
          const fixedMock = `${firstPart.replace(/mock\([^)]*\)\./, "")}.mockImplementation(() => ${secondMockPart.replace(/;$/, "")});`;

          assignment.replaceWithText(fixedMock);
          console.log(`Fixed mock assignment: ${fullText} -> ${fixedMock}`);
        }
      }
    }
  }
}

/**
 * Factory function to create the codemod instance
 */
export function createCodemod(): MockAssignmentSyntaxFixer {
  return new MockAssignmentSyntaxFixer();
}

// Allow running directly from command line
if (require.main === module) {
  const codemod = createCodemod() as any; // Cast to allow processDirectory access

  // Check if argument is directory, and process all files if so
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log("Usage: bun mock-assignment-syntax-fixer.ts <path-or-directory>");
    process.exit(1);
  }

  const path = args[0];
  const fs = require("fs");

  if (fs.existsSync(path) && fs.statSync(path).isDirectory()) {
    // Process directory
    codemod.processDirectory(path);
  } else {
    // Process individual files
    codemod.run(args);
  }
}
