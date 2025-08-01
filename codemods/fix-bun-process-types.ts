#!/usr/bin/env bun

import { Project, SyntaxKind, PropertyAccessExpression } from "ts-morph";

function fixBunProcessTypes() {
  console.log("🚀 Starting Bun process type fixes...");

  const project = new Project({
    tsConfigFilePath: "tsconfig.json",
  });

  // Add all TypeScript files including scripts
  const sourceFiles = project.addSourceFilesAtPaths(["src/**/*.ts", "scripts/**/*.ts"]);
  console.log(`📁 Adding ${sourceFiles.length} TypeScript files to project...`);

  let fixCount = 0;
  const fixes: string[] = [];

  for (const sourceFile of sourceFiles) {
    // Find property access expressions for process.exit and process.exitCode
    sourceFile
      .getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)
      .forEach((propertyAccess) => {
        const expression = propertyAccess.getExpression();
        const propertyName = propertyAccess.getName();

        // Check if this is process.exit or process.exitCode
        if (
          expression.getText() === "process" &&
          (propertyName === "exit" || propertyName === "exitCode")
        ) {
          // Get the statement containing this property access
          const statement =
            propertyAccess.getFirstAncestorByKind(SyntaxKind.ExpressionStatement) ||
            propertyAccess.getFirstAncestorByKind(SyntaxKind.CallExpression);

          if (statement) {
            // Add @ts-expect-error comment before the statement
            const commentText = `// @ts-expect-error - Bun supports process.${propertyName} at runtime, types incomplete`;
            statement.replaceWithText(`${commentText}\n${statement.getText()}`);
            fixCount++;
            fixes.push(
              `Added @ts-expect-error comment for process.${propertyName} in ${sourceFile.getBaseName()}:${propertyAccess.getStartLineNumber()}`
            );
          }
        }
      });
  }

  // Save all changes
  console.log("💾 Saving changes...");
  project.saveSync();
  console.log(`💾 Saved changes to ${sourceFiles.length} files`);

  // Print report
  console.log(`\n📋 Bun Process Type Fixes Report:`);
  console.log(`   Fixes applied: ${fixCount}`);

  if (fixes.length > 0) {
    console.log(`\n🔧 Applied fixes:`);
    fixes.forEach((fix) => console.log(`✅ ${fix}`));
  }

  console.log(`\n✅ Bun process type fix completed!`);
}

fixBunProcessTypes();
