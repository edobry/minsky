#!/usr/bin/env bun

/**
 * Safe AST Codemod for Task #280 - Conservative High-Priority Fixes
 * 
 * Focuses on the safest transformation patterns identified in the analysis:
 * - Simple property access without complex surrounding expressions
 * - Configuration object property access patterns
 * - Return statement patterns
 * - Variable assignment patterns
 */

import { Project, SyntaxKind, AsExpression, Node } from "ts-morph";
import { writeFileSync } from "fs";

interface TransformationResult {
  file: string;
  line: number;
  before: string;
  after: string;
  pattern: string;
}

class SafeAsUnknownFixer {
  private project: Project;
  private transformations: TransformationResult[] = [];

  constructor() {
    this.project = new Project({
      tsConfigFilePath: "./tsconfig.json",
      skipAddingFilesFromTsConfig: true,
    });
  }

  async execute(): Promise<void> {
    console.log("🚀 Starting safe 'as unknown' fixes...");
    
    // Add source files
    this.project.addSourceFilesAtPaths([
      "src/**/*.ts",
      "!src/**/*.test.ts",
      "!src/**/*.spec.ts",
      "!**/*.d.ts"
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
      // Pattern 1: Simple config property access like (config as unknown)!.title
      if (this.isSimpleConfigPropertyAccess(asExpression, fullText)) {
        this.applySimplePropertyAccessFix(asExpression, filePath, expressionText);
        return;
      }

      // Pattern 2: Return null/undefined as unknown
      if (fullText === "null as unknown" || fullText === "undefined as unknown") {
        this.applyReturnValueFix(asExpression, filePath, expressionText);
        return;
      }

      // Pattern 3: Simple variable assignment patterns
      if (this.isSimpleVariableAssignment(asExpression)) {
        this.applyVariableAssignmentFix(asExpression, filePath, expressionText);
        return;
      }

    } catch (error) {
      console.log(`⚠️  Skipped unsafe transformation in ${filePath}: ${error}`);
    }
  }

  private isSimpleConfigPropertyAccess(asExpression: AsExpression, fullText: string): boolean {
    // Look for patterns like (config as unknown)!.property or (data as unknown).property
    const parent = asExpression.getParent();
    
    // Check if the parent is a parenthesized expression followed by property access
    if (parent && parent.getKind() === SyntaxKind.ParenthesizedExpression) {
      const grandParent = parent.getParent();
      if (grandParent && grandParent.getKind() === SyntaxKind.PropertyAccessExpression) {
        // Safe config patterns
        return fullText.includes("config as unknown") ||
               fullText.includes("options as unknown") ||
               fullText.includes("data as unknown") ||
               fullText.includes("result as unknown");
      }
    }
    
    return false;
  }

  private isSimpleVariableAssignment(asExpression: AsExpression): boolean {
    const parent = asExpression.getParent();
    
    // Check if this is a simple variable assignment or return statement
    return parent && (
      parent.getKind() === SyntaxKind.VariableDeclaration ||
      parent.getKind() === SyntaxKind.ReturnStatement ||
      parent.getKind() === SyntaxKind.BinaryExpression
    );
  }

  private applySimplePropertyAccessFix(asExpression: AsExpression, filePath: string, expressionText: string): void {
    const before = asExpression.getText();
    
    // For simple property access, we can safely remove the cast
    // This transforms (config as unknown)!.title to config.title
    asExpression.replaceWithText(expressionText);
    
    this.recordTransformation(filePath, before, expressionText, "Simple Property Access");
  }

  private applyReturnValueFix(asExpression: AsExpression, filePath: string, expressionText: string): void {
    const before = asExpression.getText();
    
    // For return null/undefined, just remove the cast
    asExpression.replaceWithText(expressionText);
    
    this.recordTransformation(filePath, before, expressionText, "Return Value");
  }

  private applyVariableAssignmentFix(asExpression: AsExpression, filePath: string, expressionText: string): void {
    const before = asExpression.getText();
    
    // For simple assignments, remove the cast
    asExpression.replaceWithText(expressionText);
    
    this.recordTransformation(filePath, before, expressionText, "Variable Assignment");
  }

  private recordTransformation(filePath: string, before: string, after: string, pattern: string): void {
    this.transformations.push({
      file: filePath.replace(process.cwd() + "/", ""),
      line: 0, // We could get line numbers but for now this is fine
      before,
      after,
      pattern
    });
    
    console.log(`✅ Fixed: ${before} → ${after} (${pattern})`);
  }

  private generateReport(): void {
    console.log(`\n📊 Safe AST Transformation Report`);
    console.log(`==================================`);
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
    const reportPath = "./safe-ast-transformation-report.json";
    writeFileSync(reportPath, JSON.stringify(this.transformations, null, 2));
    console.log(`\n📄 Detailed report saved to: ${reportPath}`);
  }
}

// Run the fixer
async function main() {
  const fixer = new SafeAsUnknownFixer();
  await fixer.execute();
}

if (import.meta.main) {
  main().catch(console.error);
} 
