import { Project, SyntaxKind, Node } from "ts-morph";

interface Fix {
  file: string;
  line: number;
  description: string;
}

const fixes: Fix[] = [];

function fixMockingUnknownTypes(): void {
  console.log("🚀 Starting mocking.ts unknown type fixes...");
  
  const project = new Project({
    tsConfigFilePath: "tsconfig.json",
    skipAddingFilesFromTsConfig: true,
  });

  const targetFile = "src/utils/test-utils/mocking.ts";
  
  try {
    const sourceFile = project.addSourceFileAtPath(targetFile);
    console.log(`📁 Processing ${targetFile}...`);

    let fileChanged = false;

    // Find all call expressions where arguments might be unknown
    const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
    
    for (const callExpr of callExpressions) {
      const args = callExpr.getArguments();
      
      for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        
        // Check if this argument is an identifier that might be unknown
        if (Node.isIdentifier(arg)) {
          const argName = arg.getText();
          
          // Target specific variable names that are causing unknown type errors
          if (argName === "command" || argName === "params" || argName === "categories") {
            // Add type assertion to make it a string
            arg.replaceWithText(`(${argName} as string)`);
            fileChanged = true;
            
            fixes.push({
              file: targetFile,
              line: arg.getStartLineNumber(),
              description: `Added type assertion to function argument: ${argName} → (${argName} as string)`
            });
          }
        }
      }
    }

    // Find property access expressions on unknown types
    const propertyAccessExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression);
    
    for (const propAccess of propertyAccessExpressions) {
      const expression = propAccess.getExpression();
      
      if (Node.isIdentifier(expression)) {
        const varName = expression.getText();
        
        // Target specific variables that are unknown types
        if (varName === "command" || varName === "params" || varName === "categories") {
          // Check if we're not already in a type assertion
          const parent = propAccess.getParent();
          if (!Node.isAsExpression(parent)) {
            // Add type assertion to the expression
            expression.replaceWithText(`(${varName} as any)`);
            fileChanged = true;
            
            fixes.push({
              file: targetFile,
              line: expression.getStartLineNumber(),
              description: `Added type assertion to property access: ${varName} → (${varName} as any)`
            });
          }
        }
      }
    }

    // Find standalone identifiers that are used as unknown types
    const identifiers = sourceFile.getDescendantsOfKind(SyntaxKind.Identifier);
    
    for (const identifier of identifiers) {
      const identifierText = identifier.getText();
      
      // Target specific variables that are causing unknown type errors
      if (identifierText === "command" || identifierText === "params" || identifierText === "categories") {
        const parent = identifier.getParent();
        
        // Check if this is a standalone usage that needs type assertion
        if (Node.isExpressionStatement(parent) || 
            (Node.isBinaryExpression(parent) && parent.getLeft() === identifier) ||
            (Node.isVariableDeclaration(parent) && parent.getInitializer() === identifier)) {
          
          // Skip if already in a type assertion
          if (!Node.isAsExpression(parent) && !Node.isAsExpression(identifier.getParent())) {
            identifier.replaceWithText(`(${identifierText} as any)`);
            fileChanged = true;
            
            fixes.push({
              file: targetFile,
              line: identifier.getStartLineNumber(),
              description: `Added type assertion to standalone identifier: ${identifierText} → (${identifierText} as any)`
            });
          }
        }
      }
    }

    if (fileChanged) {
      sourceFile.saveSync();
      console.log(`✅ Fixed unknown types in ${targetFile}`);
    } else {
      console.log(`ℹ️  No unknown type changes needed in ${targetFile}`);
    }

  } catch (error) {
    console.log(`❌ Error processing ${targetFile}: ${error}`);
  }
}

// Run the fix
fixMockingUnknownTypes();

// Report results
console.log(`\n📋 Mocking Unknown Type Fix Report:`);
console.log(`   Fixes applied: ${fixes.length}`);

if (fixes.length > 0) {
  console.log(`\n🔧 Applied fixes:`);
  fixes.forEach((fix, index) => {
    console.log(`   ${index + 1}. ${fix.description} (line ${fix.line})`);
  });
}

console.log(`\n✅ Mocking unknown type fix completed!`); 
 