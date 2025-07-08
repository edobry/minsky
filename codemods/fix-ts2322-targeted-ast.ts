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

async function fixSpecificTS2322Errors(): Promise<void> {
  const project = new Project({
    tsConfigFilePath: "./tsconfig.json",
  });

  const fixes: TypeAssignmentFix[] = [];
  let totalChanges = 0;

  console.log("🔧 Starting targeted AST-based TS2322 fixes...");

  // Fix 1: tasks.ts - null to undefined
  try {
    const tasksFile = project.getSourceFile("src/domain/tasks.ts");
    if (tasksFile) {
      console.log("Processing src/domain/tasks.ts...");
      
      // Find assignments of null that should be undefined
      const binaryExpressions = tasksFile.getDescendantsOfKind(SyntaxKind.BinaryExpression);
      for (const binExpr of binaryExpressions) {
        if (binExpr.getOperatorToken().getKind() === SyntaxKind.EqualsToken) {
          const right = binExpr.getRight();
          if (right.getKind() === SyntaxKind.NullKeyword) {
            // Get line number to match error
            const startLine = tasksFile.getLineAndColumnAtPos(binExpr.getStart()).line;
            if (startLine === 324) {
              right.replaceWithText("undefined");
              totalChanges++;
              console.log(`    ✅ Fixed null → undefined at line ${startLine}`);
              fixes.push({
                file: "src/domain/tasks.ts",
                line: startLine,
                change: "null → undefined",
                fixed: true,
              });
              break;
            }
          }
        }
      }
      
      await tasksFile.save();
    }
  } catch (error) {
    console.error("❌ Error fixing tasks.ts:", error);
  }

  // Fix 2: githubIssuesTaskBackend.ts - string to TaskStatus enum
  try {
    const githubFile = project.getSourceFile("src/domain/tasks/githubIssuesTaskBackend.ts");
    if (githubFile) {
      console.log("Processing src/domain/tasks/githubIssuesTaskBackend.ts...");
      
      // Find string literals that should be TaskStatus enums
      const stringLiterals = githubFile.getDescendantsOfKind(SyntaxKind.StringLiteral);
      for (const stringLiteral of stringLiterals) {
        const value = stringLiteral.getLiteralValue();
        const line = githubFile.getLineAndColumnAtPos(stringLiteral.getStart()).line;
        
        // Check if this is around line 426 and matches TaskStatus values
        if (line >= 420 && line <= 430) {
          if (["OPEN", "CLOSED", "IN_PROGRESS", "COMPLETED", "TODO", "DONE", "BLOCKED"].includes(value)) {
            // Check if parent is a property assignment for status
            const parent = stringLiteral.getParent();
            if (parent && parent.getKind() === SyntaxKind.PropertyAssignment) {
              const propAssign = parent.asKindOrThrow(SyntaxKind.PropertyAssignment);
              const name = propAssign.getName();
              if (name === "status") {
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
          }
        }
      }
      
      await githubFile.save();
    }
  } catch (error) {
    console.error("❌ Error fixing githubIssuesTaskBackend.ts:", error);
  }

  // Fix 3: error-handling.ts - RecoveryAction type issues
  try {
    const errorHandlingFile = project.getSourceFile("src/domain/storage/backends/error-handling.ts");
    if (errorHandlingFile) {
      console.log("Processing src/domain/storage/backends/error-handling.ts...");
      
      // Find object literals that should be properly typed as RecoveryAction[]
      const objectLiterals = errorHandlingFile.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression);
      for (const objLiteral of objectLiterals) {
        const properties = objLiteral.getProperties();
        
        // Check if this is a recovery action object (has type, description properties)
        const hasType = properties.some(prop => 
          prop.getKind() === SyntaxKind.PropertyAssignment && 
          (prop as any).getName() === "type"
        );
        const hasDescription = properties.some(prop => 
          prop.getKind() === SyntaxKind.PropertyAssignment && 
          (prop as any).getName() === "description"
        );
        
        if (hasType && hasDescription) {
          const line = errorHandlingFile.getLineAndColumnAtPos(objLiteral.getStart()).line;
          
          // Check if this is in the problematic lines (131, 136, 141)
          if ([131, 136, 141].includes(line)) {
            // Add type assertion to fix the type mismatch
            objLiteral.replaceWithText(`${objLiteral.getText()} as RecoveryAction`);
            totalChanges++;
            console.log(`    ✅ Added RecoveryAction type assertion at line ${line}`);
            fixes.push({
              file: "src/domain/storage/backends/error-handling.ts",
              line: line,
              change: "Added RecoveryAction type assertion",
              fixed: true,
            });
          }
        }
      }
      
      await errorHandlingFile.save();
    }
  } catch (error) {
    console.error("❌ Error fixing error-handling.ts:", error);
  }

  // Generate report
  const reportPath = "./ts2322-targeted-ast-fixes-report.json";
  const report = {
    timestamp: new Date().toISOString(),
    totalChanges,
    fixes: fixes.sort((a, b) => a.file.localeCompare(b.file)),
    summary: {
      successful: fixes.filter(f => f.fixed).length,
      failed: fixes.filter(f => !f.fixed).length,
      approach: "Targeted AST-based transformations for specific TS2322 errors",
    },
  };

  await writeFile(reportPath, JSON.stringify(report, null, 2));

  console.log(`\n📊 Targeted AST-based TS2322 Fix Summary:`);
  console.log(`   Total changes: ${totalChanges}`);
  console.log(`   Successful fixes: ${report.summary.successful}`);
  console.log(`   Failed fixes: ${report.summary.failed}`);
  console.log(`   Approach: ${report.summary.approach}`);
  console.log(`   Report saved to: ${reportPath}`);
}

// Run the fix
fixSpecificTS2322Errors().catch(console.error); 
