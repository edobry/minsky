#!/usr/bin/env bun

import { Project, SyntaxKind, Node } from "ts-morph";

// Initialize TypeScript project
const project = new Project({
  tsConfigFilePath: "./tsconfig.json",
  skipAddingFilesFromTsConfig: true,
});

const filePath = "src/domain/repository.ts";

try {
  // Add the file to the project
  const sourceFile = project.addSourceFileAtPath(filePath);
  let changes = 0;

  console.log(`\n🔧 Processing ${filePath} with improved pattern matching...`);

  // Fix 1: Handle _session in all contexts (but not parameter declarations)
  const sessionIdentifiers = sourceFile.getDescendantsOfKind(SyntaxKind.Identifier)
    .filter(node => node.getText() === "_session");
  
  for (const identifier of sessionIdentifiers) {
    const parent = identifier.getParent();
    
    // Skip if this is a parameter declaration
    if (parent && parent.getKind() === SyntaxKind.Parameter) {
      console.log(`⏭️  Skipping parameter declaration: ${identifier.getText()}`);
      continue;
    }
    
    // Handle specific contexts
    const context = getNodeContext(identifier);
    console.log(`📍 Found _session in context: ${context}`);
    
    identifier.replaceWithText("session");
    changes++;
    console.log(`✓ Fixed _session → session (${context})`);
  }

  // Fix 2: Handle _taskId in all contexts (but not parameter declarations)
  const taskIdIdentifiers = sourceFile.getDescendantsOfKind(SyntaxKind.Identifier)
    .filter(node => node.getText() === "_taskId");
  
  for (const identifier of taskIdIdentifiers) {
    const parent = identifier.getParent();
    
    // Skip if this is a parameter declaration
    if (parent && parent.getKind() === SyntaxKind.Parameter) {
      console.log(`⏭️  Skipping parameter declaration: ${identifier.getText()}`);
      continue;
    }
    
    const context = getNodeContext(identifier);
    console.log(`📍 Found _taskId in context: ${context}`);
    
    identifier.replaceWithText("taskId");
    changes++;
    console.log(`✓ Fixed _taskId → taskId (${context})`);
  }

  // Fix 3: Handle property name issues (_repoPath → repoPath)
  const repoPathIdentifiers = sourceFile.getDescendantsOfKind(SyntaxKind.Identifier)
    .filter(node => node.getText() === "_repoPath");
  
  for (const identifier of repoPathIdentifiers) {
    const parent = identifier.getParent();
    
    // Skip if this is a parameter declaration
    if (parent && parent.getKind() === SyntaxKind.Parameter) {
      console.log(`⏭️  Skipping parameter declaration: ${identifier.getText()}`);
      continue;
    }
    
    const context = getNodeContext(identifier);
    console.log(`📍 Found _repoPath in context: ${context}`);
    
    identifier.replaceWithText("repoPath");
    changes++;
    console.log(`✓ Fixed _repoPath → repoPath (${context})`);
  }

  // Fix 4: Handle string literals containing variable references
  const stringLiterals = sourceFile.getDescendantsOfKind(SyntaxKind.StringLiteral);
  
  for (const stringLiteral of stringLiterals) {
    const originalText = stringLiteral.getText();
    let newText = originalText;
    
    // Replace underscore-prefixed variables in string content
    newText = newText.replace(/_session/g, "session");
    newText = newText.replace(/_taskId/g, "taskId");
    newText = newText.replace(/_repoPath/g, "repoPath");
    
    if (newText !== originalText) {
      stringLiteral.replaceWithText(newText);
      changes++;
      console.log(`✓ Fixed string literal: ${originalText} → ${newText}`);
    }
  }

  // Fix 5: Fix SessionDB instantiation with proper dynamic import
  const newExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.NewExpression);
  
  for (const newExpr of newExpressions) {
    const text = newExpr.getText();
    if (text === "new SessionDB()") {
      newExpr.replaceWithText('new (await import("./session.js")).SessionDB()');
      changes++;
      console.log(`✓ Fixed SessionDB import to dynamic import`);
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

/**
 * Get a human-readable context description for a node
 */
function getNodeContext(node: Node): string {
  const parent = node.getParent();
  if (!parent) return "unknown";
  
  switch (parent.getKind()) {
    case SyntaxKind.PropertyAssignment:
      return "property assignment";
    case SyntaxKind.ShorthandPropertyAssignment:
      return "shorthand property";
    case SyntaxKind.CallExpression:
      return "function call argument";
    case SyntaxKind.BinaryExpression:
      return "binary expression";
    case SyntaxKind.ConditionalExpression:
      return "conditional expression";
    case SyntaxKind.IfStatement:
      return "if statement condition";
    case SyntaxKind.Parameter:
      return "parameter declaration";
    case SyntaxKind.VariableDeclaration:
      return "variable declaration";
    default:
      return `${SyntaxKind[parent.getKind()]} (${parent.getKind()})`;
  }
}

console.log("\n🎉 Improved repository naming fixes completed!"); 
