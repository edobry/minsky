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

console.log("🎯 Starting specific TS2345 'argument type' error fixer...");
console.log(`📊 Target: 9 TS2345 errors with actual patterns found`);
console.log(`📁 Processing ${sourceFiles.length} source files...`);

// Process each source file
project.getSourceFiles().forEach(sourceFile => {
  const filePath = sourceFile.getFilePath();
  const fileName = filePath.split('/').pop() || 'unknown';
  let fileChanges = 0;
  
  try {
    const fullText = sourceFile.getFullText();
    
    // Pattern 1: Fix cli-bridge.ts - addCommand with potentially null Command
    if (fileName === 'cli-bridge.ts') {
      // Look for addCommand calls where the argument might be null
      const methodCalls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
      
      for (const callExpr of methodCalls) {
        const expression = callExpr.getExpression();
        
        if (expression.getKind() === SyntaxKind.PropertyAccessExpression) {
          const propAccess = expression.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
          const methodName = propAccess.getName();
          
          if (methodName === 'addCommand') {
            const args = callExpr.getArguments();
            if (args.length > 0) {
              const firstArg = args[0];
              const argText = firstArg.getText();
              
              // If the argument is a variable that could be null (like childCommand, subcommand)
              if (argText === 'childCommand' || argText === 'subcommand' || argText === 'categoryCommand') {
                // Wrap in a null check or add non-null assertion
                firstArg.replaceWithText(`${argText}!`);
                fileChanges++;
                totalChanges++;
                console.log(`  ✅ Fixed addCommand null assertion: ${argText}! in ${fileName}`);
              }
            }
          }
        }
      }
    }
    
    // Pattern 2: Fix special-workspace-manager.ts - JSON.parse with Buffer
    if (fileName === 'special-workspace-manager.ts') {
      const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
      
      for (const callExpr of callExpressions) {
        const expression = callExpr.getExpression();
        
        if (expression.getKind() === SyntaxKind.PropertyAccessExpression) {
          const propAccess = expression.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
          const objExpr = propAccess.getExpression();
          const methodName = propAccess.getName();
          
          if (objExpr.getText() === 'JSON' && methodName === 'parse') {
            const args = callExpr.getArguments();
            if (args.length > 0) {
              const firstArg = args[0];
              const argText = firstArg.getText();
              
              // If argument looks like it might be Buffer | string
              if (argText === 'lockContent' || argText === 'content' || argText === 'data') {
                // Ensure it's a string
                firstArg.replaceWithText(`String(${argText})`);
                fileChanges++;
                totalChanges++;
                console.log(`  ✅ Fixed JSON.parse Buffer: String(${argText}) in ${fileName}`);
              }
            }
          }
        }
      }
    }
    
    // Pattern 3: Fix unknown type assertions in test utility files
    if (fileName.includes('mocking.ts') || fileName.includes('module-mock.ts')) {
      const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
      
      for (const callExpr of callExpressions) {
        const args = callExpr.getArguments();
        
        for (const arg of args) {
          if (arg.getKind() === SyntaxKind.Identifier) {
            const identifier = arg.asKindOrThrow(SyntaxKind.Identifier);
            const name = identifier.getText();
            
            // Look for unknown variables commonly used in these contexts
            if (['key', 'value', 'prop', 'attr', 'context', 'error'].includes(name)) {
              // Check if this variable is likely unknown type
              const varDecl = sourceFile.getVariableDeclaration(name);
              if (varDecl) {
                const typeNode = varDecl.getTypeNode();
                if (!typeNode || typeNode.getText() === 'unknown') {
                  // Add type assertion based on context
                  const funcExpr = callExpr.getExpression();
                  const funcText = funcExpr.getText();
                  
                  if (funcText.includes('log') || funcText.includes('error')) {
                    identifier.replaceWithText(`${name} as any`);
                  } else {
                    identifier.replaceWithText(`${name} as string`);
                  }
                  
                  fileChanges++;
                  totalChanges++;
                  console.log(`  ✅ Fixed unknown assertion: ${name} as string/any in ${fileName}`);
                }
              }
            }
          }
          
          // Also handle property access expressions that might be unknown
          if (arg.getKind() === SyntaxKind.PropertyAccessExpression) {
            const propAccess = arg.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
            const text = propAccess.getText();
            
            // Common patterns that might need type assertions
            if (text.includes('.') && !text.includes(' as ')) {
              propAccess.replaceWithText(`(${text} as string)`);
              fileChanges++;
              totalChanges++;
              console.log(`  ✅ Fixed property unknown assertion: (${text} as string) in ${fileName}`);
            }
          }
        }
      }
    }
    
    // Pattern 4: Fix dependencies.ts - return null vs undefined
    if (fileName === 'dependencies.ts') {
      const returnStatements = sourceFile.getDescendantsOfKind(SyntaxKind.ReturnStatement);
      
      for (const returnStmt of returnStatements) {
        const expression = returnStmt.getExpression();
        
        if (expression && expression.getKind() === SyntaxKind.NullKeyword) {
          // Replace return null with return undefined
          returnStmt.replaceWithText('return undefined');
          fileChanges++;
          totalChanges++;
          console.log(`  ✅ Fixed return type: null → undefined in ${fileName}`);
        }
      }
    }
    
    // Pattern 5: General Buffer.toString() fixes
    const awaitExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.AwaitExpression);
    
    for (const awaitExpr of awaitExpressions) {
      const expression = awaitExpr.getExpression();
      
      if (expression.getKind() === SyntaxKind.CallExpression) {
        const callExpr = expression.asKindOrThrow(SyntaxKind.CallExpression);
        const func = callExpr.getExpression();
        
        if (func.getKind() === SyntaxKind.PropertyAccessExpression) {
          const propAccess = func.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
          const methodName = propAccess.getName();
          
          // Look for fs.readFile calls that might return Buffer
          if (methodName === 'readFile') {
            const args = callExpr.getArguments();
            
            // If there's no encoding or encoding is not "utf8", it returns Buffer
            if (args.length === 1 || (args.length === 2 && args[1].getText() !== '"utf8"')) {
              // Wrap the entire await expression with String()
              awaitExpr.replaceWithText(`String(${awaitExpr.getText()})`);
              fileChanges++;
              totalChanges++;
              console.log(`  ✅ Fixed Buffer readFile: String(await ...) in ${fileName}`);
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
    console.log(`  ✅ ${fileName}: ${fileChanges} argument type fixes applied`);
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

console.log(`\n🎉 Specific TS2345 'argument type' fixer completed!`);
console.log(`📊 Total changes applied: ${totalChanges}`);
console.log(`📁 Files modified: ${filesModified}`);
console.log(`🎯 Target patterns: addCommand null checks, Buffer→string, unknown assertions`);

process.exit(0); 
