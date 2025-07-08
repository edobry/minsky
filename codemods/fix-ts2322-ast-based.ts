#!/usr/bin/env bun

import { Project, SyntaxKind, Node } from "ts-morph";
import { writeFile } from "fs/promises";

interface TypeAssignmentFix {
  file: string;
  line: number;
  change: string;
  fixed: boolean;
  error?: string;
}

async function fixTypeAssignmentsAST(): Promise<void> {
  const project = new Project({
    tsConfigFilePath: "./tsconfig.json",
  });

  const fixes: TypeAssignmentFix[] = [];
  let totalChanges = 0;

  console.log("🔧 Starting AST-based TS2322 type assignment fixes...");

  // Get all source files except test utilities and scripts
  const sourceFiles = project.getSourceFiles([
    "src/**/*.ts",
    "!src/**/*.test.ts",
    "!src/**/*.spec.ts",
    "!src/scripts/**",
    "!src/utils/test-utils/**",
  ]);

  for (const sourceFile of sourceFiles) {
    const filePath = sourceFile.getFilePath();
    console.log(`Processing ${filePath}...`);

    try {
      let hasChanges = false;

      // Fix 1: Convert null returns to undefined returns
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
              expression.replaceWithText("undefined");
              hasChanges = true;
              totalChanges++;
              console.log(`    ✅ Fixed null → undefined return`);
            }
          }
        }
      }

      // Fix 2: Fix Buffer assignments to string variables
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
                  awaitExpr.replaceWithText(`(${awaitExpr.getText()}).toString()`);
                  hasChanges = true;
                  totalChanges++;
                  console.log(`    ✅ Fixed Buffer → string for ${varDecl.getName()}`);
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
                callExpr.replaceWithText(`${callExpr.getText()}.toString()`);
                hasChanges = true;
                totalChanges++;
                console.log(`    ✅ Fixed Buffer → string for ${varDecl.getName()}`);
              }
            }
          }
        }
      }

      // Fix 3: Convert unknown[] to string[] with type assertion
      const asExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.AsExpression);
      for (const asExpr of asExpressions) {
        const typeNode = asExpr.getTypeNode();
        if (typeNode && typeNode.getText() === "unknown[]") {
          typeNode.replaceWithText("string[]");
          hasChanges = true;
          totalChanges++;
          console.log(`    ✅ Fixed unknown[] → string[] type assertion`);
        }
      }

      // Fix 4: Fix string literals assigned to enum types
      const propertyAssignments = sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAssignment);
      for (const propAssign of propertyAssignments) {
        const name = propAssign.getName();
        if (name === "status") {
          const initializer = propAssign.getInitializer();
          if (initializer && initializer.getKind() === SyntaxKind.StringLiteral) {
            const stringValue = initializer.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue();
            if (["OPEN", "CLOSED", "IN_PROGRESS", "COMPLETED"].includes(stringValue)) {
              initializer.replaceWithText(`TaskStatus.${stringValue}`);
              hasChanges = true;
              totalChanges++;
              console.log(`    ✅ Fixed string → TaskStatus.${stringValue}`);
            }
          }
        }
      }

      // Fix 5: Fix wrong return types (object returned instead of array)
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
                  expression.replaceWithText(tasksValue.getText());
                  hasChanges = true;
                  totalChanges++;
                  console.log(`    ✅ Fixed wrong return type (object → array)`);
                }
              }
            }
          }
        }
      }

      // Fix 6: Fix null assignments to undefined variables
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
                    right.replaceWithText("undefined");
                    hasChanges = true;
                    totalChanges++;
                    console.log(`    ✅ Fixed null assignment → undefined`);
                  }
                }
              }
            }
          }
        }
      }

      // Save changes
      if (hasChanges) {
        await sourceFile.save();
        fixes.push({
          file: filePath,
          line: 0,
          change: "AST-based TS2322 fixes",
          fixed: true,
        });
      }

    } catch (error) {
      console.error(`❌ Error processing ${filePath}:`, error);
      fixes.push({
        file: filePath,
        line: 0,
        change: "failed",
        fixed: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Generate report
  const reportPath = "./ts2322-ast-fixes-report.json";
  const report = {
    timestamp: new Date().toISOString(),
    totalChanges,
    totalFiles: sourceFiles.length,
    fixes: fixes.sort((a, b) => a.file.localeCompare(b.file)),
    summary: {
      successful: fixes.filter(f => f.fixed).length,
      failed: fixes.filter(f => !f.fixed).length,
      filesProcessed: sourceFiles.length,
      approach: "AST-based transformations with ts-morph",
    },
  };

  await writeFile(reportPath, JSON.stringify(report, null, 2));

  console.log(`\n📊 AST-based TS2322 Fix Summary:`);
  console.log(`   Total changes: ${totalChanges}`);
  console.log(`   Files processed: ${sourceFiles.length}`);
  console.log(`   Successful fixes: ${report.summary.successful}`);
  console.log(`   Failed fixes: ${report.summary.failed}`);
  console.log(`   Approach: ${report.summary.approach}`);
  console.log(`   Report saved to: ${reportPath}`);
}

// Run the fix
fixTypeAssignmentsAST().catch(console.error); 
