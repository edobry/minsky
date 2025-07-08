#!/usr/bin/env bun

import { SyntaxKind } from "ts-morph";
import { TypeScriptErrorCodemod } from "./utils/specialized-codemods";

/**
 * TS2345 Argument Error Codemod
 * 
 * Fixes TypeScript TS2345 "Argument of type 'X' is not assignable to parameter of type 'Y'" errors
 * using targeted AST-based analysis and transformations for specific patterns.
 */
class TS2345ArgumentErrorCodemod extends TypeScriptErrorCodemod {
  protected errorCode = "TS2345";
  protected errorDescription = "Argument of type 'X' is not assignable to parameter of type 'Y'";
  protected targetPatterns = [
    "non-null assertion removal",
    "missing object property addition",
    "parameter type casting",
    "argument type validation"
  ];

  /**
   * Apply TS2345-specific fixes to a source file
   */
  protected applyErrorSpecificFixesSync(sourceFile: any, fileName: string): number {
    let totalChanges = 0;

    // Fix 1: cli-bridge.ts - Add null check before addCommand
    if (fileName === 'cli-bridge.ts') {
      totalChanges += this.fixCliAddCommandNullChecks(sourceFile);
    }

    // Fix 2: git.ts - Add missing workdir property to clone call
    if (fileName === 'git.ts') {
      totalChanges += this.fixGitCloneWorkdirProperty(sourceFile);
    }

    return totalChanges;
  }

  /**
   * Fix cli-bridge.ts - Remove unnecessary non-null assertions in addCommand calls
   */
  private fixCliAddCommandNullChecks(sourceFile: any): number {
    let changes = 0;
    const ifStatements = sourceFile.getDescendantsOfKind(SyntaxKind.IfStatement);
    
    for (const ifStmt of ifStatements) {
      const condition = ifStmt.getExpression();
      
      // Look for if (childCommand) statements
      if (condition.getKind() === SyntaxKind.Identifier && 
          condition.getText() === 'childCommand') {
       
        const thenStatement = ifStmt.getThenStatement();
        if (thenStatement.getKind() === SyntaxKind.Block) {
          const block = thenStatement.asKindOrThrow(SyntaxKind.Block);
          const statements = block.getStatements();
          
          // Look for addCommand calls that need fixing
          for (const stmt of statements) {
            if (stmt.getKind() === SyntaxKind.ExpressionStatement) {
              const expr = stmt.asKindOrThrow(SyntaxKind.ExpressionStatement).getExpression();
              
              // Check if it's a call expression to addCommand with non-null assertion
              if (expr.getKind() === SyntaxKind.CallExpression) {
                const callExpr = expr.asKindOrThrow(SyntaxKind.CallExpression);
                const callText = callExpr.getText();
                
                // Look for addCommand calls with non-null assertion
                if (callText.includes('addCommand(childCommand!)')) {
                  // Replace childCommand! with just childCommand since we're inside an if(childCommand) block
                  const newText = callText.replace('childCommand!', 'childCommand');
                  if (this.safeReplace(callExpr, newText, "addCommand non-null assertion removal")) {
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

  /**
   * Fix git.ts - Add missing workdir property to clone call
   */
  private fixGitCloneWorkdirProperty(sourceFile: any): number {
    let changes = 0;
    const functions = sourceFile.getDescendantsOfKind(SyntaxKind.FunctionDeclaration);
    
    for (const func of functions) {
      if (func.getName() === 'cloneFromParams') {
        // Find the git.clone call
        const callExpressions = func.getDescendantsOfKind(SyntaxKind.CallExpression);
        
        for (const callExpr of callExpressions) {
          const expression = callExpr.getExpression();
          
          // Check if this is a git.clone() call
          if (expression.getKind() === SyntaxKind.PropertyAccessExpression) {
            const propAccess = expression.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
            
            if (propAccess.getName() === 'clone') {
              const args = callExpr.getArguments();
              
              if (args.length === 1 && args[0].getKind() === SyntaxKind.ObjectLiteralExpression) {
                const objLiteral = args[0].asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
                const properties = objLiteral.getProperties();
                
                // Check if workdir property is missing
                const hasWorkdir = properties.some(prop => 
                  prop.getKind() === SyntaxKind.PropertyAssignment &&
                  prop.asKindOrThrow(SyntaxKind.PropertyAssignment).getName() === 'workdir'
                );
                
                if (!hasWorkdir) {
                  // Add workdir property after repoUrl
                  const repoUrlProp = properties.find(prop => 
                    prop.getKind() === SyntaxKind.PropertyAssignment &&
                    prop.asKindOrThrow(SyntaxKind.PropertyAssignment).getName() === 'repoUrl'
                  );
                  
                  if (repoUrlProp) {
                    const repoUrlIndex = properties.indexOf(repoUrlProp);
                    try {
                      objLiteral.insertPropertyAssignment(repoUrlIndex + 1, {
                        name: 'workdir',
                        initializer: '(params as any).workdir'
                      });
                      
                      changes++;
                      console.log(`    ✅ Added missing workdir property to git.clone call`);
                    } catch (error) {
                      console.log(`    ⚠️  Failed to add workdir property: ${error}`);
                    }
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
  const codemod = new TS2345ArgumentErrorCodemod();
  codemod.run();
} 
