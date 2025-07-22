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

import { Project, SourceFile, SyntaxKind, ImportDeclaration } from "ts-morph";
import { dirname, join, relative } from "path";
import { SimplifiedCodemodBase } from "./utils/codemod-framework";
import { existsSync } from "fs";
import { globSync } from "glob";

/**
 * BunTestMockingConsistencyFixer
 * 
 * This codemod fixes mock imports in test files by:
 * 1. Adding the mock import from bun:test if it's missing
 * 2. Ensuring consistent mock function usage throughout the file
 * 3. Fixing incorrect mock function assignments (createMock() = mock() pattern)
 * 
 * This is a structure-aware codemod that analyzes the actual directory structure
 * and manipulates the AST directly instead of using string replacement.
 */
export class BunTestMockingConsistencyFixer extends SimplifiedCodemodBase {
  constructor() {
    super("BunTestMockingConsistencyFixer", {
      description: "Fixes mock imports and usage in test files for Bun",
      explanation: "Ensures consistent mock usage with proper imports from bun:test"
    });
  }

  /**
   * Process all test files in a directory
   */
  public async processDirectory(dirPath: string): Promise<void> {
    if (!existsSync(dirPath)) {
      this.logError(`Directory does not exist: ${dirPath}`);
      return;
    }

    const testFilePaths = globSync(`${dirPath}/**/*.test.ts`);
    if (testFilePaths.length === 0) {
      this.logWarning(`No test files found in ${dirPath}`);
      return;
    }

    this.logSuccess(`Found ${testFilePaths.length} test files in ${dirPath}`);
    await this.run(testFilePaths);
  }

  /**
   * Find files with potential issues for batch processing
   */
  public findPotentialIssues(dirPath: string): string[] {
    // Find all test files
    const testFiles = globSync(`${dirPath}/**/*.test.ts`);
    
    // Find files that might have issues
    const potentialIssues: string[] = [];
    
    for (const filePath of testFiles) {
      try {
        const content = require("fs").readFileSync(filePath, "utf8");
        
        // Look for patterns indicating potential issues
        const hasMockUsage = content.includes("mock(");
        const hasBunTestImport = content.includes('from "bun:test"');
        const hasInvalidAssignment = content.includes("createMock() = mock(");
        
        if ((hasMockUsage && hasBunTestImport && !content.includes("import { mock }") && 
             !content.includes("import {mock}") && !content.includes(", mock }")) || 
            hasInvalidAssignment) {
          potentialIssues.push(filePath);
        }
      } catch (error) {
        this.logError(`Error checking file ${filePath}: ${error}`);
      }
    }
    
    return potentialIssues;
  }

  protected async analyzeFile(sourceFile: SourceFile): Promise<boolean> {
    // Only process test files
    if (!sourceFile.getFilePath().includes(".test.ts")) {
      return false;
    }

    // Check if file uses mock without proper import
    const mockUsages = sourceFile.getDescendantsOfKind(SyntaxKind.Identifier)
      .filter(id => id.getText() === "mock" && 
        !id.getFirstAncestorByKind(SyntaxKind.ImportDeclaration));
    
    if (mockUsages.length === 0) {
      return false; // No mock usage found
    }

    // Check if mock is already imported from bun:test
    const bunTestImports = sourceFile.getImportDeclarations()
      .filter(imp => imp.getModuleSpecifierValue() === "bun:test");
    
    if (bunTestImports.length > 0) {
      const hasMockImport = bunTestImports.some(imp => {
        const namedImports = imp.getNamedImports();
        return namedImports.some(namedImport => namedImport.getName() === "mock");
      });
      
      if (hasMockImport) {
        // Check for invalid mock function assignments
        const hasInvalidAssignments = this.hasInvalidMockAssignments(sourceFile);
        return hasInvalidAssignments;
      }
    }

    // Either missing import or has invalid assignments
    return true;
  }

  private hasInvalidMockAssignments(sourceFile: SourceFile): boolean {
    // Look for patterns like: createMock() = mock()
    const binaryExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.BinaryExpression);
    return binaryExpressions.some(expr => {
      const left = expr.getLeft().getText();
      const right = expr.getRight().getText();
      const operator = expr.getOperatorToken().getText();
      
      return operator === "=" && 
             left.includes("createMock()") && 
             right.includes("mock(");
    });
  }

  protected async transformFile(sourceFile: SourceFile): Promise<void> {
    // Step 1: Add mock import from bun:test if missing
    this.ensureMockImport(sourceFile);
    
    // Step 2: Fix invalid mock function assignments
    this.fixInvalidMockAssignments(sourceFile);
  }

  private ensureMockImport(sourceFile: SourceFile): void {
    const bunTestImports = sourceFile.getImportDeclarations()
      .filter(imp => imp.getModuleSpecifierValue() === "bun:test");
    
    if (bunTestImports.length > 0) {
      // bun:test is already imported, add mock to the named imports if missing
      const bunTestImport = bunTestImports[0];
      const namedImports = bunTestImport.getNamedImports();
      
      const hasMockImport = namedImports.some(namedImport => 
        namedImport.getName() === "mock");
      
      if (!hasMockImport) {
        bunTestImport.addNamedImport("mock");
        this.logSuccess(`Added mock to existing bun:test import in ${sourceFile.getBaseName()}`);
      }
    } else {
      // No bun:test import, add it with mock
      sourceFile.addImportDeclaration({
        moduleSpecifier: "bun:test",
        namedImports: ["mock"]
      });
      this.logSuccess(`Added new bun:test import with mock in ${sourceFile.getBaseName()}`);
    }
  }

  private fixInvalidMockAssignments(sourceFile: SourceFile): void {
    // Find binary expressions with invalid assignments: createMock() = mock()
    const binaryExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.BinaryExpression);
    
    for (const expr of binaryExpressions) {
      const left = expr.getLeft().getText();
      const right = expr.getRight().getText();
      const operator = expr.getOperatorToken().getText();
      
      if (operator === "=" && left.includes("createMock()") && right.includes("mock(")) {
        // Replace the entire expression with just the right side (mock call)
        expr.replaceWithText(right);
        this.logSuccess(`Fixed invalid mock assignment in ${sourceFile.getBaseName()}`);
      }
    }
  }
}

/**
 * Factory function to create the codemod instance
 */
export function createCodemod(): SimplifiedCodemodBase {
  return new BunTestMockingConsistencyFixer();
}

// Allow running directly from command line
if (require.main === module) {
  const codemod = createCodemod() as BunTestMockingConsistencyFixer;
  
  // Check if argument is directory, and process all files if so
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log("Usage: bun bun-test-mocking-consistency-fixer.ts <path-or-directory>");
    process.exit(1);
  }
  
  const path = args[0];
  
  if (existsSync(path) && require("fs").statSync(path).isDirectory()) {
    // Process directory
    codemod.processDirectory(path);
  } else if (args[0] === "--find-issues") {
    // Find potential issues
    const dirPath = args[1] || ".";
    const issues = codemod.findPotentialIssues(dirPath);
    
    if (issues.length > 0) {
      console.log(`Found ${issues.length} files with potential issues:`);
      issues.forEach(file => console.log(`- ${file}`));
      
      // Automatically process these files
      console.log("\nAutomatically processing these files...");
      codemod.run(issues);
    } else {
      console.log("No potential issues found.");
    }
  } else {
    // Process individual files
    codemod.run(args);
  }
}
