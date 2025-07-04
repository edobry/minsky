import { Project, SyntaxKind, Node } from "ts-morph";

interface Fix {
  file: string;
  line: number;
  description: string;
}

const fixes: Fix[] = [];

function fixTypeAssertions(): void {
  console.log("🚀 Starting type assertion fixes...");
  
  const project = new Project({
    tsConfigFilePath: "tsconfig.json",
    skipAddingFilesFromTsConfig: true,
  });

  // Add all TypeScript files
  const files = project.addSourceFilesAtPaths("src/**/*.ts");
  console.log(`📁 Adding ${files.length} TypeScript files to project...`);

  let totalIssues = 0;
  let totalFixes = 0;

  for (const sourceFile of files) {
    const filePath = sourceFile.getFilePath();
    let fileChanged = false;

    try {
      // Skip files with syntax errors
      const diagnostics = sourceFile.getPreEmitDiagnostics();
      const syntaxErrors = diagnostics.filter(d => d.getCategory() === 1); // Error category
      if (syntaxErrors.length > 0) {
        console.log(`⚠️  Skipping ${filePath} due to syntax errors`);
        continue;
      }
    } catch (error) {
      console.log(`⚠️  Skipping ${filePath} due to parsing errors`);
      continue;
    }

    // Find property access expressions that access unknown types
    const propertyAccessExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression);
    
    for (const propAccess of propertyAccessExpressions) {
      const expression = propAccess.getExpression();
      const propertyName = propAccess.getName();
      
      // Look for common patterns like params.id, args.content, etc.
      if (Node.isIdentifier(expression)) {
        const varName = expression.getText();
        
        // If this is accessing properties on 'params' or 'args' that are unknown
        if ((varName === "params" || varName === "args") && 
            (propertyName === "id" || propertyName === "content" || propertyName === "format" || 
             propertyName === "debug" || propertyName === "name" || propertyName === "description")) {
          
          // Check if we're in a function that has typed parameters
          const functionDecl = propAccess.getFirstAncestorByKind(SyntaxKind.ArrowFunction) ||
                              propAccess.getFirstAncestorByKind(SyntaxKind.FunctionDeclaration) ||
                              propAccess.getFirstAncestorByKind(SyntaxKind.MethodDeclaration);
          
          if (functionDecl) {
            const parameters = functionDecl.getParameters();
            const paramsParam = parameters.find(p => p.getName() === varName);
            
            if (paramsParam) {
              const typeNode = paramsParam.getTypeNode();
              if (typeNode && typeNode.getText() === "unknown") {
                // Look for a type assertion pattern like "const typedParams = params as SomeType"
                const block = functionDecl.getBody();
                if (Node.isBlock(block)) {
                  const statements = block.getStatements();
                  const typeAssertionStmt = statements.find(stmt => {
                    if (Node.isVariableStatement(stmt)) {
                      const declarations = stmt.getDeclarationList().getDeclarations();
                      return declarations.some(decl => {
                        const initializer = decl.getInitializer();
                        return Node.isAsExpression(initializer) && 
                               Node.isIdentifier(initializer.getExpression()) &&
                               initializer.getExpression().getText() === varName;
                      });
                    }
                    return false;
                  });
                  
                  if (typeAssertionStmt) {
                    // Find the typed variable name
                    const declarations = (typeAssertionStmt as any).getDeclarationList().getDeclarations();
                    const typedVarName = declarations[0].getName();
                    
                    // Replace params.property with typedParams.property
                    const newText = `${typedVarName}.${propertyName}`;
                    propAccess.replaceWithText(newText);
                    fileChanged = true;
                    
                    fixes.push({
                      file: filePath,
                      line: propAccess.getStartLineNumber(),
                      description: `Fixed type assertion: ${varName}.${propertyName} → ${newText}`
                    });
                    totalFixes++;
                  }
                }
              }
            }
          }
        }
      }
    }

    // Find object literal properties that need renaming
    const objectLiterals = sourceFile.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression);
    
    for (const objectLiteral of objectLiterals) {
      const properties = objectLiteral.getProperties();
      
      for (const property of properties) {
        if (Node.isPropertyAssignment(property)) {
          const nameNode = property.getNameNode();
          if (Node.isIdentifier(nameNode)) {
            const propName = nameNode.getText();
            
            // Fix common property name issues
            const propertyFixes: Record<string, string> = {
              "_parameters": "parameters",
              "params": "parameters"
            };
            
            if (propertyFixes[propName]) {
              const newName = propertyFixes[propName];
              nameNode.replaceWithText(newName);
              fileChanged = true;
              
              fixes.push({
                file: filePath,
                line: property.getStartLineNumber(),
                description: `Fixed property name: ${propName} → ${newName}`
              });
              totalFixes++;
            }
          }
        }
      }
    }

    totalIssues += fileChanged ? 1 : 0;

    if (fileChanged) {
      sourceFile.saveSync();
    }
  }

  console.log(`🔧 Applying ${totalFixes} changes...`);
  console.log(`💾 Saving changes...`);
  console.log(`💾 Saved changes to ${files.length} files`);
}

// Run the fix
fixTypeAssertions();

// Report results
console.log(`\n📋 Type Assertion Fix Report:`);
console.log(`   Fixes applied: ${fixes.length}`);

if (fixes.length > 0) {
  console.log(`\n🔧 Applied fixes:`);
  fixes.forEach((fix, index) => {
    console.log(`✅ ${fix.description} in ${fix.file}:${fix.line}`);
  });
}

console.log(`\n✅ Type assertion fix completed!`); 
