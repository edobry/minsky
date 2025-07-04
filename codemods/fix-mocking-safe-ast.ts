import { Project, SyntaxKind, Node } from "ts-morph";

interface Fix {
  file: string;
  line: number;
  description: string;
}

const fixes: Fix[] = [];

function fixMockingSafeAST(): void {
  console.log("🚀 Starting safe AST-based mocking.ts unknown type fixes...");
  
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

    // Find all arrow functions with unknown parameters
    const arrowFunctions = sourceFile.getDescendantsOfKind(SyntaxKind.ArrowFunction);
    
    for (const arrowFunc of arrowFunctions) {
      const parameters = arrowFunc.getParameters();
      
      for (const param of parameters) {
        const paramName = param.getName();
        const typeNode = param.getTypeNode();
        
        // If parameter is typed as 'unknown'
        if (typeNode && typeNode.getText() === "unknown" && paramName === "command") {
          // Find the function body
          const body = arrowFunc.getBody();
          if (Node.isBlock(body)) {
            // Look for specific patterns in the function body text
            const bodyText = body.getText();
            
            // Pattern 1: command.includes(pattern)
            if (bodyText.includes("command.includes(")) {
              const startPos = arrowFunc.getStart();
              const endPos = arrowFunc.getEnd();
              const funcText = sourceText.substring(startPos, endPos);
              
              // Replace command.includes with (command as string).includes
              const newFuncText = funcText.replace(/\bcommand\.includes\(/g, "(command as string).includes(");
              
              if (newFuncText !== funcText) {
                sourceText = sourceText.substring(0, startPos) + newFuncText + sourceText.substring(endPos);
                fileChanged = true;
                
                fixes.push({
                  file: targetFile,
                  line: arrowFunc.getStartLineNumber(),
                  description: `Fixed command.includes() with string type assertion`
                });
              }
            }
          }
        }
      }
    }

    // Find all function expressions and declarations with unknown parameters
    const allFunctions = [
      ...sourceFile.getDescendantsOfKind(SyntaxKind.FunctionDeclaration),
      ...sourceFile.getDescendantsOfKind(SyntaxKind.FunctionExpression)
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
            
            // Pattern 1: files.has(path) where path is unknown
            if (paramName === "path" && bodyText.includes("files.has(path)")) {
              const startPos = func.getStart();
              const endPos = func.getEnd();
              const funcText = sourceText.substring(startPos, endPos);
              
              const newFuncText = funcText.replace(/files\.has\(path\)/g, "files.has(path as string)");
              
              if (newFuncText !== funcText) {
                sourceText = sourceText.substring(0, startPos) + newFuncText + sourceText.substring(endPos);
                fileChanged = true;
                
                fixes.push({
                  file: targetFile,
                  line: func.getStartLineNumber(),
                  description: `Fixed files.has(path) with string type assertion`
                });
              }
            }
            
            // Pattern 2: files.get(path) where path is unknown
            if (paramName === "path" && bodyText.includes("files.get(path)")) {
              const startPos = func.getStart();
              const endPos = func.getEnd();
              const funcText = sourceText.substring(startPos, endPos);
              
              const newFuncText = funcText.replace(/files\.get\(path\)/g, "files.get(path as string)");
              
              if (newFuncText !== funcText) {
                sourceText = sourceText.substring(0, startPos) + newFuncText + sourceText.substring(endPos);
                fileChanged = true;
                
                fixes.push({
                  file: targetFile,
                  line: func.getStartLineNumber(),
                  description: `Fixed files.get(path) with string type assertion`
                });
              }
            }
            
            // Pattern 3: files.set(path, data) where both are unknown
            if (bodyText.includes("files.set(path") && (paramName === "path" || paramName === "data")) {
              const startPos = func.getStart();
              const endPos = func.getEnd();
              const funcText = sourceText.substring(startPos, endPos);
              
              const newFuncText = funcText.replace(/files\.set\(path,\s*data\)/g, "files.set(path as string, data as string)");
              
              if (newFuncText !== funcText) {
                sourceText = sourceText.substring(0, startPos) + newFuncText + sourceText.substring(endPos);
                fileChanged = true;
                
                fixes.push({
                  file: targetFile,
                  line: func.getStartLineNumber(),
                  description: `Fixed files.set(path, data) with string type assertions`
                });
              }
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
fixMockingSafeAST();

// Report results
console.log(`\n📋 Safe AST-based Mocking Fix Report:`);
console.log(`   Fixes applied: ${fixes.length}`);

if (fixes.length > 0) {
  console.log(`\n🔧 Applied fixes:`);
  fixes.forEach((fix, index) => {
    console.log(`   ${index + 1}. ${fix.description} (line ${fix.line})`);
  });
}

console.log(`\n✅ Safe AST-based mocking fix completed!`); 
