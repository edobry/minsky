import { Project, SyntaxKind, Node } from "ts-morph";

interface Fix {
  file: string;
  line: number;
  description: string;
}

const fixes: Fix[] = [];

function fixMockingComprehensiveAST(): void {
  console.log("🚀 Starting comprehensive AST-based mocking.ts unknown type fixes...");
  
  const project = new Project({
    tsConfigFilePath: "tsconfig.json",
    skipAddingFilesFromTsConfig: true,
  });

  const targetFile = "src/utils/test-utils/mocking.ts";
  
  try {
    const sourceFile = project.addSourceFileAtPath(targetFile);
    console.log(`📁 Processing ${targetFile}...`);

    // Get the original source text
    let sourceText = sourceFile.getFullText();
    let fileChanged = false;

    // Find all functions with unknown parameters
    const allFunctions = [
      ...sourceFile.getDescendantsOfKind(SyntaxKind.FunctionDeclaration),
      ...sourceFile.getDescendantsOfKind(SyntaxKind.FunctionExpression),
      ...sourceFile.getDescendantsOfKind(SyntaxKind.ArrowFunction)
    ];

    for (const func of allFunctions) {
      const parameters = func.getParameters();
      
      for (const param of parameters) {
        const paramName = param.getName();
        const typeNode = param.getTypeNode();
        
        // If parameter is typed as 'unknown'
        if (typeNode && typeNode.getText() === "unknown") {
          const body = func.getBody();
          if (Node.isBlock(body)) {
            const bodyText = body.getText();
            const startPos = func.getStart();
            const endPos = func.getEnd();
            const funcText = sourceText.substring(startPos, endPos);
            let newFuncText = funcText;
            
            // Pattern 1: files.has(path) where path is unknown
            if (paramName === "path" && bodyText.includes("files.has(path)")) {
              newFuncText = newFuncText.replace(/files\.has\(path\)/g, "files.has(path as string)");
            }
            
            // Pattern 2: files.get(path) where path is unknown
            if (paramName === "path" && bodyText.includes("files.get(path)")) {
              newFuncText = newFuncText.replace(/files\.get\(path\)/g, "files.get(path as string)");
            }
            
            // Pattern 3: files.set(path, data) where both are unknown
            if (bodyText.includes("files.set(path") && (paramName === "path" || paramName === "data")) {
              newFuncText = newFuncText.replace(/files\.set\(path,\s*data\)/g, "files.set(path as string, data as string)");
            }
            
            // Pattern 4: files.delete(path) where path is unknown
            if (paramName === "path" && bodyText.includes("files.delete(path)")) {
              newFuncText = newFuncText.replace(/files\.delete\(path\)/g, "files.delete(path as string)");
            }
            
            // Pattern 5: directories.has(path) where path is unknown
            if (paramName === "path" && bodyText.includes("directories.has(path)")) {
              newFuncText = newFuncText.replace(/directories\.has\(path\)/g, "directories.has(path as string)");
            }
            
            // Pattern 6: directories.add(path) where path is unknown
            if (paramName === "path" && bodyText.includes("directories.add(path)")) {
              newFuncText = newFuncText.replace(/directories\.add\(path\)/g, "directories.add(path as string)");
            }
            
            // Pattern 7: directories.delete(path) where path is unknown
            if (paramName === "path" && bodyText.includes("directories.delete(path)")) {
              newFuncText = newFuncText.replace(/directories\.delete\(path\)/g, "directories.delete(path as string)");
            }
            
            // Pattern 8: path.split("/") where path is unknown
            if (paramName === "path" && bodyText.includes("path.split(\"/\")")) {
              newFuncText = newFuncText.replace(/path\.split\("\/"\)/g, "(path as string).split(\"/\")");
            }
            
            // Pattern 9: path.startsWith where path is unknown
            if (paramName === "path" && bodyText.includes("path.startsWith(")) {
              newFuncText = newFuncText.replace(/path\.startsWith\(/g, "(path as string).startsWith(");
            }
            
            // Pattern 10: `${path}/` template literal where path is unknown
            if (paramName === "path" && bodyText.includes("`${path}/`")) {
              newFuncText = newFuncText.replace(/`\$\{path\}\/`/g, "`${path as string}/`");
            }
            
            // Pattern 11: command.includes(pattern) where command is unknown
            if (paramName === "command" && bodyText.includes("command.includes(")) {
              newFuncText = newFuncText.replace(/command\.includes\(/g, "(command as string).includes(");
            }
            
            // Apply changes if any were made
            if (newFuncText !== funcText) {
              sourceText = sourceText.substring(0, startPos) + newFuncText + sourceText.substring(endPos);
              fileChanged = true;
              
              fixes.push({
                file: targetFile,
                line: func.getStartLineNumber(),
                description: `Fixed unknown type assertions for parameter: ${paramName}`
              });
            }
          }
        }
      }
    }

    if (fileChanged) {
      sourceFile.replaceWithText(sourceText);
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
fixMockingComprehensiveAST();

// Report results
console.log(`\n📋 Comprehensive AST-based Mocking Fix Report:`);
console.log(`   Fixes applied: ${fixes.length}`);

if (fixes.length > 0) {
  console.log(`\n🔧 Applied fixes:`);
  fixes.forEach((fix, index) => {
    console.log(`   ${index + 1}. ${fix.description} (line ${fix.line})`);
  });
}

console.log(`\n✅ Comprehensive AST-based mocking fix completed!`); 
