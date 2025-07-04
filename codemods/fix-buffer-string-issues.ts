#!/usr/bin/env bun

import { Project, SyntaxKind, PropertyAccessExpression } from "ts-morph";

function fixBufferStringIssues() {
  console.log("🚀 Starting Buffer/string type issue fixes...");
  
  const project = new Project({
    tsConfigFilePath: "tsconfig.json",
  });

  // Add all TypeScript files including scripts
  const sourceFiles = project.addSourceFilesAtPaths([
    "src/**/*.ts", 
    "scripts/**/*.ts"
  ]);
  console.log(`📁 Adding ${sourceFiles.length} TypeScript files to project...`);

  let fixCount = 0;
  const fixes: string[] = [];

  // Collect all changes first to avoid node invalidation
  const changesToApply: Array<{
    expression: any;
    newText: string;
    description: string;
  }> = [];

  for (const sourceFile of sourceFiles) {
    // Find property access expressions like .split() and .replace()
    sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression).forEach(propertyAccess => {
      const propertyName = propertyAccess.getName();
      
      // Check for string methods that might be called on Buffer types
      if (["split", "replace", "trim", "substring", "indexOf", "includes"].includes(propertyName)) {
        const expression = propertyAccess.getExpression();
        const expressionText = expression.getText();
        
        // Check if this is likely a readFile result or similar that could be Buffer
        if (expressionText.includes("readFileSync") || 
            expressionText.includes("readFile") ||
            expressionText.includes("content") ||
            expressionText.includes("data")) {
          
          // Wrap the expression with toString() if not already wrapped
          if (!expressionText.includes(".toString()")) {
            const newText = `(${expressionText}).toString()`;
            changesToApply.push({
              expression,
              newText,
              description: `Fixed ${expressionText}.${propertyName} → ${newText}.${propertyName} in ${sourceFile.getBaseName()}:${propertyAccess.getStartLineNumber()}`
            });
          }
        }
      }
    });
  }

  // Apply all changes
  console.log(`🔧 Applying ${changesToApply.length} changes...`);
  for (const change of changesToApply) {
    try {
      change.expression.replaceWithText(change.newText);
      fixCount++;
      fixes.push(`✅ ${change.description}`);
    } catch (error) {
      console.warn(`⚠️  Failed to apply change: ${change.description}`);
    }
  }

  // Save all changes
  console.log("💾 Saving changes...");
  project.saveSync();
  console.log(`💾 Saved changes to ${sourceFiles.length} files`);

  // Print report
  console.log(`\n📋 Buffer/String Type Issues Report:`);
  console.log(`   Fixes applied: ${fixCount}`);
  
  if (fixes.length > 0) {
    console.log(`\n🔧 Applied fixes:`);
    fixes.forEach(fix => console.log(fix));
  }

  console.log(`\n✅ Buffer/string type issue fix completed!`);
}

fixBufferStringIssues(); 
