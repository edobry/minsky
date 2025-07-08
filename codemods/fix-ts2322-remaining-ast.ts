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

async function fixRemainingTS2322Errors(): Promise<void> {
  const project = new Project({
    tsConfigFilePath: "./tsconfig.json",
  });

  const fixes: TypeAssignmentFix[] = [];
  let totalChanges = 0;

  console.log("🔧 Starting remaining AST-based TS2322 fixes...");

  // Fix 1: workspace.ts - null to undefined (line 264)
  try {
    const workspaceFile = project.getSourceFile("src/domain/workspace.ts");
    if (workspaceFile) {
      console.log("Processing src/domain/workspace.ts...");
      
      const variableDeclarations = workspaceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration);
      for (const varDecl of variableDeclarations) {
        const initializer = varDecl.getInitializer();
        const typeNode = varDecl.getTypeNode();
        
        if (initializer && 
            initializer.getKind() === SyntaxKind.NullKeyword &&
            typeNode && 
            typeNode.getText().includes("undefined")) {
          
          const line = workspaceFile.getLineAndColumnAtPos(varDecl.getStart()).line;
          if (line === 264) {
            initializer.replaceWithText("undefined");
            totalChanges++;
            console.log(`    ✅ Fixed ${varDecl.getName()} null → undefined at line ${line}`);
            fixes.push({
              file: "src/domain/workspace.ts",
              line: line,
              change: `${varDecl.getName()}: null → undefined`,
              fixed: true,
            });
          }
        }
      }
      
      await workspaceFile.save();
    }
  } catch (error) {
    console.error("❌ Error fixing workspace.ts:", error);
  }

  // Fix 2: taskIO.ts - Buffer to string conversions (lines 28, 79)
  try {
    const taskIOFile = project.getSourceFile("src/domain/tasks/taskIO.ts");
    if (taskIOFile) {
      console.log("Processing src/domain/tasks/taskIO.ts...");
      
      const awaitExpressions = taskIOFile.getDescendantsOfKind(SyntaxKind.AwaitExpression);
      for (const awaitExpr of awaitExpressions) {
        const expression = awaitExpr.getExpression();
        if (expression.getKind() === SyntaxKind.CallExpression) {
          const callExpr = expression.asKindOrThrow(SyntaxKind.CallExpression);
          const funcName = callExpr.getExpression().getText();
          
          if (funcName === "readFile") {
            const line = taskIOFile.getLineAndColumnAtPos(awaitExpr.getStart()).line;
            if ([28, 79].includes(line)) {
              awaitExpr.replaceWithText(`(${awaitExpr.getText()}).toString()`);
              totalChanges++;
              console.log(`    ✅ Fixed Buffer → string conversion at line ${line}`);
              fixes.push({
                file: "src/domain/tasks/taskIO.ts",
                line: line,
                change: "Buffer → string conversion",
                fixed: true,
              });
            }
          }
        }
      }
      
      await taskIOFile.save();
    }
  } catch (error) {
    console.error("❌ Error fixing taskIO.ts:", error);
  }

  // Fix 3: githubIssuesTaskBackend.ts - string to TaskStatus (line 426)
  try {
    const githubFile = project.getSourceFile("src/domain/tasks/githubIssuesTaskBackend.ts");
    if (githubFile) {
      console.log("Processing src/domain/tasks/githubIssuesTaskBackend.ts...");
      
      const stringLiterals = githubFile.getDescendantsOfKind(SyntaxKind.StringLiteral);
      for (const stringLiteral of stringLiterals) {
        const value = stringLiteral.getLiteralValue();
        const line = githubFile.getLineAndColumnAtPos(stringLiteral.getStart()).line;
        
        if (line === 426 && ["OPEN", "CLOSED", "IN_PROGRESS", "COMPLETED", "TODO", "DONE", "BLOCKED"].includes(value)) {
          stringLiteral.replaceWithText(`TaskStatus.${value}`);
          totalChanges++;
          console.log(`    ✅ Fixed string → TaskStatus.${value} at line ${line}`);
          fixes.push({
            file: "src/domain/tasks/githubIssuesTaskBackend.ts",
            line: line,
            change: `"${value}" → TaskStatus.${value}`,
            fixed: true,
          });
        }
      }
      
      await githubFile.save();
    }
  } catch (error) {
    console.error("❌ Error fixing githubIssuesTaskBackend.ts:", error);
  }

  // Fix 4: git-exec-enhanced.ts - unknown[] to string[] (line 132)
  try {
    const gitExecFile = project.getSourceFile("src/utils/git-exec-enhanced.ts");
    if (gitExecFile) {
      console.log("Processing src/utils/git-exec-enhanced.ts...");
      
      const asExpressions = gitExecFile.getDescendantsOfKind(SyntaxKind.AsExpression);
      for (const asExpr of asExpressions) {
        const typeNode = asExpr.getTypeNode();
        const line = gitExecFile.getLineAndColumnAtPos(asExpr.getStart()).line;
        
        if (line === 132 && typeNode && typeNode.getText() === "unknown[]") {
          typeNode.replaceWithText("string[]");
          totalChanges++;
          console.log(`    ✅ Fixed unknown[] → string[] at line ${line}`);
          fixes.push({
            file: "src/utils/git-exec-enhanced.ts",
            line: line,
            change: "unknown[] → string[]",
            fixed: true,
          });
        }
      }
      
      await gitExecFile.save();
    }
  } catch (error) {
    console.error("❌ Error fixing git-exec-enhanced.ts:", error);
  }

  // Fix 5: taskFunctions.ts - wrong return type (line 402)
  try {
    const taskFunctionsFile = project.getSourceFile("src/domain/tasks/taskFunctions.ts");
    if (taskFunctionsFile) {
      console.log("Processing src/domain/tasks/taskFunctions.ts...");
      
      const returnStatements = taskFunctionsFile.getDescendantsOfKind(SyntaxKind.ReturnStatement);
      for (const returnStmt of returnStatements) {
        const expression = returnStmt.getExpression();
        const line = taskFunctionsFile.getLineAndColumnAtPos(returnStmt.getStart()).line;
        
        if (line === 402 && expression) {
          // Check if this is returning an object with tasks property when it should return the tasks array
          if (expression.getKind() === SyntaxKind.ObjectLiteralExpression) {
            const objLiteral = expression.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
            const properties = objLiteral.getProperties();
            
            const tasksProperty = properties.find(prop => 
              prop.getKind() === SyntaxKind.PropertyAssignment && 
              (prop as any).getName() === "tasks"
            );
            
            if (tasksProperty) {
              const tasksAssign = tasksProperty as any;
              const tasksValue = tasksAssign.getInitializer();
              if (tasksValue) {
                expression.replaceWithText(tasksValue.getText());
                totalChanges++;
                console.log(`    ✅ Fixed wrong return type (object → array) at line ${line}`);
                fixes.push({
                  file: "src/domain/tasks/taskFunctions.ts",
                  line: line,
                  change: "object → array return type",
                  fixed: true,
                });
              }
            }
          }
        }
      }
      
      await taskFunctionsFile.save();
    }
  } catch (error) {
    console.error("❌ Error fixing taskFunctions.ts:", error);
  }

  // Generate report
  const reportPath = "./ts2322-remaining-ast-fixes-report.json";
  const report = {
    timestamp: new Date().toISOString(),
    totalChanges,
    fixes: fixes.sort((a, b) => a.file.localeCompare(b.file)),
    summary: {
      successful: fixes.filter(f => f.fixed).length,
      failed: fixes.filter(f => !f.fixed).length,
      approach: "AST-based transformations for remaining TS2322 errors",
    },
  };

  await writeFile(reportPath, JSON.stringify(report, null, 2));

  console.log(`\n📊 Remaining AST-based TS2322 Fix Summary:`);
  console.log(`   Total changes: ${totalChanges}`);
  console.log(`   Successful fixes: ${report.summary.successful}`);
  console.log(`   Failed fixes: ${report.summary.failed}`);
  console.log(`   Approach: ${report.summary.approach}`);
  console.log(`   Report saved to: ${reportPath}`);
}

// Run the fix
fixRemainingTS2322Errors().catch(console.error); 
