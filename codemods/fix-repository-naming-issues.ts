#!/usr/bin/env bun

import { Project } from "ts-morph";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

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

  console.log(`\n🔧 Processing ${filePath}...`);

  // Fix 1: Change _session to session in parameter reference
  const sessionReferences = sourceFile.getDescendantsOfKind(19 /* Identifier */)
    .filter(node => node.getText() === "_session");
  
  for (const ref of sessionReferences) {
    const parent = ref.getParent();
    // Only replace if it's being used as a variable reference, not as a parameter declaration
    if (parent && !parent.getKind().toString().includes("Parameter")) {
      ref.replaceWithText("session");
      changes++;
      console.log(`✓ Fixed _session → session`);
    }
  }

  // Fix 2: Change _taskId to taskId in parameter reference
  const taskIdReferences = sourceFile.getDescendantsOfKind(19 /* Identifier */)
    .filter(node => node.getText() === "_taskId");
  
  for (const ref of taskIdReferences) {
    const parent = ref.getParent();
    // Only replace if it's being used as a variable reference, not as a parameter declaration
    if (parent && !parent.getKind().toString().includes("Parameter")) {
      ref.replaceWithText("taskId");
      changes++;
      console.log(`✓ Fixed _taskId → taskId`);
    }
  }

  // Fix 3: Fix SessionDB import pattern - change direct new SessionDB() to dynamic import
  const newExpressions = sourceFile.getDescendantsOfKind(214 /* NewExpression */);
  
  for (const newExpr of newExpressions) {
    const text = newExpr.getText();
    if (text === "new SessionDB()") {
      newExpr.replaceWithText('new (await import("./session.js")).SessionDB()');
      changes++;
      console.log(`✓ Fixed SessionDB import to dynamic import`);
    }
  }

  // Fix 4: Fix string reference to _session in error message
  const stringLiterals = sourceFile.getDescendantsOfKind(10 /* StringLiteral */);
  
  for (const str of stringLiterals) {
    const text = str.getText();
    if (text.includes("_session")) {
      const newText = text.replace("_session", "session");
      str.replaceWithText(newText);
      changes++;
      console.log(`✓ Fixed _session → session in string literal`);
    }
  }

  // Fix 5: Fix the shorthand property issue with _session
  const shorthandProperties = sourceFile.getDescendantsOfKind(297 /* ShorthandPropertyAssignment */);
  
  for (const prop of shorthandProperties) {
    const text = prop.getText();
    if (text === "_session") {
      prop.replaceWithText("session");
      changes++;
      console.log(`✓ Fixed shorthand property _session → session`);
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

console.log("\n🎉 Repository naming fixes completed!"); 
