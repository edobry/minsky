#!/usr/bin/env bun

import { Project, SyntaxKind } from "ts-morph";

// Initialize TypeScript project
const project = new Project({
  tsConfigFilePath: "./tsconfig.json",
  skipAddingFilesFromTsConfig: true,
});

const filePath = "src/domain/storage/backends/postgres-storage.ts";

try {
  // Add the file to the project
  const sourceFile = project.addSourceFileAtPath(filePath);
  let changes = 0;

  console.log(`\n🔧 Processing ${filePath}...`);

  // Fix 1: Handle unknown type assertions in log.error calls
  const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
  
  for (const callExpr of callExpressions) {
    const expression = callExpr.getExpression();
    
    // Find log.error calls
    if (expression.getKind() === SyntaxKind.PropertyAccessExpression) {
      const propAccess = expression.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
      if (propAccess.getExpression().getText() === "log" && propAccess.getName() === "error") {
        const args = callExpr.getArguments();
        
        // Look for arguments that are just 'error' (which is unknown)
        for (let i = 0; i < args.length; i++) {
          const arg = args[i];
          
          if (arg.getText() === "error") {
            // Cast error to Error type
            arg.replaceWithText("error as Error");
            changes++;
            console.log(`✓ Fixed log.error unknown type: error → error as Error`);
          }
          
          // Handle object literals with error property
          if (arg.getKind() === SyntaxKind.ObjectLiteralExpression) {
            const objLiteral = arg.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
            const properties = objLiteral.getProperties();
            
            for (const prop of properties) {
              if (prop.getKind() === SyntaxKind.PropertyAssignment) {
                const propAssignment = prop.asKindOrThrow(SyntaxKind.PropertyAssignment);
                if (propAssignment.getName() === "error" && propAssignment.getInitializer()?.getText() === "error") {
                  propAssignment.getInitializer()?.replaceWithText("error as Error");
                  changes++;
                  console.log(`✓ Fixed object property error type: error → error as Error`);
                }
              }
            }
          }
        }
      }
    }
  }

  // Fix 2: Handle rowCount property access issues
  const propertyAccessExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression);
  
  for (const propAccess of propertyAccessExpressions) {
    if (propAccess.getName() === "rowCount") {
      const parent = propAccess.getParent();
      if (parent) {
        // Check if this is in a context where we're checking rowCount
        const grandParent = parent.getParent();
        if (grandParent && grandParent.getText().includes("rowCount")) {
          // Replace with affectedRows which is the correct property for many DB drivers
          propAccess.replaceWithText(`${propAccess.getExpression().getText()}.affectedRows`);
          changes++;
          console.log(`✓ Fixed rowCount property: rowCount → affectedRows`);
        }
      }
    }
  }

  // Fix 3: Handle undefined object issues - add null checks
  const binaryExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.BinaryExpression);
  
  for (const binExpr of binaryExpressions) {
    if (binExpr.getOperatorToken().getText() === "&&") {
      const left = binExpr.getLeft().getText();
      const right = binExpr.getRight().getText();
      
      // Look for patterns like result.rowCount > 0 and add null check
      if (right.includes("rowCount > 0")) {
        const newText = `${left} && result.affectedRows !== null && result.affectedRows > 0`;
        binExpr.replaceWithText(newText);
        changes++;
        console.log(`✓ Added null check for rowCount: ${binExpr.getText()} → ${newText}`);
      }
    }
  }

  // Fix 4: Handle specific "No overload matches this call" issues
  // Look for problematic function calls and add type assertions
  for (const callExpr of callExpressions) {
    const args = callExpr.getArguments();
    
    // Look for function calls with potentially undefined arguments
    for (const arg of args) {
      if (arg.getText().includes("insertData") && arg.getKind() === SyntaxKind.Identifier) {
        // Check if this is causing type issues
        const parent = callExpr.getParent();
        if (parent && parent.getText().includes("VALUES")) {
          // This might be a SQL template literal issue - add type assertion
          const funcName = callExpr.getExpression().getText();
          if (funcName.includes("sql")) {
            // Add type assertion to the problematic argument
            const currentText = arg.getText();
            arg.replaceWithText(`${currentText} as any`);
            changes++;
            console.log(`✓ Added type assertion for SQL call: ${currentText} → ${currentText} as any`);
          }
        }
      }
    }
  }

  // Fix 5: Handle object possibly undefined issues
  const conditionalExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.ConditionalExpression);
  
  for (const condExpr of conditionalExpressions) {
    const condition = condExpr.getCondition().getText();
    
    // Look for patterns checking object existence
    if (condition.includes("existing")) {
      const parent = condExpr.getParent();
      if (parent && parent.getText().includes("existing")) {
        // Add null assertion where needed
        const thenExpr = condExpr.getWhenTrue();
        if (thenExpr.getText().includes("existing") && !thenExpr.getText().includes("!")) {
          // Add non-null assertion
          const currentText = thenExpr.getText();
          if (!currentText.includes("!")) {
            thenExpr.replaceWithText(`${currentText}!`);
            changes++;
            console.log(`✓ Added non-null assertion: ${currentText} → ${currentText}!`);
          }
        }
      }
    }
  }

  // Save changes if any were made
  if (changes > 0) {
    console.log(`\n📝 Saving ${changes} changes to ${filePath}...`);
    sourceFile.saveSync();
    console.log(`✅ Successfully applied ${changes} fixes to ${filePath}`);
  } else {
    console.log(`ℹ️  No changes needed for ${filePath}`);
  }

} catch (error) {
  console.error(`❌ Error processing ${filePath}:`, error);
  process.exit(1);
}

console.log("\n🎉 Postgres storage type fixes completed!"); 
