#!/usr/bin/env bun

import { Project, SyntaxKind } from "ts-morph";

// Initialize TypeScript project
const project = new Project({
  tsConfigFilePath: "./tsconfig.json",
  skipAddingFilesFromTsConfig: true,
});

const filePath = "src/mcp/tools/session.ts";

try {
  // Add the file to the project
  const sourceFile = project.addSourceFileAtPath(filePath);
  let changes = 0;

  console.log(`\n🔧 Processing ${filePath}...`);

  // Fix 1: Correct the import path for errors/index
  const importDeclarations = sourceFile.getImportDeclarations();
  
  for (const importDecl of importDeclarations) {
    const moduleSpecifier = importDecl.getModuleSpecifierValue();
    if (moduleSpecifier === "../errors/index") {
      importDecl.setModuleSpecifier("../../errors/index");
      changes++;
      console.log(`✓ Fixed import path: ../errors/index → ../../errors/index`);
    }
  }

  // Fix 2: Handle unknown type assertions for args parameter
  const functionExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.ArrowFunction);
  
  for (const func of functionExpressions) {
    const parameters = func.getParameters();
    
    for (const param of parameters) {
      if (param.getName() === "args" && param.getTypeNode()?.getText() === "unknown") {
        // Find usages of args.session where args is unknown
        const funcBody = func.getBody();
        if (funcBody) {
          const argsUsages = funcBody.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)
            .filter(expr => expr.getExpression().getText() === "args" && expr.getName() === "session");
          
          for (const usage of argsUsages) {
            // Cast args to any for these specific usages
            const parent = usage.getParent();
            if (parent) {
              const fullExpression = usage.getText();
              usage.replaceWithText(`(args as any).session`);
              changes++;
              console.log(`✓ Fixed unknown type: ${fullExpression} → (args as any).session`);
            }
          }
        }
      }
    }
  }

  // Fix 3: Handle property mismatch between schema (_session) and usage (session)
  // Find Zod schema definitions with _session and update corresponding usage
  const propertyAccessExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression);
  
  for (const propAccess of propertyAccessExpressions) {
    const text = propAccess.getText();
    
    // Fix args.session to args._session where schema defines _session
    if (text === "args.session") {
      // Check if this is in a context where _session is defined in schema
      const parent = propAccess.getParent();
      if (parent) {
        // Look for nearby _session schema definition
        const nearbyText = parent.getParent()?.getText() || "";
        if (nearbyText.includes("_session: z.string()")) {
          propAccess.replaceWithText("args._session");
          changes++;
          console.log(`✓ Fixed property mismatch: args.session → args._session`);
        }
      }
    }
  }

  // Fix 4: Handle string literals referencing wrong variable names
  const stringLiterals = sourceFile.getDescendantsOfKind(SyntaxKind.StringLiteral);
  
  for (const stringLiteral of stringLiterals) {
    const text = stringLiteral.getText();
    
    // Fix "_session" references in error messages
    if (text.includes("_session")) {
      const newText = text.replace("_session", "session");
      stringLiteral.replaceWithText(newText);
      changes++;
      console.log(`✓ Fixed string literal: ${text} → ${newText}`);
    }
  }

  // Fix 5: Fix the specific schema/usage mismatch for session vs _session
  const objectLiteralExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression);
  
  for (const objLiteral of objectLiteralExpressions) {
    const properties = objLiteral.getProperties();
    
    for (const prop of properties) {
      if (prop.getKind() === SyntaxKind.PropertyAssignment) {
        const propAssignment = prop.asKindOrThrow(SyntaxKind.PropertyAssignment);
        const name = propAssignment.getName();
        
        // Fix _session: args.session to _session: args._session
        if (name === "_session") {
          const initializer = propAssignment.getInitializer();
          if (initializer?.getText() === "args.session") {
            initializer.replaceWithText("args._session");
            changes++;
            console.log(`✓ Fixed object property: _session: args.session → _session: args._session`);
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

console.log("\n🎉 Session.ts fixes completed!"); 
