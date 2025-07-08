import { Project, SyntaxKind, Node } from "ts-morph";

interface Fix {
  file: string;
  line: number;
  description: string;
}

const fixes: Fix[] = [];

function fixBunCompatibilityAST(): void {
  console.log("🚀 Starting AST-based Bun compatibility fixes...");
  
  const project = new Project({
    tsConfigFilePath: "tsconfig.json",
    skipAddingFilesFromTsConfig: true,
  });

  const targetFiles = [
    "src/scripts/test-analyzer.ts",
    "src/scripts/task-title-migration.ts"
  ];
  
  for (const targetFile of targetFiles) {
    try {
      const sourceFile = project.addSourceFileAtPath(targetFile);
      console.log(`📁 Processing ${targetFile}...`);

      let sourceText = sourceFile.getFullText();
      let fileChanged = false;

      // Pattern 1: Fix ___dirname (should be __dirname or import.meta.dirname)
      if (sourceText.includes("___dirname")) {
        sourceText = sourceText.replace(/___dirname/g, "__dirname");
        fileChanged = true;
        
        fixes.push({
          file: targetFile,
          line: 0,
          description: `Fixed ___dirname → __dirname`
        });
      }

      // Pattern 2: Fix process.argv → Bun.argv
      if (sourceText.includes("process.argv")) {
        sourceText = sourceText.replace(/process\.argv/g, "Bun.argv");
        fileChanged = true;
        
        fixes.push({
          file: targetFile,
          line: 0,
          description: `Fixed process.argv → Bun.argv`
        });
      }

      // Pattern 3: Add toString() for Buffer types used with string methods
      // Look for Buffer variables used with .match() or other string methods
      const identifiers = sourceFile.getDescendantsOfKind(SyntaxKind.Identifier);
      
      for (const identifier of identifiers) {
        const parent = identifier.getParent();
        
        // Check if this is a property access like variable.match()
        if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === identifier) {
          const propertyName = parent.getName();
          
          // For string methods on potentially Buffer types
          if (propertyName === "match" || propertyName === "replace" || 
              propertyName === "includes" || propertyName === "split") {
            
            // Check if the variable name suggests it might be a Buffer
            const varName = identifier.getText();
            if (varName.includes("output") || varName.includes("result") || 
                varName.includes("content") || varName.includes("data")) {
              
              // Replace with toString() call
              const startPos = identifier.getStart();
              const endPos = identifier.getEnd();
              const beforeIdentifier = sourceText.substring(0, startPos);
              const afterIdentifier = sourceText.substring(endPos);
              
              sourceText = beforeIdentifier + `${varName}.toString()` + afterIdentifier;
              fileChanged = true;
              
              fixes.push({
                file: targetFile,
                line: identifier.getStartLineNumber(),
                description: `Added toString() for Buffer string method: ${varName}.${propertyName}()`
              });
              
              // Break to avoid multiple replacements in same iteration
              break;
            }
          }
        }
      }

      if (fileChanged) {
        sourceFile.replaceWithText(sourceText);
        sourceFile.saveSync();
        console.log(`✅ Fixed Bun compatibility in ${targetFile}`);
      } else {
        console.log(`ℹ️  No Bun compatibility changes needed in ${targetFile}`);
      }

    } catch (error) {
      console.log(`❌ Error processing ${targetFile}: ${error}`);
    }
  }
}

// Run the fix
fixBunCompatibilityAST();

// Report results
console.log(`\n📋 Bun Compatibility Fix Report:`);
console.log(`   Fixes applied: ${fixes.length}`);

if (fixes.length > 0) {
  console.log(`\n🔧 Applied fixes:`);
  fixes.forEach((fix, index) => {
    console.log(`   ${index + 1}. ${fix.description} (line ${fix.line})`);
  });
}

console.log(`\n✅ Bun compatibility fix completed!`); 
