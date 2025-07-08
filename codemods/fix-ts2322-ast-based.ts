#!/usr/bin/env bun

import { SyntaxKind, Node } from "ts-morph";
import { TypeScriptErrorCodemod } from "./utils/specialized-codemods";

/**
 * TS2322 Type Assignment Error Codemod
 * 
 * Fixes TypeScript TS2322 "Type 'X' is not assignable to type 'Y'" errors
 * using comprehensive AST-based analysis and transformations.
 */
class TS2322TypeAssignmentCodemod extends TypeScriptErrorCodemod {
  protected errorCode = "TS2322";
  protected errorDescription = "Type 'X' is not assignable to type 'Y'";
  protected targetPatterns = [
    "null → undefined return",
    "Buffer → string conversion", 
    "unknown[] → string[] assertion",
    "string → enum conversion",
    "object → array return type",
    "null → undefined assignment"
  ];

  /**
   * Apply TS2322-specific fixes to a source file
   */
  protected applyErrorSpecificFixesSync(sourceFile: any, fileName: string): number {
    let totalChanges = 0;

    // Fix 1: Convert null returns to undefined returns
    totalChanges += this.fixNullReturnsToUndefined(sourceFile);

    // Fix 2: Fix Buffer assignments to string variables
    totalChanges += this.fixBufferToStringAssignments(sourceFile);

    // Fix 3: Convert unknown[] to string[] with type assertion
    totalChanges += this.fixUnknownArrayAssertions(sourceFile);

    // Fix 4: Fix string literals assigned to enum types
    totalChanges += this.fixStringToEnumAssignments(sourceFile);

    // Fix 5: Fix wrong return types (object returned instead of array)
    totalChanges += this.fixWrongReturnTypes(sourceFile);

    // Fix 6: Fix null assignments to undefined variables
    totalChanges += this.fixNullToUndefinedAssignments(sourceFile);

    return totalChanges;
  }

  /**
   * Fix null returns to undefined returns
   */
  private fixNullReturnsToUndefined(sourceFile: any): number {
    let changes = 0;
    const returnStatements = sourceFile.getDescendantsOfKind(SyntaxKind.ReturnStatement);
    
    for (const returnStmt of returnStatements) {
      const expression = returnStmt.getExpression();
      if (expression && expression.getKind() === SyntaxKind.NullKeyword) {
        // Check if return type suggests undefined
        const func = returnStmt.getFirstAncestorByKind(SyntaxKind.FunctionDeclaration) ||
                    returnStmt.getFirstAncestorByKind(SyntaxKind.ArrowFunction) ||
                    returnStmt.getFirstAncestorByKind(SyntaxKind.MethodDeclaration);
        
        if (func) {
          const returnType = func.getReturnTypeNode();
          if (returnType && returnType.getText().includes("undefined")) {
            if (this.safeReplace(expression, "undefined", "null → undefined return")) {
              changes++;
            }
          }
        }
      }
    }
    return changes;
  }

  /**
   * Fix Buffer assignments to string variables
   */
  private fixBufferToStringAssignments(sourceFile: any): number {
    let changes = 0;
    const variableDeclarations = sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration);
    
    for (const varDecl of variableDeclarations) {
      const initializer = varDecl.getInitializer();
      if (initializer) {
        // Check for await readFile(...) calls
        if (initializer.getKind() === SyntaxKind.AwaitExpression) {
          const awaitExpr = initializer.asKindOrThrow(SyntaxKind.AwaitExpression);
          const expression = awaitExpr.getExpression();
          
          if (expression.getKind() === SyntaxKind.CallExpression) {
            const callExpr = expression.asKindOrThrow(SyntaxKind.CallExpression);
            const callExprText = callExpr.getExpression().getText();
            
            if (callExprText === "readFile") {
              // Check if variable is typed as string
              const typeNode = varDecl.getTypeNode();
              if (typeNode && typeNode.getText().includes("string")) {
                if (this.safeReplace(awaitExpr, `(${awaitExpr.getText()}).toString()`, `Buffer → string for ${varDecl.getName()}`)) {
                  changes++;
                }
              }
            }
          }
        }
        
        // Check for readFileSync calls
        if (initializer.getKind() === SyntaxKind.CallExpression) {
          const callExpr = initializer.asKindOrThrow(SyntaxKind.CallExpression);
          const callExprText = callExpr.getExpression().getText();
          
          if (callExprText === "readFileSync") {
            const typeNode = varDecl.getTypeNode();
            if (typeNode && typeNode.getText().includes("string")) {
              if (this.safeReplace(callExpr, `${callExpr.getText()}.toString()`, `Buffer → string for ${varDecl.getName()}`)) {
                changes++;
              }
            }
          }
        }
      }
    }
    return changes;
  }

  /**
   * Convert unknown[] to string[] with type assertion
   */
  private fixUnknownArrayAssertions(sourceFile: any): number {
    let changes = 0;
    const asExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.AsExpression);
    
    for (const asExpr of asExpressions) {
      const typeNode = asExpr.getTypeNode();
      if (typeNode && typeNode.getText() === "unknown[]") {
        if (this.safeReplace(typeNode, "string[]", "unknown[] → string[] type assertion")) {
          changes++;
        }
      }
    }
    return changes;
  }

  /**
   * Fix string literals assigned to enum types
   */
  private fixStringToEnumAssignments(sourceFile: any): number {
    let changes = 0;
    const propertyAssignments = sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAssignment);
    
    for (const propAssign of propertyAssignments) {
      const name = propAssign.getName();
      if (name === "status") {
        const initializer = propAssign.getInitializer();
        if (initializer && initializer.getKind() === SyntaxKind.StringLiteral) {
          const stringValue = initializer.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue();
          if (["OPEN", "CLOSED", "IN_PROGRESS", "COMPLETED"].includes(stringValue)) {
            if (this.safeReplace(initializer, `TaskStatus.${stringValue}`, `string → TaskStatus.${stringValue}`)) {
              changes++;
            }
          }
        }
      }
    }
    return changes;
  }

  /**
   * Fix wrong return types (object returned instead of array)
   */
  private fixWrongReturnTypes(sourceFile: any): number {
    let changes = 0;
    const returnStatements = sourceFile.getDescendantsOfKind(SyntaxKind.ReturnStatement);
    
    for (const returnStmt of returnStatements) {
      const expression = returnStmt.getExpression();
      if (expression && expression.getKind() === SyntaxKind.ObjectLiteralExpression) {
        const objLiteral = expression.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
        const properties = objLiteral.getProperties();
        
        // Check if this looks like a wrong return type (has tasks property)
        const tasksProperty = properties.find(prop => 
          prop.getKind() === SyntaxKind.PropertyAssignment && 
          (prop as any).getName() === "tasks"
        );
        
        if (tasksProperty) {
          const func = returnStmt.getFirstAncestorByKind(SyntaxKind.FunctionDeclaration) ||
                      returnStmt.getFirstAncestorByKind(SyntaxKind.ArrowFunction) ||
                      returnStmt.getFirstAncestorByKind(SyntaxKind.MethodDeclaration);
          
          if (func) {
            const returnType = func.getReturnTypeNode();
            if (returnType && returnType.getText().includes("TaskStatus")) {
              // Replace with just the tasks array
              const tasksAssign = tasksProperty as any;
              const tasksValue = tasksAssign.getInitializer();
              if (tasksValue) {
                if (this.safeReplace(expression, tasksValue.getText(), "wrong return type (object → array)")) {
                  changes++;
                }
              }
            }
          }
        }
      }
    }
    return changes;
  }

  /**
   * Fix null assignments to undefined variables
   */
  private fixNullToUndefinedAssignments(sourceFile: any): number {
    let changes = 0;
    const binaryExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.BinaryExpression);
    
    for (const binExpr of binaryExpressions) {
      if (binExpr.getOperatorToken().getKind() === SyntaxKind.EqualsToken) {
        const right = binExpr.getRight();
        if (right.getKind() === SyntaxKind.NullKeyword) {
          const left = binExpr.getLeft();
          // Check if left side is a variable typed as undefined
          if (left.getKind() === SyntaxKind.Identifier) {
            const identifier = left.asKindOrThrow(SyntaxKind.Identifier);
            const symbol = identifier.getSymbol();
            if (symbol) {
              const valueDeclaration = symbol.getValueDeclaration();
              if (valueDeclaration && valueDeclaration.getKind() === SyntaxKind.VariableDeclaration) {
                const varDecl = valueDeclaration as any;
                const typeNode = varDecl.getTypeNode();
                if (typeNode && typeNode.getText().includes("undefined")) {
                  if (this.safeReplace(right, "undefined", "null assignment → undefined")) {
                    changes++;
                  }
                }
              }
            }
          }
        }
      }
    }
    return changes;
  }
}

// Run the codemod if called directly
if (import.meta.main) {
  const codemod = new TS2322TypeAssignmentCodemod();
  codemod.run();
} 
