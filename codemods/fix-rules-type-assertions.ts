import { Project, SyntaxKind, Node } from "ts-morph";

interface Fix {
  file: string;
  line: number;
  description: string;
}

const fixes: Fix[] = [];

function fixRulesTypeAssertions(): void {
  console.log("🚀 Starting rules type assertion fixes...");
  
  const project = new Project({
    tsConfigFilePath: "tsconfig.json",
    skipAddingFilesFromTsConfig: true,
  });

  // Target only the specific rules file
  const targetFile = "src/adapters/shared/commands/rules.ts";
  
  try {
    const sourceFile = project.addSourceFileAtPath(targetFile);
    console.log(`📁 Processing ${targetFile}...`);

    let fileChanged = false;

    // Find all property access expressions in the file
    const propertyAccessExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression);
    
    for (const propAccess of propertyAccessExpressions) {
      const expression = propAccess.getExpression();
      const propertyName = propAccess.getName();
      
      // Look for params.property patterns where params is unknown
      if (Node.isIdentifier(expression) && expression.getText() === "params") {
        // Check if we're in a function that has a type assertion
        const functionDecl = propAccess.getFirstAncestorByKind(SyntaxKind.ArrowFunction);
        
        if (functionDecl) {
          const block = functionDecl.getBody();
          if (Node.isBlock(block)) {
            const statements = block.getStatements();
            
            // Look for type assertion like "const typedParams = params as SomeType"
            const typeAssertionStmt = statements.find(stmt => {
              if (Node.isVariableStatement(stmt)) {
                const declarations = stmt.getDeclarationList().getDeclarations();
                return declarations.some(decl => {
                  const initializer = decl.getInitializer();
                  return Node.isAsExpression(initializer) && 
                         Node.isIdentifier(initializer.getExpression()) &&
                         initializer.getExpression().getText() === "params";
                });
              }
              return false;
            });
            
            if (typeAssertionStmt) {
              // Get the typed variable name
              const declarations = (typeAssertionStmt as any).getDeclarationList().getDeclarations();
              const typedVarName = declarations[0].getName();
              
              // Replace params.property with typedParams.property
              const newText = `${typedVarName}.${propertyName}`;
              propAccess.replaceWithText(newText);
              fileChanged = true;
              
              fixes.push({
                file: targetFile,
                line: propAccess.getStartLineNumber(),
                description: `Fixed type assertion: params.${propertyName} → ${newText}`
              });
            }
          }
        }
      }
    }

    if (fileChanged) {
      sourceFile.saveSync();
      console.log(`✅ Fixed type assertions in ${targetFile}`);
    } else {
      console.log(`ℹ️  No type assertion changes needed in ${targetFile}`);
    }

  } catch (error) {
    console.log(`❌ Error processing ${targetFile}: ${error}`);
  }
}

// Run the fix
fixRulesTypeAssertions();

// Report results
console.log(`\n📋 Rules Type Assertion Fix Report:`);
console.log(`   Fixes applied: ${fixes.length}`);

if (fixes.length > 0) {
  console.log(`\n🔧 Applied fixes:`);
  fixes.forEach((fix, index) => {
    console.log(`   ${index + 1}. ${fix.description} (line ${fix.line})`);
  });
}

console.log(`\n✅ Rules type assertion fix completed!`); 
