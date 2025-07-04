import { Project, SyntaxKind, Node } from "ts-morph";

interface Fix {
  file: string;
  line: number;
  description: string;
}

const fixes: Fix[] = [];

function fixMockingUnknownAST(): void {
  console.log("🚀 Starting AST-based mocking.ts unknown type fixes...");
  
  const project = new Project({
    tsConfigFilePath: "tsconfig.json",
    skipAddingFilesFromTsConfig: true,
  });

  const targetFile = "src/utils/test-utils/mocking.ts";
  
  try {
    const sourceFile = project.addSourceFileAtPath(targetFile);
    console.log(`📁 Processing ${targetFile}...`);

    let fileChanged = false;

    // Find function parameters that are 'unknown' and need type assertions
    const functionDeclarations = sourceFile.getDescendantsOfKind(SyntaxKind.FunctionDeclaration);
    const arrowFunctions = sourceFile.getDescendantsOfKind(SyntaxKind.ArrowFunction);
    const functionExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.FunctionExpression);
    const functions = [...functionDeclarations, ...arrowFunctions, ...functionExpressions];

    for (const func of functions) {
      const parameters = func.getParameters();
      
      for (const param of parameters) {
        const paramName = param.getName();
        const typeNode = param.getTypeNode();
        
        // If parameter is typed as 'unknown'
        if (typeNode && typeNode.getText() === "unknown") {
          // Find usages of this parameter in the function body
          const body = func.getBody();
          if (Node.isBlock(body)) {
            const identifiers = body.getDescendantsOfKind(SyntaxKind.Identifier);
            
            for (const identifier of identifiers) {
              if (identifier.getText() === paramName) {
                const parent = identifier.getParent();
                
                // Check if this is a property access (e.g., command.includes)
                if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === identifier) {
                  const propertyName = parent.getName();
                  
                  // For string methods like 'includes', add string type assertion
                  if (propertyName === "includes" || propertyName === "split" || propertyName === "startsWith") {
                    identifier.replaceWithText(`(${paramName} as string)`);
                    fileChanged = true;
                    
                    fixes.push({
                      file: targetFile,
                      line: identifier.getStartLineNumber(),
                      description: `Added string type assertion for property access: ${paramName}.${propertyName}`
                    });
                  }
                }
                
                // Check if this is a call expression argument
                else if (Node.isCallExpression(parent)) {
                  const args = parent.getArguments();
                  const argIndex = args.indexOf(identifier);
                  
                  if (argIndex !== -1) {
                    // Check the function being called to determine appropriate type
                    const expression = parent.getExpression();
                    if (Node.isPropertyAccessExpression(expression)) {
                      const methodName = expression.getName();
                      
                      // For methods that expect strings
                      if (methodName === "has" || methodName === "get" || methodName === "set" || 
                          methodName === "delete" || methodName === "add") {
                        identifier.replaceWithText(`(${paramName} as string)`);
                        fileChanged = true;
                        
                        fixes.push({
                          file: targetFile,
                          line: identifier.getStartLineNumber(),
                          description: `Added string type assertion for method argument: ${methodName}(${paramName})`
                        });
                      }
                    }
                  }
                }
              }
            }
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
fixMockingUnknownAST();

// Report results
console.log(`\n📋 AST-based Mocking Fix Report:`);
console.log(`   Fixes applied: ${fixes.length}`);

if (fixes.length > 0) {
  console.log(`\n🔧 Applied fixes:`);
  fixes.forEach((fix, index) => {
    console.log(`   ${index + 1}. ${fix.description} (line ${fix.line})`);
  });
}

console.log(`\n✅ AST-based mocking fix completed!`); 
