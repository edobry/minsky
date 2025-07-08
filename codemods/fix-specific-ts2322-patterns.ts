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

async function fixSpecificTS2322Patterns(): Promise<void> {
  const project = new Project({
    tsConfigFilePath: "./tsconfig.json",
  });

  const fixes: TypeAssignmentFix[] = [];
  let totalChanges = 0;

  console.log("🔧 Starting specific TS2322 pattern fixes...");

  // Fix 1: taskIO.ts - Buffer to string assertions
  try {
    const taskIOFile = project.getSourceFile("src/domain/tasks/taskIO.ts");
    if (taskIOFile) {
      console.log("Processing src/domain/tasks/taskIO.ts...");
      
      // Find all variable declarations with readFile calls
      const variableDeclarations = taskIOFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration);
      for (const varDecl of variableDeclarations) {
        if (varDecl.getName() === "content") {
          const initializer = varDecl.getInitializer();
          if (initializer && initializer.getKind() === SyntaxKind.AwaitExpression) {
            const awaitExpr = initializer.asKindOrThrow(SyntaxKind.AwaitExpression);
            const expression = awaitExpr.getExpression();
            
            if (expression.getKind() === SyntaxKind.CallExpression) {
              const callExpr = expression.asKindOrThrow(SyntaxKind.CallExpression);
              const memberExpr = callExpr.getExpression();
              
              if (memberExpr.getKind() === SyntaxKind.PropertyAccessExpression) {
                const propAccess = memberExpr.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
                const propName = propAccess.getName();
                
                if (propName === "readFile") {
                  // Add string type assertion
                  awaitExpr.replaceWithText(`(${awaitExpr.getText()}) as string`);
                  totalChanges++;
                  
                  const line = taskIOFile.getLineAndColumnAtPos(varDecl.getStart()).line;
                  console.log(`    ✅ Fixed Buffer → string assertion at line ${line}`);
                  fixes.push({
                    file: "src/domain/tasks/taskIO.ts",
                    line: line,
                    change: "Added string type assertion",
                    fixed: true,
                  });
                }
              }
            }
          }
        }
      }
      
      await taskIOFile.save();
    }
  } catch (error) {
    console.error("❌ Error fixing taskIO.ts:", error);
  }

  // Fix 2: githubIssuesTaskBackend.ts - string to TaskStatus
  try {
    const githubFile = project.getSourceFile("src/domain/tasks/githubIssuesTaskBackend.ts");
    if (githubFile) {
      console.log("Processing src/domain/tasks/githubIssuesTaskBackend.ts...");
      
      // Find all string literals in property assignments
      const propertyAssignments = githubFile.getDescendantsOfKind(SyntaxKind.PropertyAssignment);
      for (const propAssign of propertyAssignments) {
        if (propAssign.getName() === "status") {
          const initializer = propAssign.getInitializer();
          if (initializer && initializer.getKind() === SyntaxKind.StringLiteral) {
            const value = initializer.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue();
            
            // Check if this is a TaskStatus value
            if (["OPEN", "CLOSED", "IN_PROGRESS", "COMPLETED", "TODO", "DONE", "BLOCKED"].includes(value)) {
              initializer.replaceWithText(`TaskStatus.${value}`);
              totalChanges++;
              
              const line = githubFile.getLineAndColumnAtPos(propAssign.getStart()).line;
              console.log(`    ✅ Fixed string → TaskStatus.${value} at line ${line}`);
              fixes.push({
                file: "src/domain/tasks/githubIssuesTaskBackend.ts",
                line: line,
                change: `"${value}" → TaskStatus.${value}`,
                fixed: true,
              });
            }
          }
        }
      }
      
      await githubFile.save();
    }
  } catch (error) {
    console.error("❌ Error fixing githubIssuesTaskBackend.ts:", error);
  }

  // Fix 3: git-exec-enhanced.ts - unknown[] to string[]
  try {
    const gitExecFile = project.getSourceFile("src/utils/git-exec-enhanced.ts");
    if (gitExecFile) {
      console.log("Processing src/utils/git-exec-enhanced.ts...");
      
      // Find all type assertions
      const asExpressions = gitExecFile.getDescendantsOfKind(SyntaxKind.AsExpression);
      for (const asExpr of asExpressions) {
        const typeNode = asExpr.getTypeNode();
        if (typeNode && typeNode.getText() === "unknown[]") {
          typeNode.replaceWithText("string[]");
          totalChanges++;
          
          const line = gitExecFile.getLineAndColumnAtPos(asExpr.getStart()).line;
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

  // Fix 4: taskFunctions.ts - TaskData[] to TaskStatus
  try {
    const taskFunctionsFile = project.getSourceFile("src/domain/tasks/taskFunctions.ts");
    if (taskFunctionsFile) {
      console.log("Processing src/domain/tasks/taskFunctions.ts...");
      
      // Find return statements that return objects instead of arrays
      const returnStatements = taskFunctionsFile.getDescendantsOfKind(SyntaxKind.ReturnStatement);
      for (const returnStmt of returnStatements) {
        const expression = returnStmt.getExpression();
        if (expression && expression.getKind() === SyntaxKind.ObjectLiteralExpression) {
          const objLiteral = expression.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
          const properties = objLiteral.getProperties();
          
          // Check if this object has a 'tasks' property
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
              
              const line = taskFunctionsFile.getLineAndColumnAtPos(returnStmt.getStart()).line;
              console.log(`    ✅ Fixed return type (object → tasks array) at line ${line}`);
              fixes.push({
                file: "src/domain/tasks/taskFunctions.ts",
                line: line,
                change: "object → tasks array",
                fixed: true,
              });
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
  const reportPath = "./ts2322-specific-patterns-report.json";
  const report = {
    timestamp: new Date().toISOString(),
    totalChanges,
    fixes: fixes.sort((a, b) => a.file.localeCompare(b.file)),
    summary: {
      successful: fixes.filter(f => f.fixed).length,
      failed: fixes.filter(f => !f.fixed).length,
      approach: "AST-based fixes for specific TS2322 patterns",
    },
  };

  await writeFile(reportPath, JSON.stringify(report, null, 2));

  console.log(`\n📊 Specific TS2322 Pattern Fix Summary:`);
  console.log(`   Total changes: ${totalChanges}`);
  console.log(`   Successful fixes: ${report.summary.successful}`);
  console.log(`   Failed fixes: ${report.summary.failed}`);
  console.log(`   Approach: ${report.summary.approach}`);
  console.log(`   Report saved to: ${reportPath}`);
}

// Run the fix
fixSpecificTS2322Patterns().catch(console.error); 
