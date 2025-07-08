#!/usr/bin/env bun

import { Project, SyntaxKind } from "ts-morph";
import { readdirSync, statSync } from "fs";
import { join } from "path";

// Initialize TypeScript project
const project = new Project({
  tsConfigFilePath: "./tsconfig.json",
  skipAddingFilesFromTsConfig: true,
});

// Get all TypeScript source files recursively
function getAllTsFiles(dir: string): string[] {
  const files: string[] = [];
  
  const items = readdirSync(dir);
  
  for (const item of items) {
    const fullPath = join(dir, item);
    const stat = statSync(fullPath);
    
    if (stat.isDirectory() && !item.startsWith('.') && item !== 'node_modules') {
      files.push(...getAllTsFiles(fullPath));
    } else if (item.endsWith('.ts') && !item.endsWith('.d.ts') && !item.endsWith('.test.ts')) {
      files.push(fullPath);
    }
  }
  
  return files;
}

// Add source files to project (excluding scripts as per tsconfig)
const sourceFiles = getAllTsFiles("./src").filter(file => 
  !file.includes('/scripts/') && 
  !file.includes('test-utils') &&
  !file.includes('__tests__')
);

sourceFiles.forEach(file => project.addSourceFileAtPath(file));

let totalChanges = 0;
let filesModified = 0;

console.log("🎯 Starting precise fix for TS2345 argument errors...");
console.log(`📊 Target: Fix specific argument type mismatches`);
console.log(`📁 Processing ${sourceFiles.length} source files...`);

// Process each source file
project.getSourceFiles().forEach(sourceFile => {
  const filePath = sourceFile.getFilePath();
  const fileName = filePath.split('/').pop() || 'unknown';
  let fileChanges = 0;
  
  try {
    // Fix 1: cli-bridge.ts - Add null check before addCommand
    if (fileName === 'cli-bridge.ts') {
      // Find all if statements that check for childCommand
      const ifStatements = sourceFile.getDescendantsOfKind(SyntaxKind.IfStatement);
      
             for (const ifStmt of ifStatements) {
         const condition = ifStmt.getExpression();
         
         // Look for if (childCommand) statements
         if (condition.getKind() === SyntaxKind.Identifier && 
             condition.getText() === 'childCommand') {
          
          const thenStatement = ifStmt.getThenStatement();
          if (thenStatement.getKind() === SyntaxKind.Block) {
            const block = thenStatement.asKindOrThrow(SyntaxKind.Block);
            const statements = block.getStatements();
            
            // Look for addCommand calls that need fixing
            for (const stmt of statements) {
              if (stmt.getKind() === SyntaxKind.ExpressionStatement) {
                const expr = stmt.asKindOrThrow(SyntaxKind.ExpressionStatement).getExpression();
                
                // Check if it's a call expression to addCommand with non-null assertion
                if (expr.getKind() === SyntaxKind.CallExpression) {
                  const callExpr = expr.asKindOrThrow(SyntaxKind.CallExpression);
                  const callText = callExpr.getText();
                  
                  // Look for addCommand calls with non-null assertion
                  if (callText.includes('addCommand(childCommand!)')) {
                    // Replace childCommand! with just childCommand since we're inside an if(childCommand) block
                    const newText = callText.replace('childCommand!', 'childCommand');
                    callExpr.replaceWithText(newText);
                    fileChanges++;
                    totalChanges++;
                    console.log(`  ✅ Fixed addCommand non-null assertion in ${fileName}`);
                  }
                }
              }
            }
          }
        }
      }
    }
    
    // Fix 2: git.ts - Add missing workdir property to clone call
    if (fileName === 'git.ts') {
      const functions = sourceFile.getDescendantsOfKind(SyntaxKind.FunctionDeclaration);
      
      for (const func of functions) {
        if (func.getName() === 'cloneFromParams') {
          // Find the git.clone call
          const callExpressions = func.getDescendantsOfKind(SyntaxKind.CallExpression);
          
          for (const callExpr of callExpressions) {
            const expression = callExpr.getExpression();
            
            // Check if this is a git.clone() call
            if (expression.getKind() === SyntaxKind.PropertyAccessExpression) {
              const propAccess = expression.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
              
              if (propAccess.getName() === 'clone') {
                const args = callExpr.getArguments();
                
                if (args.length === 1 && args[0].getKind() === SyntaxKind.ObjectLiteralExpression) {
                  const objLiteral = args[0].asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
                  const properties = objLiteral.getProperties();
                  
                  // Check if workdir property is missing
                  const hasWorkdir = properties.some(prop => 
                    prop.getKind() === SyntaxKind.PropertyAssignment &&
                    prop.asKindOrThrow(SyntaxKind.PropertyAssignment).getName() === 'workdir'
                  );
                  
                  if (!hasWorkdir) {
                    // Add workdir property after repoUrl
                    const repoUrlProp = properties.find(prop => 
                      prop.getKind() === SyntaxKind.PropertyAssignment &&
                      prop.asKindOrThrow(SyntaxKind.PropertyAssignment).getName() === 'repoUrl'
                    );
                    
                    if (repoUrlProp) {
                      const repoUrlIndex = properties.indexOf(repoUrlProp);
                      objLiteral.insertPropertyAssignment(repoUrlIndex + 1, {
                        name: 'workdir',
                        initializer: '(params as any).workdir'
                      });
                      
                      fileChanges++;
                      totalChanges++;
                      console.log(`  ✅ Added missing workdir property to git.clone call in ${fileName}`);
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    
  } catch (error) {
    console.log(`  ⚠️  Error processing ${fileName}: ${error}`);
  }
  
  if (fileChanges > 0) {
    filesModified++;
    console.log(`  ✅ ${fileName}: ${fileChanges} argument errors fixed`);
  }
});

// Save all changes
console.log(`\n💾 Saving all changes...`);
try {
  project.saveSync();
  console.log(`✅ All changes saved successfully`);
} catch (error) {
  console.log(`❌ Error saving changes: ${error}`);
}

console.log(`\n🎉 Argument error fixes completed!`);
console.log(`📊 Total changes applied: ${totalChanges}`);
console.log(`📁 Files modified: ${filesModified}`);
console.log(`🎯 Target: Fix specific TS2345 argument type mismatches`);

process.exit(0); 
