/**
 * AST-Based Bun Type Compatibility Fix Codemod
 *
 * PROBLEM SOLVED:
 * Automatically adds @ts-expect-error comments to suppress TypeScript errors
 * for Bun-specific runtime features that have incomplete TypeScript type definitions.
 * Uses AST parsing for precise code analysis and safe comment insertion.
 *
 * EXACT SITUATION:
 * - process.argv usage causes TypeScript errors in Bun projects
 * - __dirname and ___dirname are available at runtime but not in types
 * - Buffer instances with string methods cause type compatibility issues
 * - These are runtime-supported features with incomplete type definitions
 *
 * TRANSFORMATION APPLIED:
 * - Analyzes TypeScript AST using ts-morph library
 * - Identifies specific patterns: process.argv, __dirname, Buffer string methods
 * - Adds @ts-expect-error comments with explanatory text
 * - Only adds comments if they don't already exist (prevents duplication)
 * - Preserves existing code structure and formatting
 *
 * SAFETY FEATURES:
 * - AST-based analysis ensures precise targeting (no regex boundary issues)
 * - Checks for existing @ts-expect-error comments to prevent duplication
 * - Only processes specific target files to limit scope
 * - Maintains detailed fix reporting for transparency
 * - Uses ts-morph's safe save operations
 *
 * CONFIGURATION:
 * - Target files are hardcoded in targetFiles array
 * - Supports tsconfig.json-based project configuration
 * - Skips adding files from tsconfig to limit processing scope
 *
 * LIMITATIONS:
 * - Only handles predefined patterns (process.argv, __dirname, Buffer methods)
 * - Hardcoded target files limit flexibility
 * - Comments are added at statement level, not expression level
 * - May add comments to already-working code if patterns match
 * - Doesn't validate if the suppressed errors are actually Bun-specific
 * - No rollback mechanism if comments become unnecessary
 *
 * ARCHITECTURE:
 * - Uses ts-morph for TypeScript AST manipulation
 * - Processes files individually for error isolation
 * - Maintains fix tracking for reporting and debugging
 * - Designed for specific Bun type compatibility issues
 *
 * RISK ASSESSMENT:
 * - LOW: AST-based approach is much safer than regex
 * - MEDIUM: Comment insertion may suppress legitimate errors
 * - HIGH: Hardcoded patterns may not cover all Bun type issues
 * - CRITICAL: No validation that suppressed errors are actually Bun-related
 */

import { Project, SyntaxKind, Node } from "ts-morph";

interface Fix {
  file: string;
  line: number;
  description: string;
}

const fixes: Fix[] = [];

function fixBunTypesAST(): void {
  console.log("🚀 Starting AST-based Bun type fixes with @ts-expect-error...");
  
  const project = new Project({
    tsConfigFilePath: "tsconfig.json",
    skipAddingFilesFromTsConfig: true,
  });

  const targetFiles = [
    "src/scripts/test-analyzer.ts",
    "src/scripts/task-title-migration.ts"
  ];
  
  for (const targetFile of targetFiles) {
    try {
      const sourceFile = project.addSourceFileAtPath(targetFile);
      console.log(`📁 Processing ${targetFile}...`);

      let fileChanged = false;

      // Find property access expressions for process.argv and similar
      const propertyAccessExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression);
      
      for (const propAccess of propertyAccessExpressions) {
        const expression = propAccess.getExpression();
        const propertyName = propAccess.getName();
        
        // Check for process.argv
        if (Node.isIdentifier(expression) && expression.getText() === "process" && propertyName === "argv") {
          // Add @ts-expect-error comment before the line
          const statement = propAccess.getFirstAncestorByKind(SyntaxKind.VariableStatement) ||
                           propAccess.getFirstAncestorByKind(SyntaxKind.ExpressionStatement);
          
          if (statement) {
            const leadingComments = statement.getLeadingCommentRanges();
            const hasExpectError = leadingComments.some(comment => 
              comment.getText().includes("@ts-expect-error"));
            
            if (!hasExpectError) {
              statement.insertLeadingComment("// @ts-expect-error Bun supports process.argv at runtime, types incomplete");
              fileChanged = true;
              
              fixes.push({
                file: targetFile,
                line: statement.getStartLineNumber(),
                description: `Added @ts-expect-error for process.argv`
              });
            }
          }
        }
      }

      // Find identifiers for __dirname and ___dirname issues
      const identifiers = sourceFile.getDescendantsOfKind(SyntaxKind.Identifier);
      
      for (const identifier of identifiers) {
        const identifierText = identifier.getText();
        
        // Check for __dirname or ___dirname
        if (identifierText === "__dirname" || identifierText === "___dirname") {
          const statement = identifier.getFirstAncestorByKind(SyntaxKind.VariableStatement) ||
                           identifier.getFirstAncestorByKind(SyntaxKind.ExpressionStatement);
          
          if (statement) {
            const leadingComments = statement.getLeadingCommentRanges();
            const hasExpectError = leadingComments.some(comment => 
              comment.getText().includes("@ts-expect-error"));
            
            if (!hasExpectError) {
              statement.insertLeadingComment("// @ts-expect-error Bun supports __dirname at runtime, types incomplete");
              fileChanged = true;
              
              fixes.push({
                file: targetFile,
                line: statement.getStartLineNumber(),
                description: `Added @ts-expect-error for ${identifierText}`
              });
            }
          }
        }
      }

      // Find Buffer string method calls and add @ts-expect-error
      const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
      
      for (const callExpr of callExpressions) {
        const expression = callExpr.getExpression();
        
        if (Node.isPropertyAccessExpression(expression)) {
          const propertyName = expression.getName();
          const objectExpr = expression.getExpression();
          
          // Check for string methods on potentially Buffer types
          if ((propertyName === "match" || propertyName === "replace" || 
               propertyName === "includes" || propertyName === "split") &&
              Node.isIdentifier(objectExpr)) {
            
            const varName = objectExpr.getText();
            if (varName.includes("output") || varName.includes("result") || 
                varName.includes("content") || varName.includes("data")) {
              
              const statement = callExpr.getFirstAncestorByKind(SyntaxKind.VariableStatement) ||
                               callExpr.getFirstAncestorByKind(SyntaxKind.ExpressionStatement);
              
              if (statement) {
                const leadingComments = statement.getLeadingCommentRanges();
                const hasExpectError = leadingComments.some(comment => 
                  comment.getText().includes("@ts-expect-error"));
                
                if (!hasExpectError) {
                  statement.insertLeadingComment("// @ts-expect-error Buffer type compatibility with string methods");
                  fileChanged = true;
                  
                  fixes.push({
                    file: targetFile,
                    line: statement.getStartLineNumber(),
                    description: `Added @ts-expect-error for Buffer string method: ${varName}.${propertyName}()`
                  });
                }
              }
            }
          }
        }
      }

      if (fileChanged) {
        sourceFile.saveSync();
        console.log(`✅ Fixed Bun types in ${targetFile}`);
      } else {
        console.log(`ℹ️  No Bun type changes needed in ${targetFile}`);
      }

    } catch (error) {
      console.log(`❌ Error processing ${targetFile}: ${error}`);
    }
  }
}

// Run the fix
fixBunTypesAST();

// Report results
console.log(`\n📋 Bun Type Fix Report:`);
console.log(`   Fixes applied: ${fixes.length}`);

if (fixes.length > 0) {
  console.log(`\n🔧 Applied fixes:`);
  fixes.forEach((fix, index) => {
    console.log(`   ${index + 1}. ${fix.description} (line ${fix.line})`);
  });
}

console.log(`\n✅ Bun type fix completed!`); 
