#!/usr/bin/env bun

/**
 * Enhanced AS-UNKNOWN AST Codemod v2 for Task #280
 * 
 * Building on v1 success (166 fixes, 31.4% success rate), this version adds:
 * - More sophisticated pattern matching
 * - Additional safe transformation patterns
 * - Better context analysis
 * - Focus on the remaining 681 assertions
 * 
 * NEW PATTERNS ADDED:
 * 1. Function parameter patterns: func(param as unknown)
 * 2. Object destructuring: const { prop } = obj as unknown
 * 3. Simple comparison operations: value === (result as unknown)
 * 4. Type guard patterns: if (value as unknown)
 * 5. Error object patterns: (error as unknown).message
 * 6. Configuration patterns: (config as unknown).key
 * 7. Ternary expressions: condition ? (value as unknown) : other
 */

import { Project, SyntaxKind, AsExpression, SourceFile, ParenthesizedExpression, PropertyAccessExpression, CallExpression, ElementAccessExpression, BinaryExpression, ConditionalExpression, VariableDeclaration, BindingElement, Node } from "ts-morph";

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

class EnhancedAsUnknownFixerV2 {
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
    
    console.log("🚀 Starting enhanced 'as unknown' fixer v2...");
    console.log("Target: Additional safe patterns + improved detection");
    
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
      const typeText = asExpression.getTypeNode()?.getText();
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
    // V1 Patterns (enhanced)
    if (this.transformPropertyAccess(asExpression)) {
      this.recordTransformation("Property Access", true);
      return true;
    }
    
    if (this.transformReturnStatement(asExpression)) {
      this.recordTransformation("Return Statement", true);
      return true;
    }
    
    if (this.transformNullUndefined(asExpression)) {
      this.recordTransformation("Null/Undefined", true);
      return true;
    }
    
    if (this.transformMethodCall(asExpression)) {
      this.recordTransformation("Method Call", true);
      return true;
    }
    
    if (this.transformArrayAccess(asExpression)) {
      this.recordTransformation("Array Access", true);
      return true;
    }
    
    if (this.transformObjectMethods(asExpression)) {
      this.recordTransformation("Object Methods", true);
      return true;
    }
    
    if (this.transformVariableAssignment(asExpression)) {
      this.recordTransformation("Variable Assignment", true);
      return true;
    }
    
    // V2 New Patterns
    if (this.transformFunctionParameter(asExpression)) {
      this.recordTransformation("Function Parameter", true);
      return true;
    }
    
    if (this.transformBinaryExpression(asExpression)) {
      this.recordTransformation("Binary Expression", true);
      return true;
    }
    
    if (this.transformConditionalExpression(asExpression)) {
      this.recordTransformation("Conditional Expression", true);
      return true;
    }
    
    if (this.transformErrorPattern(asExpression)) {
      this.recordTransformation("Error Pattern", true);
      return true;
    }
    
    if (this.transformConfigPattern(asExpression)) {
      this.recordTransformation("Config Pattern", true);
      return true;
    }
    
    if (this.transformTypeGuard(asExpression)) {
      this.recordTransformation("Type Guard", true);
      return true;
    }
    
    if (this.transformDestructuring(asExpression)) {
      this.recordTransformation("Destructuring", true);
      return true;
    }
    
    this.recordTransformation("Unmatched", false);
    return false;
  }
  
  // V1 Patterns (enhanced with better safety checks)
  private transformPropertyAccess(asExpression: AsExpression): boolean {
    const parent = asExpression.getParent();
    
    if (parent?.getKind() === SyntaxKind.ParenthesizedExpression) {
      const grandParent = parent.getParent();
      if (grandParent?.getKind() === SyntaxKind.PropertyAccessExpression) {
        const expression = asExpression.getExpression();
        const exprText = expression.getText();
        
        // Enhanced safety check with more patterns
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
    
    if (parent?.getKind() === SyntaxKind.ReturnStatement) {
      const expression = asExpression.getExpression();
      const exprText = expression.getText();
      
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
    
    if (exprText === "null" || exprText === "undefined") {
      asExpression.replaceWithText(exprText);
      return true;
    }
    
    return false;
  }
  
  private transformMethodCall(asExpression: AsExpression): boolean {
    const parent = asExpression.getParent();
    
    if (parent?.getKind() === SyntaxKind.ParenthesizedExpression) {
      const grandParent = parent.getParent();
      if (grandParent?.getKind() === SyntaxKind.PropertyAccessExpression) {
        const propertyAccess = grandParent as PropertyAccessExpression;
        const greatGrandParent = propertyAccess.getParent();
        
        if (greatGrandParent?.getKind() === SyntaxKind.CallExpression) {
          const expression = asExpression.getExpression();
          const exprText = expression.getText();
          
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
    
    if (parent?.getKind() === SyntaxKind.ParenthesizedExpression) {
      const grandParent = parent.getParent();
      if (grandParent?.getKind() === SyntaxKind.ElementAccessExpression) {
        const expression = asExpression.getExpression();
        const exprText = expression.getText();
        
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
    
    if (parent?.getKind() === SyntaxKind.CallExpression) {
      const callExpression = parent as CallExpression;
      const expression = callExpression.getExpression();
      
      if (expression.getKind() === SyntaxKind.PropertyAccessExpression) {
        const propAccess = expression as PropertyAccessExpression;
        const objText = propAccess.getExpression().getText();
        const propText = propAccess.getName();
        
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
    
    if (parent?.getKind() === SyntaxKind.VariableDeclaration) {
      const expression = asExpression.getExpression();
      const exprText = expression.getText();
      
      if (this.isSafeVariableAssignment(exprText)) {
        asExpression.replaceWithText(exprText);
        return true;
      }
    }
    
    return false;
  }
  
  // V2 New Patterns
  private transformFunctionParameter(asExpression: AsExpression): boolean {
    const parent = asExpression.getParent();
    
    // Check if this is a function parameter: func(param as unknown)
    if (parent?.getKind() === SyntaxKind.CallExpression) {
      const expression = asExpression.getExpression();
      const exprText = expression.getText();
      
      // Safe parameters: simple identifiers, common parameter names
      if (this.isSafeFunctionParameter(exprText)) {
        asExpression.replaceWithText(exprText);
        return true;
      }
    }
    
    return false;
  }
  
  private transformBinaryExpression(asExpression: AsExpression): boolean {
    const parent = asExpression.getParent();
    
    // Check if this is in a binary expression: value === (result as unknown)
    if (parent?.getKind() === SyntaxKind.BinaryExpression) {
      const expression = asExpression.getExpression();
      const exprText = expression.getText();
      
      if (this.isSafeBinaryOperand(exprText)) {
        asExpression.replaceWithText(exprText);
        return true;
      }
    }
    
    return false;
  }
  
  private transformConditionalExpression(asExpression: AsExpression): boolean {
    const parent = asExpression.getParent();
    
    // Check if this is in a conditional: condition ? (value as unknown) : other
    if (parent?.getKind() === SyntaxKind.ConditionalExpression) {
      const expression = asExpression.getExpression();
      const exprText = expression.getText();
      
      if (this.isSafeConditionalValue(exprText)) {
        asExpression.replaceWithText(exprText);
        return true;
      }
    }
    
    return false;
  }
  
  private transformErrorPattern(asExpression: AsExpression): boolean {
    const parent = asExpression.getParent();
    
    // Check for error patterns: (error as unknown).message
    if (parent?.getKind() === SyntaxKind.ParenthesizedExpression) {
      const grandParent = parent.getParent();
      if (grandParent?.getKind() === SyntaxKind.PropertyAccessExpression) {
        const propAccess = grandParent as PropertyAccessExpression;
        const propName = propAccess.getName();
        
        // Common error properties
        if (["message", "stack", "name", "code", "cause"].includes(propName)) {
          const expression = asExpression.getExpression();
          const exprText = expression.getText();
          
          if (this.isSafeErrorPattern(exprText)) {
            parent.replaceWithText(exprText);
            return true;
          }
        }
      }
    }
    
    return false;
  }
  
  private transformConfigPattern(asExpression: AsExpression): boolean {
    const parent = asExpression.getParent();
    
    // Check for config patterns: (config as unknown).key
    if (parent?.getKind() === SyntaxKind.ParenthesizedExpression) {
      const grandParent = parent.getParent();
      if (grandParent?.getKind() === SyntaxKind.PropertyAccessExpression) {
        const expression = asExpression.getExpression();
        const exprText = expression.getText();
        
        if (this.isSafeConfigPattern(exprText)) {
          parent.replaceWithText(exprText);
          return true;
        }
      }
    }
    
    return false;
  }
  
  private transformTypeGuard(asExpression: AsExpression): boolean {
    const parent = asExpression.getParent();
    
    // Check for type guards: if (value as unknown)
    if (parent?.getKind() === SyntaxKind.IfStatement ||
        parent?.getKind() === SyntaxKind.WhileStatement ||
        parent?.getKind() === SyntaxKind.ConditionalExpression) {
      const expression = asExpression.getExpression();
      const exprText = expression.getText();
      
      if (this.isSafeTypeGuard(exprText)) {
        asExpression.replaceWithText(exprText);
        return true;
      }
    }
    
    return false;
  }
  
  private transformDestructuring(asExpression: AsExpression): boolean {
    const parent = asExpression.getParent();
    
    // Check for destructuring: const { prop } = obj as unknown
    if (parent?.getKind() === SyntaxKind.VariableDeclaration) {
      const varDecl = parent as VariableDeclaration;
      const nameNode = varDecl.getNameNode();
      
      if (nameNode.getKind() === SyntaxKind.ObjectBindingPattern) {
        const expression = asExpression.getExpression();
        const exprText = expression.getText();
        
        if (this.isSafeDestructuring(exprText)) {
          asExpression.replaceWithText(exprText);
          return true;
        }
      }
    }
    
    return false;
  }
  
  // Enhanced safety checks
  private isSafePropertyAccess(exprText: string): boolean {
    return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(exprText) ||
           /^this\.[a-zA-Z_$][a-zA-Z0-9_$.]*$/.test(exprText) ||
           /^[a-zA-Z_$][a-zA-Z0-9_$]*\.[a-zA-Z_$][a-zA-Z0-9_$.]*$/.test(exprText) ||
           ["result", "data", "response", "item", "value", "entity", "record"].includes(exprText);
  }
  
  private isSafeReturnValue(exprText: string): boolean {
    return exprText === "null" || 
           exprText === "undefined" ||
           /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(exprText) ||
           /^["'].*["']$/.test(exprText) ||
           /^\d+$/.test(exprText) ||
           /^true|false$/.test(exprText) ||
           ["result", "data", "output", "value"].includes(exprText);
  }
  
  private isSafeMethodCall(exprText: string): boolean {
    return exprText === "this" ||
           /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(exprText) ||
           /^this\.[a-zA-Z_$][a-zA-Z0-9_$.]*$/.test(exprText) ||
           exprText.includes("Service") ||
           exprText.includes("Backend") ||
           exprText.includes("Provider") ||
           exprText.includes("Manager") ||
           exprText.includes("Handler");
  }
  
  private isSafeArrayAccess(exprText: string): boolean {
    return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(exprText) ||
           /^this\.[a-zA-Z_$][a-zA-Z0-9_$.]*$/.test(exprText) ||
           ["items", "list", "array", "collection", "results"].includes(exprText);
  }
  
  private isSafeObjectMethodArg(exprText: string): boolean {
    return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(exprText) ||
           /^this\.[a-zA-Z_$][a-zA-Z0-9_$.]*$/.test(exprText) ||
           ["data", "result", "options", "config", "params", "state", "obj", "object", "item"].includes(exprText);
  }
  
  private isSafeVariableAssignment(exprText: string): boolean {
    return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(exprText) ||
           exprText === "null" || 
           exprText === "undefined" ||
           /^["'].*["']$/.test(exprText) ||
           /^\d+$/.test(exprText) ||
           /^true|false$/.test(exprText) ||
           ["result", "data", "value", "output", "response"].includes(exprText);
  }
  
  // V2 New safety checks
  private isSafeFunctionParameter(exprText: string): boolean {
    return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(exprText) ||
           ["params", "args", "options", "config", "data", "context", "request", "response"].includes(exprText);
  }
  
  private isSafeBinaryOperand(exprText: string): boolean {
    return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(exprText) ||
           exprText === "null" || 
           exprText === "undefined" ||
           /^["'].*["']$/.test(exprText) ||
           /^\d+$/.test(exprText) ||
           ["result", "value", "data", "status", "code"].includes(exprText);
  }
  
  private isSafeConditionalValue(exprText: string): boolean {
    return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(exprText) ||
           exprText === "null" || 
           exprText === "undefined" ||
           ["result", "value", "data", "fallback", "default"].includes(exprText);
  }
  
  private isSafeErrorPattern(exprText: string): boolean {
    return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(exprText) ||
           ["error", "err", "exception", "e", "ex"].includes(exprText);
  }
  
  private isSafeConfigPattern(exprText: string): boolean {
    return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(exprText) ||
           ["config", "options", "settings", "params", "props", "data"].includes(exprText);
  }
  
  private isSafeTypeGuard(exprText: string): boolean {
    return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(exprText) ||
           ["value", "data", "result", "item", "entity"].includes(exprText);
  }
  
  private isSafeDestructuring(exprText: string): boolean {
    return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(exprText) ||
           ["data", "result", "response", "params", "options", "config", "state"].includes(exprText);
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
    console.log("\n📊 TRANSFORMATION REPORT V2");
    console.log("============================");
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
  const fixer = new EnhancedAsUnknownFixerV2();
  await fixer.execute();
} 
