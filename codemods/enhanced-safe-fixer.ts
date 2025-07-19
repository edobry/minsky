#!/usr/bin/env bun

/**
 * Enhanced Safe AST Codemod for Task #280 - Additional High-Priority Patterns
 * 
 * Targets additional safe transformation patterns:
 * - toString() method calls on data/buffer objects
 * - Object.keys(), Object.values(), Object.entries() patterns
 * - Simple method chaining without complex expressions
 * - Property access on well-known objects
 */

import { Project, SyntaxKind, AsExpression, Node, PropertyAccessExpression } from "ts-morph";
import { writeFileSync } from "fs";

interface TransformationResult {
  file: string;
  line: number;
  before: string;
  after: string;
  pattern: string;
}

class EnhancedSafeAsUnknownFixer {
  private project: Project;
  private transformations: TransformationResult[] = [];

  constructor() {
    this.project = new Project({
      tsConfigFilePath: "./tsconfig.json",
      skipAddingFilesFromTsConfig: true,
    });
  }

  async execute(): Promise<void> {
    console.log("🚀 Starting enhanced safe 'as unknown' fixes...");
    
    // Add source files (excluding tests and generated files)
    this.project.addSourceFilesAtPaths([
      "src/**/*.ts",
      "!src/**/*.test.ts",
      "!src/**/*.spec.ts",
      "!**/*.d.ts",
      "!**/node_modules/**"
    ]);

    const sourceFiles = this.project.getSourceFiles();
    console.log(`📁 Processing ${sourceFiles.length} files`);

    for (const sourceFile of sourceFiles) {
      this.processFile(sourceFile);
    }

    // Save changes
    console.log("💾 Saving changes...");
    await this.project.save();

    // Generate report
    this.generateReport();
  }

  private processFile(sourceFile: any): void {
    const filePath = sourceFile.getFilePath();
    
    sourceFile.forEachDescendant((node: Node) => {
      if (node.getKind() === SyntaxKind.AsExpression) {
        const asExpression = node as AsExpression;
        this.tryFixAsExpression(asExpression, filePath);
      }
    });
  }

  private tryFixAsExpression(asExpression: AsExpression, filePath: string): void {
    const fullText = asExpression.getText();
    
    // Only handle 'as unknown' patterns
    if (!fullText.includes("as unknown")) {
      return;
    }

    // Get the expression being cast
    const expression = asExpression.getExpression();
    const expressionText = expression.getText();

    try {
      // Pattern 1: Object static method calls
      if (this.isObjectStaticMethodCall(expressionText)) {
        this.applySimpleFix(asExpression, filePath, expressionText, "Object Static Method");
        return;
      }

      // Pattern 2: Simple toString() patterns
      if (this.isSimpleToStringPattern(asExpression)) {
        this.applySimpleFix(asExpression, filePath, expressionText, "toString() Method");
        return;
      }

      // Pattern 3: Buffer/data operations
      if (this.isBufferDataOperation(expressionText)) {
        this.applySimpleFix(asExpression, filePath, expressionText, "Buffer/Data Operation");
        return;
      }

      // Pattern 4: Array/string operations
      if (this.isArrayStringOperation(expressionText)) {
        this.applySimpleFix(asExpression, filePath, expressionText, "Array/String Operation");
        return;
      }

      // Pattern 5: Simple property access on known objects (conservative)
      if (this.isKnownObjectPropertyAccess(asExpression, expressionText)) {
        this.applySimpleFix(asExpression, filePath, expressionText, "Known Object Property");
        return;
      }

    } catch (error) {
      console.log(`⚠️  Skipped unsafe transformation in ${filePath}: ${error}`);
    }
  }

  private isObjectStaticMethodCall(expressionText: string): boolean {
    // Match Object.keys(), Object.values(), Object.entries()
    return /^Object\.(keys|values|entries)\(/.test(expressionText);
  }

  private isSimpleToStringPattern(asExpression: AsExpression): boolean {
    // Check if this is followed by .toString()
    const parent = asExpression.getParent();
    if (parent && parent.getKind() === SyntaxKind.ParenthesizedExpression) {
      const grandParent = parent.getParent();
      if (grandParent && grandParent.getKind() === SyntaxKind.PropertyAccessExpression) {
        const propAccess = grandParent as PropertyAccessExpression;
        const propertyName = propAccess.getName();
        return propertyName === "toString";
      }
    }
    return false;
  }

  private isBufferDataOperation(expressionText: string): boolean {
    // Match buffer/data related operations
    return expressionText.includes("data") || 
           expressionText.includes("buffer") || 
           expressionText.includes("Buffer") ||
           expressionText.includes("stdout") ||
           expressionText.includes("stderr");
  }

  private isArrayStringOperation(expressionText: string): boolean {
    // Match safe array/string operations
    return /\.(length|join|split|slice|substring|indexOf|includes|trim|toLowerCase|toUpperCase)$/.test(expressionText) ||
           /\.(map|filter|find|reduce|forEach|some|every)\(/.test(expressionText);
  }

  private isKnownObjectPropertyAccess(asExpression: AsExpression, expressionText: string): boolean {
    // Very conservative - only well-known safe patterns
    const parent = asExpression.getParent();
    if (parent && parent.getKind() === SyntaxKind.ParenthesizedExpression) {
      const grandParent = parent.getParent();
      if (grandParent && grandParent.getKind() === SyntaxKind.PropertyAccessExpression) {
        // Only process if the expression is a simple identifier or property access
        return /^[a-zA-Z_$][a-zA-Z0-9_$]*(\.[a-zA-Z_$][a-zA-Z0-9_$]*)*$/.test(expressionText) &&
               !expressionText.includes("(") && // No function calls
               !expressionText.includes("[") && // No array access
               !expressionText.includes("await") && // No async operations
               !expressionText.includes("import"); // No dynamic imports
      }
    }
    return false;
  }

  private applySimpleFix(asExpression: AsExpression, filePath: string, expressionText: string, pattern: string): void {
    const before = asExpression.getText();
    
    // Simple replacement - remove the 'as unknown' cast
    asExpression.replaceWithText(expressionText);
    
    this.recordTransformation(filePath, before, expressionText, pattern);
  }

  private recordTransformation(filePath: string, before: string, after: string, pattern: string): void {
    this.transformations.push({
      file: filePath.replace(process.cwd() + "/", ""),
      line: 0,
      before,
      after,
      pattern
    });
    
    console.log(`✅ Fixed: ${before} → ${after} (${pattern})`);
  }

  private generateReport(): void {
    console.log(`\n📊 Enhanced Safe AST Transformation Report`);
    console.log(`==========================================`);
    console.log(`Total transformations: ${this.transformations.length}`);
    
    const byPattern = this.transformations.reduce((acc, t) => {
      acc[t.pattern] = (acc[t.pattern] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    console.log(`\n🔧 By pattern:`);
    Object.entries(byPattern).forEach(([pattern, count]) => {
      console.log(`  ${pattern}: ${count}`);
    });

    // Save detailed report
    const reportPath = "./enhanced-safe-transformation-report.json";
    writeFileSync(reportPath, JSON.stringify(this.transformations, null, 2));
    console.log(`\n📄 Detailed report saved to: ${reportPath}`);
  }
}

// Run the fixer
async function main() {
  const fixer = new EnhancedSafeAsUnknownFixer();
  await fixer.execute();
}

if (import.meta.main) {
  main().catch(console.error);
} 
