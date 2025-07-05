#!/usr/bin/env bun

import { Project, SyntaxKind } from "ts-morph";
import { writeFile } from "fs/promises";

interface TypeAssignmentFix {
  file: string;
  line: number;
  change: string;
  fixed: boolean;
  error?: string;
}

async function fixPreciseTS2322Errors(): Promise<void> {
  const project = new Project({
    tsConfigFilePath: "./tsconfig.json",
  });

  const fixes: TypeAssignmentFix[] = [];
  let totalChanges = 0;

  console.log("🔧 Starting precise AST-based TS2322 fixes...");

  // Fix 1: Variable declarations with null initializers where type is string | undefined
  const sourceFiles = project.getSourceFiles([
    "src/domain/tasks.ts",
    "src/domain/tasks/taskIO.ts",
    "src/domain/tasks/githubIssuesTaskBackend.ts",
    "src/utils/git-exec-enhanced.ts",
    "src/domain/storage/backends/error-handling.ts",
  ]);

  for (const sourceFile of sourceFiles) {
    const filePath = sourceFile.getFilePath();
    console.log(`Processing ${filePath}...`);

    try {
      let hasChanges = false;

      // Fix variable declarations with null initializers
      const variableDeclarations = sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration);
      for (const varDecl of variableDeclarations) {
        const initializer = varDecl.getInitializer();
        const typeNode = varDecl.getTypeNode();
        
        if (initializer && 
            initializer.getKind() === SyntaxKind.NullKeyword &&
            typeNode && 
            typeNode.getText().includes("undefined")) {
          
          const line = sourceFile.getLineAndColumnAtPos(varDecl.getStart()).line;
          initializer.replaceWithText("undefined");
          hasChanges = true;
          totalChanges++;
          
          console.log(`    ✅ Fixed ${varDecl.getName()} null → undefined at line ${line}`);
          fixes.push({
            file: filePath,
            line: line,
            change: `${varDecl.getName()}: null → undefined`,
            fixed: true,
          });
        }
      }

      // Fix Buffer to string conversions in specific files
      if (filePath.includes("taskIO.ts")) {
        const awaitExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.AwaitExpression);
        for (const awaitExpr of awaitExpressions) {
          const expression = awaitExpr.getExpression();
          if (expression.getKind() === SyntaxKind.CallExpression) {
            const callExpr = expression.asKindOrThrow(SyntaxKind.CallExpression);
            const funcName = callExpr.getExpression().getText();
            
            if (funcName === "readFile") {
              const parent = awaitExpr.getParent();
              if (parent && parent.getKind() === SyntaxKind.VariableDeclaration) {
                const varDecl = parent.asKindOrThrow(SyntaxKind.VariableDeclaration);
                const typeNode = varDecl.getTypeNode();
                if (typeNode && typeNode.getText().includes("string")) {
                  awaitExpr.replaceWithText(`(${awaitExpr.getText()}).toString()`);
                  hasChanges = true;
                  totalChanges++;
                  
                  const line = sourceFile.getLineAndColumnAtPos(awaitExpr.getStart()).line;
                  console.log(`    ✅ Fixed Buffer → string conversion at line ${line}`);
                  fixes.push({
                    file: filePath,
                    line: line,
                    change: "Buffer → string conversion",
                    fixed: true,
                  });
                }
              }
            }
          }
        }
      }

      // Fix string to TaskStatus enum conversions
      if (filePath.includes("githubIssuesTaskBackend.ts")) {
        const stringLiterals = sourceFile.getDescendantsOfKind(SyntaxKind.StringLiteral);
        for (const stringLiteral of stringLiterals) {
          const value = stringLiteral.getLiteralValue();
          const line = sourceFile.getLineAndColumnAtPos(stringLiteral.getStart()).line;
          
          // Check for TaskStatus values
          if (["OPEN", "CLOSED", "IN_PROGRESS", "COMPLETED", "TODO", "DONE", "BLOCKED"].includes(value)) {
            const parent = stringLiteral.getParent();
            if (parent && parent.getKind() === SyntaxKind.PropertyAssignment) {
              const propAssign = parent.asKindOrThrow(SyntaxKind.PropertyAssignment);
              const name = propAssign.getName();
              if (name === "status") {
                stringLiteral.replaceWithText(`TaskStatus.${value}`);
                hasChanges = true;
                totalChanges++;
                
                console.log(`    ✅ Fixed string → TaskStatus.${value} at line ${line}`);
                fixes.push({
                  file: filePath,
                  line: line,
                  change: `"${value}" → TaskStatus.${value}`,
                  fixed: true,
                });
              }
            }
          }
        }
      }

      // Fix unknown[] to string[] type assertions
      if (filePath.includes("git-exec-enhanced.ts")) {
        const asExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.AsExpression);
        for (const asExpr of asExpressions) {
          const typeNode = asExpr.getTypeNode();
          if (typeNode && typeNode.getText() === "unknown[]") {
            typeNode.replaceWithText("string[]");
            hasChanges = true;
            totalChanges++;
            
            const line = sourceFile.getLineAndColumnAtPos(asExpr.getStart()).line;
            console.log(`    ✅ Fixed unknown[] → string[] at line ${line}`);
            fixes.push({
              file: filePath,
              line: line,
              change: "unknown[] → string[]",
              fixed: true,
            });
          }
        }
      }

      if (hasChanges) {
        await sourceFile.save();
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
  const reportPath = "./ts2322-precise-ast-fixes-report.json";
  const report = {
    timestamp: new Date().toISOString(),
    totalChanges,
    fixes: fixes.sort((a, b) => a.file.localeCompare(b.file)),
    summary: {
      successful: fixes.filter(f => f.fixed).length,
      failed: fixes.filter(f => !f.fixed).length,
      approach: "Precise AST-based transformations for specific patterns",
    },
  };

  await writeFile(reportPath, JSON.stringify(report, null, 2));

  console.log(`\n📊 Precise AST-based TS2322 Fix Summary:`);
  console.log(`   Total changes: ${totalChanges}`);
  console.log(`   Successful fixes: ${report.summary.successful}`);
  console.log(`   Failed fixes: ${report.summary.failed}`);
  console.log(`   Approach: ${report.summary.approach}`);
  console.log(`   Report saved to: ${reportPath}`);
}

// Run the fix
fixPreciseTS2322Errors().catch(console.error); 
