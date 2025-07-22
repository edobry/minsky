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
      explanation: "Removes invalid assignment patterns in mock expressions"
    });
  }

  protected async analyzeFile(sourceFile: SourceFile): Promise<boolean> {
    // Only process test files
    if (!sourceFile.getFilePath().includes(".test.ts")) {
      return false;
    }

    const fileText = sourceFile.getFullText();
    
    // Look for patterns that indicate malformed mock assignments
    const hasInvalidAssignments = 
      fileText.includes("mock() = mock()") ||
      fileText.includes(") = mock(") ||
      fileText.includes("mockImplementation() = mock(") ||
      fileText.includes("mockImplementationOnce() = mock(");
    
    return hasInvalidAssignments;
  }

  protected async transformFile(sourceFile: SourceFile): Promise<void> {
    let fileText = sourceFile.getFullText();
    let changed = false;

    // Pattern 1: Fix simple mock() = mock() patterns
    const pattern1 = /mock\(\s*[^)]*\s*\)\s*=\s*mock\(/g;
    if (pattern1.test(fileText)) {
      fileText = fileText.replace(pattern1, "mock(");
      changed = true;
      this.logSuccess("Fixed mock() = mock() pattern");
    }

    // Pattern 2: Fix mockImplementation chains with assignments
    const pattern2 = /\.mockImplementation(?:Once)?\([^)]*\)\s*=\s*mock\(/g;
    if (pattern2.test(fileText)) {
      fileText = fileText.replace(pattern2, ".mockImplementation(");
      changed = true;
      this.logSuccess("Fixed mockImplementation assignment pattern");
    }

    // Pattern 3: Fix complex chained assignments
    const pattern3 = /\)\s*=\s*mock\(\s*\(\)\s*=>\s*Promise\.resolve\([^)]*\)\s*\)\s*\(\s*{[^}]*}\s*\)\s*=\s*mock\(/g;
    if (pattern3.test(fileText)) {
      fileText = fileText.replace(pattern3, ").mockImplementation(() => Promise.resolve({ stdout: \"\", stderr: \"\" })); // Fixed");
      changed = true;
      this.logSuccess("Fixed complex chained assignment pattern");
    }

    // Pattern 4: Fix any remaining ) = mock( patterns
    const pattern4 = /\)\s*=\s*mock\(/g;
    if (pattern4.test(fileText)) {
      fileText = fileText.replace(pattern4, "); // Fixed assignment - was: ) = mock(");
      changed = true;
      this.logSuccess("Fixed remaining assignment patterns");
    }

    if (changed) {
      sourceFile.replaceWithText(fileText);
      this.logSuccess(`Fixed mock assignment syntax in ${sourceFile.getBaseName()}`);
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
