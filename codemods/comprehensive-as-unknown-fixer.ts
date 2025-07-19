#!/usr/bin/env bun

/**
 * Comprehensive 'as unknown' Assertion Fixer for Task #280
 * 
 * A single, extensible codemod following codemod-development-standards:
 * - Test-driven development with comprehensive coverage
 * - Structure-aware AST manipulation using ts-morph
 * - Comprehensive documentation and reporting
 * - Iteratively enhanced with discovered patterns
 * 
 * Patterns Handled:
 * 1. Session Object Property Access: (sessionProvider as unknown)!.method
 * 2. Dynamic Import Patterns: ((await import("module")) as unknown).Class
 * 3. Config Object Patterns: (config as unknown).property
 * 4. Error Handling Patterns: (error as unknown).property
 * 5. Provider/Service Patterns: (serviceProvider as unknown).method
 * 6. Redundant Cast Patterns: (value as unknown) as Type
 * 7. Promise Return Patterns: Promise.resolve(value) as unknown
 * 8. Simple Variable Patterns: (variable as unknown)
 */

import { Project, SourceFile, SyntaxKind, AsExpression, Node } from "ts-morph";
import { writeFileSync } from "fs";
import { glob } from "glob";

export interface TransformationResult {
  pattern: string;
  before: string;
  after: string;
  line: number;
  file: string;
}

export interface PatternFixResult {
  transformations: TransformationResult[];
  success: boolean;
  errors: string[];
}

export interface ComprehensiveReport {
  timestamp: string;
  totalFiles: number;
  filesModified: number;
  totalTransformations: number;
  patternBreakdown: Record<string, number>;
  transformations: TransformationResult[];
  errors: string[];
}

export class ComprehensiveAsUnknownFixer {
  private project: Project;
  private transformations: TransformationResult[] = [];
  private errors: string[] = [];

  constructor(project?: Project) {
    this.project = project || new Project({
      tsConfigFilePath: "./tsconfig.json",
    });
  }

  /**
   * Main entry point - fixes all patterns across the codebase
   */
  public async fixAllFiles(): Promise<ComprehensiveReport> {
    console.log("🔧 Starting comprehensive 'as unknown' fixes...");
    
    const files = await glob("src/**/*.ts", { 
      ignore: ["**/*.test.ts", "**/*.spec.ts", "**/node_modules/**", "**/*.d.ts"] 
    });
    
    let filesModified = 0;
    for (const filePath of files) {
      try {
        const sourceFile = this.project.addSourceFileAtPath(filePath);
        const initialTransformationCount = this.transformations.length;
        
        this.fixAllPatterns(sourceFile);
        
        if (this.transformations.length > initialTransformationCount) {
          filesModified++;
        }
      } catch (error) {
        this.errors.push(`Failed to process ${filePath}: ${error}`);
      }
    }
    
    await this.project.save();
    return this.generateReport(files.length, filesModified);
  }

  /**
   * Fixes all patterns in a single source file
   */
  public fixAllPatterns(sourceFile: SourceFile): TransformationResult[] {
    const initialCount = this.transformations.length;
    
    // Apply all pattern fixes in order of safety/specificity
    this.fixSessionObjectPatterns(sourceFile);
    this.fixDynamicImportPatterns(sourceFile);
    this.fixConfigObjectPatterns(sourceFile);
    this.fixErrorHandlingPatterns(sourceFile);
    this.fixProviderServicePatterns(sourceFile);
    this.fixRedundantCastPatterns(sourceFile);
    this.fixPromiseReturnPatterns(sourceFile);
    this.fixSimpleVariablePatterns(sourceFile);
    
    // NEW PHASE 6 patterns for remaining assertions
    this.fixConstructorCallPatterns(sourceFile);
    this.fixMockObjectPatterns(sourceFile);
    this.fixConditionalCheckPatterns(sourceFile);
    this.fixLogAndResultPatterns(sourceFile);
    this.fixRemainingSimplePatterns(sourceFile);
    
    return this.transformations.slice(initialCount);
  }

  /**
   * Pattern 1: Session Object Property Access with Non-Null Assertion
   * Fixes: (sessionProvider as unknown)!.method → sessionProvider.method
   */
  public fixSessionObjectPatterns(sourceFile: SourceFile): TransformationResult[] {
    const initialCount = this.transformations.length;
    const candidates: Array<{ node: Node, varName: string, propertyName: string, before: string, after: string }> = [];
    
    // Recursive function to find AsExpression anywhere in the tree
    const findAsExpression = (node: Node): Node | null => {
      if (Node.isAsExpression(node)) {
        return node;
      }
      for (const child of node.getChildren()) {
        const found = findAsExpression(child);
        if (found) return found;
      }
      return null;
    };
    
    // First pass: collect transformation candidates
    sourceFile.forEachDescendant((node) => {
      if (Node.isPropertyAccessExpression(node)) {
        const expression = node.getExpression();
        
        // Look for: (sessionXxx as unknown)! (with any nesting)
        if (Node.isNonNullExpression(expression)) {
          const innerExpr = expression.getExpression();
          const asExpr = findAsExpression(innerExpr);
          
          if (asExpr && Node.isAsExpression(asExpr)) {
            const variable = asExpr.getExpression();
            const typeNode = asExpr.getTypeNode();
            
            if (Node.isIdentifier(variable) && 
                typeNode?.getKind() === SyntaxKind.UnknownKeyword) {
              
              const varName = variable.getText();
              if (this.isSessionObjectName(varName)) {
                const before = node.getText();
                const propertyName = node.getName();
                const after = `${varName}.${propertyName}`;
                
                candidates.push({ node, varName, propertyName, before, after });
              }
            }
          }
        }
      }
    });
    
    // Second pass: apply transformations in reverse order
    for (let i = candidates.length - 1; i >= 0; i--) {
      const { node, varName, propertyName, before, after } = candidates[i];
      
      this.recordTransformation({
        pattern: "session-object-non-null",
        before,
        after,
        line: node.getStartLineNumber(),
        file: sourceFile.getFilePath()
      });
      
      // Replace the entire property access: (sessionXxx as unknown)!.prop → sessionXxx.prop
      node.replaceWithText(after);
    }
    
    return this.transformations.slice(initialCount);
  }

  /**
   * Pattern 2: Dynamic Import Patterns
   * Fixes: ((await import("./module")) as unknown).Class → (await import("./module")).Class
   * Only for relative imports (safe)
   */
  public fixDynamicImportPatterns(sourceFile: SourceFile): TransformationResult[] {
    const initialCount = this.transformations.length;
    const candidates: Array<{ node: Node, awaitExpr: string, propertyName: string, before: string, after: string }> = [];
    
    // Recursive function to find AsExpression anywhere in the tree
    const findAsExpression = (node: Node): Node | null => {
      if (Node.isAsExpression(node)) {
        return node;
      }
      for (const child of node.getChildren()) {
        const found = findAsExpression(child);
        if (found) return found;
      }
      return null;
    };
    
    // First pass: collect transformation candidates
    sourceFile.forEachDescendant((node) => {
      if (Node.isPropertyAccessExpression(node)) {
        const expression = node.getExpression();
        
        // Look for AsExpression anywhere in the tree
        const asExpr = findAsExpression(expression);
        if (asExpr && Node.isAsExpression(asExpr)) {
          const innerExpr = asExpr.getExpression();
          const typeNode = asExpr.getTypeNode();
          
          if (typeNode?.getKind() === SyntaxKind.UnknownKeyword) {
            // Handle both direct AwaitExpression and ParenthesizedExpression containing AwaitExpression
            let awaitExpr: Node | null = null;
            
            if (Node.isAwaitExpression(innerExpr)) {
              awaitExpr = innerExpr;
            } else if (Node.isParenthesizedExpression(innerExpr)) {
              const parenInner = innerExpr.getExpression();
              if (Node.isAwaitExpression(parenInner)) {
                awaitExpr = parenInner;
              }
            }
            
            if (awaitExpr && Node.isAwaitExpression(awaitExpr)) {
              const awaitedExpr = awaitExpr.getExpression();
              if (Node.isCallExpression(awaitedExpr)) {
                const callExpr = awaitedExpr.getExpression();
                if (Node.isIdentifier(callExpr) && callExpr.getText() === "import") {
                  
                  const args = awaitedExpr.getArguments();
                  if (args.length === 1 && Node.isStringLiteral(args[0])) {
                    const importPath = args[0].getLiteralValue();
                    
                    // Only fix relative imports (safer)
                    if (importPath.startsWith("./") || importPath.startsWith("../")) {
                      const before = node.getText();
                      const propertyName = node.getName();
                      const awaitExprText = awaitExpr.getText();
                      const after = `(${awaitExprText}).${propertyName}`;
                      
                      candidates.push({ node, awaitExpr: awaitExprText, propertyName, before, after });
                    }
                  }
                }
              }
            }
          }
        }
      }
    });
    
    // Second pass: apply transformations in reverse order
    for (let i = candidates.length - 1; i >= 0; i--) {
      const { node, awaitExpr, propertyName, before, after } = candidates[i];
      
      this.recordTransformation({
        pattern: "dynamic-import-relative",
        before,
        after,
        line: node.getStartLineNumber(),
        file: sourceFile.getFilePath()
      });
      
      node.replaceWithText(after);
    }
    
    return this.transformations.slice(initialCount);
  }

  /**
   * Pattern 3: Config Object Patterns
   * Fixes: (config as unknown).property → config.property
   */
  public fixConfigObjectPatterns(sourceFile: SourceFile): TransformationResult[] {
    const initialCount = this.transformations.length;
    const candidates: Array<{ node: Node, varName: string, propertyName: string, before: string, after: string }> = [];
    
    // Recursive function to find AsExpression anywhere in the tree
    const findAsExpression = (node: Node): Node | null => {
      if (Node.isAsExpression(node)) {
        return node;
      }
      for (const child of node.getChildren()) {
        const found = findAsExpression(child);
        if (found) return found;
      }
      return null;
    };
    
    // First pass: collect transformation candidates
    sourceFile.forEachDescendant((node) => {
      if (Node.isPropertyAccessExpression(node)) {
        const expression = node.getExpression();
        
        // Look for direct AsExpression or nested ones
        const asExpr = findAsExpression(expression);
        if (asExpr && Node.isAsExpression(asExpr)) {
          const variable = asExpr.getExpression();
          const typeNode = asExpr.getTypeNode();
          
          if (Node.isIdentifier(variable) && 
              typeNode?.getKind() === SyntaxKind.UnknownKeyword) {
            
            const varName = variable.getText();
            if (this.isConfigObjectName(varName)) {
              const before = node.getText();
              const propertyName = node.getName();
              const after = `${varName}.${propertyName}`;
              
              candidates.push({ node, varName, propertyName, before, after });
            }
          }
        }
      }
    });
    
    // Second pass: apply transformations in reverse order
    for (let i = candidates.length - 1; i >= 0; i--) {
      const { node, varName, propertyName, before, after } = candidates[i];
      
      this.recordTransformation({
        pattern: "config-object-cast",
        before,
        after,
        line: node.getStartLineNumber(),
        file: sourceFile.getFilePath()
      });
      
      node.replaceWithText(after);
    }
    
    return this.transformations.slice(initialCount);
  }

  /**
   * Pattern 4: Error Handling Patterns
   * Fixes: (error as unknown).property → error.property
   */
  public fixErrorHandlingPatterns(sourceFile: SourceFile): TransformationResult[] {
    const initialCount = this.transformations.length;
    const candidates: Array<{ node: Node, varName: string, propertyName: string, before: string, after: string }> = [];
    
    // Recursive function to find AsExpression anywhere in the tree
    const findAsExpression = (node: Node): Node | null => {
      if (Node.isAsExpression(node)) {
        return node;
      }
      for (const child of node.getChildren()) {
        const found = findAsExpression(child);
        if (found) return found;
      }
      return null;
    };
    
    // First pass: collect transformation candidates
    sourceFile.forEachDescendant((node) => {
      if (Node.isPropertyAccessExpression(node)) {
        const expression = node.getExpression();
        
        // Look for direct AsExpression or nested ones
        const asExpr = findAsExpression(expression);
        if (asExpr && Node.isAsExpression(asExpr)) {
          const variable = asExpr.getExpression();
          const typeNode = asExpr.getTypeNode();
          
          if (Node.isIdentifier(variable) && 
              typeNode?.getKind() === SyntaxKind.UnknownKeyword) {
            
            const varName = variable.getText();
            if (this.isErrorObjectName(varName)) {
              const before = node.getText();
              const propertyName = node.getName();
              const after = `${varName}.${propertyName}`;
              
              candidates.push({ node, varName, propertyName, before, after });
            }
          }
        }
      }
    });
    
    // Second pass: apply transformations in reverse order
    for (let i = candidates.length - 1; i >= 0; i--) {
      const { node, varName, propertyName, before, after } = candidates[i];
      
      this.recordTransformation({
        pattern: "error-object-cast",
        before,
        after,
        line: node.getStartLineNumber(),
        file: sourceFile.getFilePath()
      });
      
      node.replaceWithText(after);
    }
    
    return this.transformations.slice(initialCount);
  }

  /**
   * Pattern 5: Provider/Service Patterns
   * Fixes: (serviceProvider as unknown).method → serviceProvider.method
   */
  public fixProviderServicePatterns(sourceFile: SourceFile): TransformationResult[] {
    const initialCount = this.transformations.length;
    const candidates: Array<{ node: Node, varName: string, propertyName: string, before: string, after: string }> = [];
    
    // Recursive function to find AsExpression anywhere in the tree
    const findAsExpression = (node: Node): Node | null => {
      if (Node.isAsExpression(node)) {
        return node;
      }
      for (const child of node.getChildren()) {
        const found = findAsExpression(child);
        if (found) return found;
      }
      return null;
    };
    
    // First pass: collect transformation candidates
    sourceFile.forEachDescendant((node) => {
      if (Node.isPropertyAccessExpression(node)) {
        const expression = node.getExpression();
        
        // Look for direct AsExpression or nested ones
        const asExpr = findAsExpression(expression);
        if (asExpr && Node.isAsExpression(asExpr)) {
          const variable = asExpr.getExpression();
          const typeNode = asExpr.getTypeNode();
          
          if (Node.isIdentifier(variable) && 
              typeNode?.getKind() === SyntaxKind.UnknownKeyword) {
            
            const varName = variable.getText();
            if (this.isProviderServiceName(varName)) {
              const before = node.getText();
              const propertyName = node.getName();
              const after = `${varName}.${propertyName}`;
              
              candidates.push({ node, varName, propertyName, before, after });
            }
          }
        }
      }
    });
    
    // Second pass: apply transformations in reverse order
    for (let i = candidates.length - 1; i >= 0; i--) {
      const { node, varName, propertyName, before, after } = candidates[i];
      
      this.recordTransformation({
        pattern: "provider-service-cast",
        before,
        after,
        line: node.getStartLineNumber(),
        file: sourceFile.getFilePath()
      });
      
      node.replaceWithText(after);
    }
    
    return this.transformations.slice(initialCount);
  }

  /**
   * Pattern 6: Redundant Cast Patterns
   * Fixes: (value as unknown) as Type → value as Type
   */
  public fixRedundantCastPatterns(sourceFile: SourceFile): TransformationResult[] {
    const initialCount = this.transformations.length;
    const candidates: Array<{ node: Node, variable: Node, finalType: string, before: string, after: string }> = [];
    
    // First pass: collect transformation candidates
    sourceFile.forEachDescendant((node) => {
      if (Node.isAsExpression(node)) {
        const expression = node.getExpression();
        const finalTypeNode = node.getTypeNode();
        
        // Look for: (variable as unknown) as Type
        if (Node.isAsExpression(expression) && finalTypeNode) {
          const variable = expression.getExpression();
          const intermediateType = expression.getTypeNode();
          
          if (intermediateType?.getKind() === SyntaxKind.UnknownKeyword) {
            const before = node.getText();
            const finalType = finalTypeNode.getText();
            const after = `${variable.getText()} as ${finalType}`;
            
            candidates.push({ node, variable, finalType, before, after });
          }
        }
      }
    });
    
    // Second pass: apply transformations in reverse order
    for (let i = candidates.length - 1; i >= 0; i--) {
      const { node, variable, finalType, before, after } = candidates[i];
      
      this.recordTransformation({
        pattern: "redundant-double-cast",
        before,
        after,
        line: node.getStartLineNumber(),
        file: sourceFile.getFilePath()
      });
      
      node.replaceWithText(after);
    }
    
    return this.transformations.slice(initialCount);
  }

  /**
   * Pattern 7: Promise Return Patterns
   * Fixes: Promise.resolve(value) as unknown → Promise.resolve(value)
   */
  public fixPromiseReturnPatterns(sourceFile: SourceFile): TransformationResult[] {
    const initialCount = this.transformations.length;
    
    sourceFile.forEachDescendant((node) => {
      if (Node.isAsExpression(node)) {
        const expression = node.getExpression();
        const typeNode = node.getTypeNode();
        
        if (typeNode?.getKind() === SyntaxKind.UnknownKeyword &&
            Node.isCallExpression(expression)) {
          
          const callExpr = expression.getExpression();
          if (Node.isPropertyAccessExpression(callExpr)) {
            const obj = callExpr.getExpression();
            const method = callExpr.getName();
            
            if (Node.isIdentifier(obj) && obj.getText() === "Promise" &&
                (method === "resolve" || method === "reject")) {
              
              const before = node.getText();
              const after = expression.getText();
              
              this.recordTransformation({
                pattern: "promise-return-cast",
                before,
                after,
                line: node.getStartLineNumber(),
                file: sourceFile.getFilePath()
              });
              
              node.replaceWithText(after);
            }
          }
        }
      }
    });
    
    return this.transformations.slice(initialCount);
  }

  /**
   * Pattern 8: Simple Variable Patterns
   * Fixes: (variable as unknown) → variable
   */
  public fixSimpleVariablePatterns(sourceFile: SourceFile): TransformationResult[] {
    const initialCount = this.transformations.length;
    const candidates: Array<{ node: Node, varName: string, before: string, after: string }> = [];
    
    // First pass: collect transformation candidates
    sourceFile.forEachDescendant((node) => {
      if (Node.isAsExpression(node)) {
        const expression = node.getExpression();
        const typeNode = node.getTypeNode();
        
        if (Node.isIdentifier(expression) && 
            typeNode?.getKind() === SyntaxKind.UnknownKeyword) {
          
          const varName = expression.getText();
          
          // Only fix simple variable names in safe contexts
          if (this.isSimpleVariableName(varName) && this.isSafeContext(node)) {
            const before = node.getText();
            const after = varName;
            
            candidates.push({ node, varName, before, after });
          }
        }
      }
    });
    
    // Second pass: apply transformations in reverse order
    for (let i = candidates.length - 1; i >= 0; i--) {
      const { node, varName, before, after } = candidates[i];
      
      this.recordTransformation({
        pattern: "simple-variable-cast",
        before,
        after,
        line: node.getStartLineNumber(),
        file: sourceFile.getFilePath()
      });
      
      node.replaceWithText(varName);
    }
    
    return this.transformations.slice(initialCount);
  }

  // Helper methods for pattern recognition
  private isSessionObjectName(name: string): boolean {
    return /^(session|sessionProvider|sessionRecord|sessionInfo|sessionDb|sessionService)$/i.test(name);
  }

  private isConfigObjectName(name: string): boolean {
    return /^(config|options|settings|params|props)$/i.test(name);
  }

  private isErrorObjectName(name: string): boolean {
    return /^(error|err|e|exception)$/i.test(name);
  }

  private isProviderServiceName(name: string): boolean {
    return /^[a-zA-Z_$][a-zA-Z0-9_$]*(Provider|Service|Backend|Manager|Handler)$/i.test(name);
  }

  private isSimpleVariableName(name: string): boolean {
    return /^(result|data|value|item|element|current|task|output|response)$/i.test(name);
  }

  private isSafeContext(node: Node): boolean {
    // Check if we're in a simple assignment or return context
    let current = node.getParent();
    
    // Look up the parent chain to find a safe context, handling ParenthesizedExpressions
    while (current) {
      if (Node.isVariableDeclaration(current) || 
          Node.isReturnStatement(current) ||
          Node.isCallExpression(current)) {
        return true;
      }
      
      // Skip over ParenthesizedExpressions to check their parents
      if (Node.isParenthesizedExpression(current)) {
        current = current.getParent();
        continue;
      }
      
      // Stop at statement boundaries
      if (Node.isStatement(current)) {
        break;
      }
      
      current = current.getParent();
    }
    
    return false;
  }

  private recordTransformation(transformation: TransformationResult): void {
    this.transformations.push(transformation);
  }

  private generateReport(totalFiles: number, filesModified: number): ComprehensiveReport {
    const patternBreakdown: Record<string, number> = {};
    this.transformations.forEach(t => {
      patternBreakdown[t.pattern] = (patternBreakdown[t.pattern] || 0) + 1;
    });

    const report: ComprehensiveReport = {
      timestamp: new Date().toISOString(),
      totalFiles,
      filesModified,
      totalTransformations: this.transformations.length,
      patternBreakdown,
      transformations: this.transformations,
      errors: this.errors
    };

    const reportPath = "comprehensive-as-unknown-report.json";
    writeFileSync(reportPath, JSON.stringify(report, null, 2));

    console.log(`\n✅ Comprehensive 'as unknown' fixes completed!`);
    console.log(`📊 Total transformations: ${this.transformations.length}`);
    console.log(`📁 Files modified: ${filesModified}/${totalFiles}`);
    console.log(`📋 Pattern breakdown:`);
    
    Object.entries(patternBreakdown).forEach(([pattern, count]) => {
      console.log(`   ${pattern}: ${count}`);
    });
    
    if (this.errors.length > 0) {
      console.log(`⚠️  Errors: ${this.errors.length}`);
      this.errors.forEach(error => console.log(`   ${error}`));
    }
    
    console.log(`📄 Full report: ${reportPath}`);

    return report;
  }

  /**
   * PHASE 6: Additional Pattern Methods for Remaining Assertions
   * Added to handle the specific patterns found in the remaining 102 'as unknown' assertions
   */

  fixConstructorCallPatterns(sourceFile: SourceFile): void {
    const candidates: Array<{ node: AsExpression, before: string, after: string }> = [];
    
    // First pass: collect transformation candidates
    sourceFile.forEachDescendant((node) => {
      if (Node.isAsExpression(node)) {
        const typeNode = node.getTypeNode();
        if (typeNode?.getKind() === SyntaxKind.UnknownKeyword) {
          const parent = node.getParent();
          
          // Check if direct child of NewExpression or in CallExpression that's part of constructor
          if (Node.isNewExpression(parent)) {
            // Direct constructor call: new CommandMapper(mockServer as unknown, ...)
            const before = node.getText();
            const after = node.getExpression().getText();
            candidates.push({ node, before, after });
          } else if (Node.isCallExpression(parent)) {
            const grandparent = parent.getParent();
            const functionName = parent.getExpression().getText();
            if (Node.isNewExpression(grandparent) || 
                functionName.includes("Service") ||
                functionName.includes("Backend") ||
                functionName.includes("TaskService") ||
                functionName.includes("GitHubIssuesTaskBackend")) {
              
              const before = node.getText();
              const after = node.getExpression().getText();
              candidates.push({ node, before, after });
            }
          }
        }
      }
    });
    
    // Second pass: apply transformations in reverse order
    for (let i = candidates.length - 1; i >= 0; i--) {
      const { node, before, after } = candidates[i];
      
      this.recordTransformation({
        pattern: "constructor-call-cast",
        before,
        after,
        line: node.getStartLineNumber(),
        file: sourceFile.getFilePath()
      });
      
      node.replaceWithText(after);
    }
  }

  fixMockObjectPatterns(sourceFile: SourceFile): void {
    const candidates: Array<{ node: AsExpression, before: string, after: string }> = [];
    
    // First pass: collect transformation candidates
    sourceFile.forEachDescendant((node) => {
      if (Node.isAsExpression(node)) {
        const typeNode = node.getTypeNode();
        if (typeNode?.getKind() === SyntaxKind.UnknownKeyword) {
          const expression = node.getExpression();
          const expressionText = expression.getText();
          
          if (expressionText.startsWith("mock") || expressionText.includes("Mock")) {
            const parent = node.getParent();
            
            // Handle mock patterns in PropertyAssignment, NewExpression, ParenthesizedExpression, CallExpression
            if (Node.isPropertyAssignment(parent) || 
                Node.isNewExpression(parent) ||
                Node.isParenthesizedExpression(parent) ||
                Node.isCallExpression(parent)) {
              
              const before = node.getText();
              const after = expressionText;
              candidates.push({ node, before, after });
            }
          }
        }
      }
    });
    
    // Second pass: apply transformations in reverse order
    for (let i = candidates.length - 1; i >= 0; i--) {
      const { node, before, after } = candidates[i];
      
      this.recordTransformation({
        pattern: "mock-object-cast",
        before,
        after,
        line: node.getStartLineNumber(),
        file: sourceFile.getFilePath()
      });
      
      node.replaceWithText(after);
    }
  }



  fixConditionalCheckPatterns(sourceFile: SourceFile): void {
    const candidates: Array<{ node: AsExpression, before: string, after: string }> = [];
    
    // First pass: collect transformation candidates
    sourceFile.forEachDescendant((node) => {
      if (Node.isAsExpression(node)) {
        const typeNode = node.getTypeNode();
        if (typeNode?.getKind() === SyntaxKind.UnknownKeyword) {
          const parent = node.getParent();
          
          // Check direct BinaryExpression parent or through ParenthesizedExpression
          let binaryParent = parent;
          if (Node.isParenthesizedExpression(parent)) {
            binaryParent = parent.getParent();
          }
          
          if (Node.isBinaryExpression(binaryParent) && 
              binaryParent.getOperatorToken().getKind() === SyntaxKind.InKeyword) {
            const before = node.getText();
            const after = node.getExpression().getText();
            candidates.push({ node, before, after });
          }
        }
      }
    });
    
    // Second pass: apply transformations in reverse order
    for (let i = candidates.length - 1; i >= 0; i--) {
      const { node, before, after } = candidates[i];
      
      this.recordTransformation({
        pattern: "conditional-check-cast",
        before,
        after,
        line: node.getStartLineNumber(),
        file: sourceFile.getFilePath()
      });
      
      node.replaceWithText(after);
    }
  }

  fixLogAndResultPatterns(sourceFile: SourceFile): void {
    const candidates: Array<{ node: AsExpression, before: string, after: string }> = [];
    
    // First pass: collect transformation candidates
    sourceFile.forEachDescendant((node) => {
      if (Node.isAsExpression(node)) {
        const typeNode = node.getTypeNode();
        if (typeNode?.getKind() === SyntaxKind.UnknownKeyword) {
          const parent = node.getParent();
          
          if (Node.isCallExpression(parent)) {
            const functionText = parent.getExpression().getText();
            if (functionText.includes("log") || functionText.includes("Log")) {
              const before = node.getText();
              const after = node.getExpression().getText();
              candidates.push({ node, before, after });
            }
          }
        }
      }
    });
    
    // Second pass: apply transformations in reverse order
    for (let i = candidates.length - 1; i >= 0; i--) {
      const { node, before, after } = candidates[i];
      
      this.recordTransformation({
        pattern: "log-result-cast",
        before,
        after,
        line: node.getStartLineNumber(),
        file: sourceFile.getFilePath()
      });
      
      node.replaceWithText(after);
    }
  }

  fixRemainingSimplePatterns(sourceFile: SourceFile): void {
    const candidates: Array<{ node: AsExpression, before: string, after: string }> = [];
    
    // First pass: collect transformation candidates
    sourceFile.forEachDescendant((node) => {
      if (Node.isAsExpression(node)) {
        const typeNode = node.getTypeNode();
        if (typeNode?.getKind() === SyntaxKind.UnknownKeyword) {
          const expression = node.getExpression();
          const parent = node.getParent();
          
          // Only simple identifiers in safe contexts (including ParenthesizedExpression)
          if (Node.isIdentifier(expression) && 
              (Node.isVariableDeclaration(parent) || 
               Node.isReturnStatement(parent) ||
               Node.isPropertyAssignment(parent) ||
               Node.isCallExpression(parent) ||
               Node.isParenthesizedExpression(parent) ||
               Node.isNewExpression(parent))) {
            
            // Skip mock patterns (they're handled by mock pattern method)
            const expressionText = expression.getText();
            if (!expressionText.startsWith("mock") && !expressionText.includes("Mock")) {
              const before = node.getText();
              const after = expressionText;
              candidates.push({ node, before, after });
            }
          }
        }
      }
    });
    
    // Second pass: apply transformations in reverse order
    for (let i = candidates.length - 1; i >= 0; i--) {
      const { node, before, after } = candidates[i];
      
      this.recordTransformation({
        pattern: "remaining-simple-cast",
        before,
        after,
        line: node.getStartLineNumber(),
        file: sourceFile.getFilePath()
      });
      
      node.replaceWithText(after);
    }
  }


}

// CLI execution
async function main() {
  if (import.meta.main) {
    const fixer = new ComprehensiveAsUnknownFixer();
    await fixer.fixAllFiles();
  }
}

if (import.meta.main) {
  main().catch(console.error);
} 
