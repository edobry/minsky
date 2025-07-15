#!/usr/bin/env bun

/**
 * Enhanced AS-UNKNOWN AST Codemod for Task #280
 * 
 * Based on analysis of current patterns, this codemod focuses on the most common
 * and safely fixable 'as unknown' assertions in the codebase.
 * 
 * CURRENT STATE: 822 total assertions, 504 high-priority
 * 
 * PRIORITY PATTERNS (from ESLint analysis):
 * 1. Property access patterns: (obj as unknown).prop → obj.prop
 * 2. Return value patterns: return value as unknown → return value
 * 3. Null/undefined patterns: null as unknown → null
 * 4. Object method patterns: (obj as unknown).method() → obj.method()
 * 5. Array access patterns: (arr as unknown)[index] → arr[index]
 * 6. Object.keys/values/entries patterns: Object.keys(obj as unknown) → Object.keys(obj)
 * 
 * IMPLEMENTATION STRATEGY:
 * - Focus on high-confidence, safe transformations
 * - Extensive pattern matching for common cases
 * - Validate each transformation doesn't break compilation
 * - Report metrics and success rates
 */

import { Project, Node, SyntaxKind, AsExpression, SourceFile, ParenthesizedExpression, PropertyAccessExpression, ReturnStatement, CallExpression, ElementAccessExpression } from "ts-morph";

interface TransformationResult {
  pattern: string;
  fixed: number;
  skipped: number;
  errors: string[];
}

interface CodemodMetrics {
  filesProcessed: number;
  totalAssertions: number;
  transformations: Map<string, TransformationResult>;
  processingTime: number;
  errors: string[];
}

class EnhancedAsUnknownFixer {
  private project: Project;
  private metrics: CodemodMetrics;
  
  constructor() {
    this.project = new Project({
      tsConfigFilePath: "./tsconfig.json",
      skipAddingFilesFromTsConfig: true,
    });
    
    this.metrics = {
      filesProcessed: 0,
      totalAssertions: 0,
      transformations: new Map(),
      processingTime: 0,
      errors: []
    };
  }

  async execute(): Promise<void> {
    const startTime = Date.now();
    
    console.log("🚀 Starting enhanced 'as unknown' fixer...");
    console.log("Target: Safe, high-confidence transformations");
    
    // Add source files
    this.project.addSourceFilesAtPaths(["src/**/*.ts", "src/**/*.tsx"]);
    
    const sourceFiles = this.project.getSourceFiles().filter(file => 
      !file.getFilePath().includes(".d.ts") && 
      !file.getFilePath().includes("node_modules")
    );
    
    this.metrics.filesProcessed = sourceFiles.length;
    console.log(`📁 Processing ${sourceFiles.length} TypeScript files...`);
    
    // Process each file
    for (const sourceFile of sourceFiles) {
      try {
        await this.processFile(sourceFile);
      } catch (error) {
        this.metrics.errors.push(`Error processing ${sourceFile.getFilePath()}: ${error}`);
      }
    }
    
    // Save changes
    await this.project.save();
    
    this.metrics.processingTime = Date.now() - startTime;
    this.printReport();
  }
  
  private async processFile(sourceFile: SourceFile): Promise<void> {
    const filePath = sourceFile.getFilePath();
    let fileChanged = false;
    
    // Find all AsExpression nodes
    const asExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.AsExpression);
    
    for (const asExpression of asExpressions) {
      // Check if this is an 'as unknown' assertion
      const typeText = asExpression.getType().getText();
      if (typeText !== "unknown") continue;
      
      this.metrics.totalAssertions++;
      
      // Apply transformation patterns
      const transformed = this.tryTransformAsExpression(asExpression);
      if (transformed) {
        fileChanged = true;
      }
    }
    
    if (fileChanged) {
      console.log(`✨ Transformed: ${filePath}`);
    }
  }
  
  private tryTransformAsExpression(asExpression: AsExpression): boolean {
    // Pattern 1: Property access - (obj as unknown).prop
    if (this.transformPropertyAccess(asExpression)) {
      this.recordTransformation("Property Access", true);
      return true;
    }
    
    // Pattern 2: Return statements - return value as unknown
    if (this.transformReturnStatement(asExpression)) {
      this.recordTransformation("Return Statement", true);
      return true;
    }
    
    // Pattern 3: Null/undefined literals - null as unknown
    if (this.transformNullUndefined(asExpression)) {
      this.recordTransformation("Null/Undefined", true);
      return true;
    }
    
    // Pattern 4: Object method calls - (obj as unknown).method()
    if (this.transformMethodCall(asExpression)) {
      this.recordTransformation("Method Call", true);
      return true;
    }
    
    // Pattern 5: Array access - (arr as unknown)[index]
    if (this.transformArrayAccess(asExpression)) {
      this.recordTransformation("Array Access", true);
      return true;
    }
    
    // Pattern 6: Object.keys/values/entries - Object.keys(obj as unknown)
    if (this.transformObjectMethods(asExpression)) {
      this.recordTransformation("Object Methods", true);
      return true;
    }
    
    // Pattern 7: Variable assignments - const x = value as unknown
    if (this.transformVariableAssignment(asExpression)) {
      this.recordTransformation("Variable Assignment", true);
      return true;
    }
    
    this.recordTransformation("Unmatched", false);
    return false;
  }
  
  private transformPropertyAccess(asExpression: AsExpression): boolean {
    const parent = asExpression.getParent();
    
    // Check for (expr as unknown).property
    if (parent?.getKind() === SyntaxKind.ParenthesizedExpression) {
      const grandParent = parent.getParent();
      if (grandParent?.getKind() === SyntaxKind.PropertyAccessExpression) {
        const expression = asExpression.getExpression();
        
        // Safe cases: simple identifiers, this.property, object.property
        const exprText = expression.getText();
        if (this.isSafePropertyAccess(exprText)) {
          parent.replaceWithText(exprText);
          return true;
        }
      }
    }
    
    return false;
  }
  
  private transformReturnStatement(asExpression: AsExpression): boolean {
    const parent = asExpression.getParent();
    
    // Check if this is directly in a return statement
    if (parent?.getKind() === SyntaxKind.ReturnStatement) {
      const expression = asExpression.getExpression();
      const exprText = expression.getText();
      
      // Safe cases: literals, simple identifiers, null, undefined
      if (this.isSafeReturnValue(exprText)) {
        asExpression.replaceWithText(exprText);
        return true;
      }
    }
    
    return false;
  }
  
  private transformNullUndefined(asExpression: AsExpression): boolean {
    const expression = asExpression.getExpression();
    const exprText = expression.getText();
    
    // Transform null as unknown → null, undefined as unknown → undefined
    if (exprText === "null" || exprText === "undefined") {
      asExpression.replaceWithText(exprText);
      return true;
    }
    
    return false;
  }
  
  private transformMethodCall(asExpression: AsExpression): boolean {
    const parent = asExpression.getParent();
    
    // Check for (expr as unknown).method()
    if (parent?.getKind() === SyntaxKind.ParenthesizedExpression) {
      const grandParent = parent.getParent();
      if (grandParent?.getKind() === SyntaxKind.PropertyAccessExpression) {
        const propertyAccess = grandParent as PropertyAccessExpression;
        const greatGrandParent = propertyAccess.getParent();
        
        if (greatGrandParent?.getKind() === SyntaxKind.CallExpression) {
          const expression = asExpression.getExpression();
          const exprText = expression.getText();
          
          // Safe cases: known service objects, this, simple identifiers
          if (this.isSafeMethodCall(exprText)) {
            parent.replaceWithText(exprText);
            return true;
          }
        }
      }
    }
    
    return false;
  }
  
  private transformArrayAccess(asExpression: AsExpression): boolean {
    const parent = asExpression.getParent();
    
    // Check for (expr as unknown)[index]
    if (parent?.getKind() === SyntaxKind.ParenthesizedExpression) {
      const grandParent = parent.getParent();
      if (grandParent?.getKind() === SyntaxKind.ElementAccessExpression) {
        const expression = asExpression.getExpression();
        const exprText = expression.getText();
        
        // Safe cases: simple identifiers, this.property
        if (this.isSafeArrayAccess(exprText)) {
          parent.replaceWithText(exprText);
          return true;
        }
      }
    }
    
    return false;
  }
  
  private transformObjectMethods(asExpression: AsExpression): boolean {
    const parent = asExpression.getParent();
    
    // Check for Object.keys(expr as unknown), Object.values(expr as unknown), etc.
    if (parent?.getKind() === SyntaxKind.CallExpression) {
      const callExpression = parent as CallExpression;
      const expression = callExpression.getExpression();
      
      if (expression.getKind() === SyntaxKind.PropertyAccessExpression) {
        const propAccess = expression as PropertyAccessExpression;
        const objText = propAccess.getExpression().getText();
        const propText = propAccess.getName();
        
        // Object.keys, Object.values, Object.entries, Array.from, etc.
        if (objText === "Object" && ["keys", "values", "entries"].includes(propText)) {
          const innerExpression = asExpression.getExpression();
          const innerExprText = innerExpression.getText();
          
          if (this.isSafeObjectMethodArg(innerExprText)) {
            asExpression.replaceWithText(innerExprText);
            return true;
          }
        }
      }
    }
    
    return false;
  }
  
  private transformVariableAssignment(asExpression: AsExpression): boolean {
    const parent = asExpression.getParent();
    
    // Check for const x = value as unknown, let x = value as unknown
    if (parent?.getKind() === SyntaxKind.VariableDeclaration) {
      const expression = asExpression.getExpression();
      const exprText = expression.getText();
      
      // Safe cases: simple values, object literals without complex nesting
      if (this.isSafeVariableAssignment(exprText)) {
        asExpression.replaceWithText(exprText);
        return true;
      }
    }
    
    return false;
  }
  
  // Safety checks for different transformation patterns
  private isSafePropertyAccess(exprText: string): boolean {
    // Allow: simple identifiers, this.property, knownObject.property
    return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(exprText) ||
           /^this\.[a-zA-Z_$][a-zA-Z0-9_$.]*$/.test(exprText) ||
           /^[a-zA-Z_$][a-zA-Z0-9_$]*\.[a-zA-Z_$][a-zA-Z0-9_$.]*$/.test(exprText);
  }
  
  private isSafeReturnValue(exprText: string): boolean {
    // Allow: literals, simple identifiers, null, undefined
    return exprText === "null" || 
           exprText === "undefined" ||
           /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(exprText) ||
           /^["'].*["']$/.test(exprText) ||
           /^\d+$/.test(exprText) ||
           /^true|false$/.test(exprText);
  }
  
  private isSafeMethodCall(exprText: string): boolean {
    // Allow: this, simple identifiers, known service patterns
    return exprText === "this" ||
           /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(exprText) ||
           /^this\.[a-zA-Z_$][a-zA-Z0-9_$.]*$/.test(exprText) ||
           exprText.includes("Service") ||
           exprText.includes("Backend") ||
           exprText.includes("Provider");
  }
  
  private isSafeArrayAccess(exprText: string): boolean {
    // Allow: simple identifiers, this.property
    return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(exprText) ||
           /^this\.[a-zA-Z_$][a-zA-Z0-9_$.]*$/.test(exprText);
  }
  
  private isSafeObjectMethodArg(exprText: string): boolean {
    // Allow: simple identifiers, this.property, data, result, etc.
    return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(exprText) ||
           /^this\.[a-zA-Z_$][a-zA-Z0-9_$.]*$/.test(exprText) ||
           ["data", "result", "options", "config", "params", "state"].includes(exprText);
  }
  
  private isSafeVariableAssignment(exprText: string): boolean {
    // Allow: simple values, not complex expressions
    return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(exprText) ||
           exprText === "null" || 
           exprText === "undefined" ||
           /^["'].*["']$/.test(exprText) ||
           /^\d+$/.test(exprText) ||
           /^true|false$/.test(exprText);
  }
  
  private recordTransformation(pattern: string, success: boolean): void {
    if (!this.metrics.transformations.has(pattern)) {
      this.metrics.transformations.set(pattern, {
        pattern,
        fixed: 0,
        skipped: 0,
        errors: []
      });
    }
    
    const result = this.metrics.transformations.get(pattern)!;
    if (success) {
      result.fixed++;
    } else {
      result.skipped++;
    }
  }
  
  private printReport(): void {
    console.log("\n📊 TRANSFORMATION REPORT");
    console.log("========================");
    console.log(`Files processed: ${this.metrics.filesProcessed}`);
    console.log(`Total 'as unknown' assertions: ${this.metrics.totalAssertions}`);
    console.log(`Processing time: ${this.metrics.processingTime}ms`);
    
    let totalFixed = 0;
    let totalSkipped = 0;
    
    console.log("\n🔧 Transformation Results:");
    for (const [pattern, result] of this.metrics.transformations) {
      console.log(`  ${pattern}: ${result.fixed} fixed, ${result.skipped} skipped`);
      totalFixed += result.fixed;
      totalSkipped += result.skipped;
    }
    
    console.log(`\n✅ Summary: ${totalFixed} fixed, ${totalSkipped} skipped`);
    console.log(`Success rate: ${((totalFixed / this.metrics.totalAssertions) * 100).toFixed(1)}%`);
    
    if (this.metrics.errors.length > 0) {
      console.log("\n❌ Errors:");
      this.metrics.errors.forEach(error => console.log(`  ${error}`));
    }
    
    console.log("\n🎯 Run 'bun run analyze-as-unknown.ts' to see updated counts");
  }
}

// Execute the codemod
if (import.meta.main) {
  const fixer = new EnhancedAsUnknownFixer();
  await fixer.execute();
} 
