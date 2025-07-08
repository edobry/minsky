#!/usr/bin/env bun

import { Project, SyntaxKind, Node } from "ts-morph";

function fixUndefinedIssues() {
  console.log("🚀 Starting undefined issues fixes...");
  
  const project = new Project({
    tsConfigFilePath: "tsconfig.json",
  });

  // Add all TypeScript files
  const sourceFiles = project.addSourceFilesAtPaths([
    "src/**/*.ts", 
    "scripts/**/*.ts"
  ]);
  console.log(`📁 Processing ${sourceFiles.length} TypeScript files...`);

  let fixCount = 0;
  const fixes: string[] = [];

  for (const sourceFile of sourceFiles) {
    // Fix Buffer.toString() issues first
    sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression).forEach(callExpr => {
      const expression = callExpr.getExpression();
      
      // Look for readFile calls that need .toString()
      if (expression.getText().includes("readFile")) {
        const parent = callExpr.getParent();
        if (parent && Node.isVariableDeclaration(parent)) {
          const initializer = parent.getInitializer();
          if (initializer && initializer === callExpr) {
            // Check if this needs .toString() conversion
            const variableName = parent.getName();
            const usages = sourceFile.getDescendantsOfKind(SyntaxKind.Identifier)
              .filter(id => id.getText() === variableName && id !== parent.getNameNode());
            
            // If the variable is used in string contexts, add .toString()
            for (const usage of usages) {
              const usageParent = usage.getParent();
              if (usageParent && (
                Node.isTemplateExpression(usageParent) ||
                Node.isStringLiteral(usageParent) ||
                usageParent.getText().includes('.trim()') ||
                usageParent.getText().includes('.split(')
              )) {
                // Add .toString() to the readFile call
                callExpr.replaceWithText(`(${callExpr.getText()}).toString()`);
                fixCount++;
                fixes.push(`Added .toString() to ${variableName} in ${sourceFile.getBaseName()}`);
                break;
              }
            }
          }
        }
      }
    });

    // Fix "possibly undefined" array access issues
    sourceFile.getDescendantsOfKind(SyntaxKind.ElementAccessExpression).forEach(elementAccess => {
      const expression = elementAccess.getExpression();
      const argument = elementAccess.getArgumentExpression();
      
      if (argument && expression.getText().includes('.split(')) {
        // This is likely an array access on split result that could be undefined
        const parent = elementAccess.getParent();
        if (parent && !parent.getText().includes('?')) {
          // Add optional chaining or null check
          elementAccess.replaceWithText(`${expression.getText()}?.[${argument.getText()}]`);
          fixCount++;
          fixes.push(`Added optional chaining to array access in ${sourceFile.getBaseName()}`);
        }
      }
    });

    // Fix "possibly undefined" property access
    sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression).forEach(propAccess => {
      const expression = propAccess.getExpression();
      const name = propAccess.getName();
      
      // Look for common patterns like line.trim(), match[1], etc.
      if ((name === 'trim' || name === 'split' || name === 'includes') && 
          !expression.getText().includes('?') &&
          !propAccess.getText().includes('?.')) {
        
        const parent = propAccess.getParent();
        if (parent && Node.isCallExpression(parent)) {
          // Check if this is in a context where it could be undefined
          const grandParent = parent.getParent();
          if (grandParent && (
            Node.isVariableDeclaration(grandParent) ||
            Node.isExpressionStatement(grandParent)
          )) {
            // Add optional chaining
            propAccess.replaceWithText(`${expression.getText()}?.${name}`);
            fixCount++;
            fixes.push(`Added optional chaining to ${expression.getText()}.${name} in ${sourceFile.getBaseName()}`);
          }
        }
      }
    });

    // Fix array.find() usage that might return undefined
    sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression).forEach(callExpr => {
      const expression = callExpr.getExpression();
      
      if (Node.isPropertyAccessExpression(expression) && expression.getName() === 'find') {
        const parent = callExpr.getParent();
        if (parent && Node.isVariableDeclaration(parent)) {
          const variableName = parent.getName();
          
          // Look for usages of this variable that assume it's not undefined
          const usages = sourceFile.getDescendantsOfKind(SyntaxKind.Identifier)
            .filter(id => id.getText() === variableName && id !== parent.getNameNode());
          
          for (const usage of usages) {
            const usageParent = usage.getParent();
            if (usageParent && Node.isPropertyAccessExpression(usageParent) && 
                usageParent.getExpression() === usage &&
                !usage.getText().includes('?')) {
              
              // Add null check before usage
              const statement = usage.getFirstAncestorByKind(SyntaxKind.ExpressionStatement);
              if (statement) {
                statement.replaceWithText(`if (${variableName}) {\n  ${statement.getText()}\n}`);
                fixCount++;
                fixes.push(`Added null check for ${variableName} in ${sourceFile.getBaseName()}`);
                break;
              }
            }
          }
        }
      }
    });
  }

  // Save all changes
  console.log("💾 Saving changes...");
  project.saveSync();
  console.log(`💾 Saved changes to ${sourceFiles.length} files`);

  // Print report
  console.log(`\n📋 Undefined Issues Fix Report:`);
  console.log(`   Fixes applied: ${fixCount}`);
  
  if (fixes.length > 0) {
    console.log(`\n🔧 Applied fixes:`);
    fixes.slice(0, 10).forEach(fix => console.log(`✅ ${fix}`));
    if (fixes.length > 10) {
      console.log(`... and ${fixes.length - 10} more fixes`);
    }
  }

  console.log(`\n✅ Undefined issues fix completed!`);
}

fixUndefinedIssues(); 
