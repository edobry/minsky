#!/usr/bin/env bun

import { Project, SyntaxKind } from "ts-morph";
import { readdirSync, statSync } from "fs";
import { join } from "path";

const project = new Project({
  tsConfigFilePath: "./tsconfig.json",
  skipAddingFilesFromTsConfig: true,
});

function getAllTsFiles(dir: string): string[] {
  const files: string[] = [];
  const items = readdirSync(dir);
  
  for (const item of items) {
    const fullPath = join(dir, item);
    const stat = statSync(fullPath);
    
    if (stat.isDirectory() && !item.startsWith('.') && item !== 'node_modules') {
      files.push(...getAllTsFiles(fullPath));
    } else if (item.endsWith('.ts') && !item.endsWith('.d.ts')) {
      files.push(fullPath);
    }
  }
  
  return files;
}

// Add all TypeScript files
const sourceFiles = getAllTsFiles("./src");
sourceFiles.forEach(file => project.addSourceFileAtPath(file));

let totalChanges = 0;

console.log("🎯 Final elimination of remaining 5 TS2322 errors...");

// Fix each specific remaining error
project.getSourceFiles().forEach(sourceFile => {
  const filePath = sourceFile.getFilePath();
  const fileName = filePath.split('/').pop() || 'unknown';
  let fileChanges = 0;

  // Fix 1: Jest mock compatibility in test-utils/compatibility/index.ts
  if (fileName === 'index.ts' && filePath.includes('test-utils/compatibility')) {
    // Make the factory parameter required in the mock function
    const objectLiterals = sourceFile.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression);
    
    for (const objLiteral of objectLiterals) {
      const properties = objLiteral.getProperties();
      
      for (const prop of properties) {
        if (prop.getKind() === SyntaxKind.PropertyAssignment) {
          const propAssign = prop.asKindOrThrow(SyntaxKind.PropertyAssignment);
          
          if (propAssign.getName() === 'mock') {
            const initializer = propAssign.getInitializer();
            
            if (initializer && initializer.getKind() === SyntaxKind.ArrowFunction) {
              const arrowFunc = initializer.asKindOrThrow(SyntaxKind.ArrowFunction);
              
              // Get the function text and fix the signature
              const funcText = arrowFunc.getText();
              
              // Replace the factory parameter to make it required
              const fixedFunc = funcText.replace(
                'factory?: () => any',
                'factory: () => any'
              );
              
              if (fixedFunc !== funcText) {
                arrowFunc.replaceWithText(fixedFunc);
                fileChanges++;
                totalChanges++;
                console.log(`  ✅ Fixed Jest mock factory parameter to be required in ${fileName}`);
              }
            }
          }
        }
      }
    }
  }

  // Fix 2: Promise return type issues in dependencies.ts
  if (fileName === 'dependencies.ts' && filePath.includes('test-utils')) {
    const propertyAssignments = sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAssignment);
    
    for (const prop of propertyAssignments) {
      const propName = prop.getName();
      const initializer = prop.getInitializer();
      
      if (initializer && initializer.getKind() === SyntaxKind.ArrowFunction) {
        const arrowFunc = initializer.asKindOrThrow(SyntaxKind.ArrowFunction);
        const body = arrowFunc.getBody();
        
        // Check for Promise.resolve(null) that should return string | undefined
        if (body.getKind() === SyntaxKind.CallExpression) {
          const callExpr = body.asKindOrThrow(SyntaxKind.CallExpression);
          const expression = callExpr.getExpression();
          
          if (expression.getKind() === SyntaxKind.PropertyAccessExpression) {
            const propAccess = expression.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
            
            if (propAccess.getExpression().getText() === 'Promise' && propAccess.getName() === 'resolve') {
              const args = callExpr.getArguments();
              
              if (args.length === 1 && args[0].getText() === 'null') {
                // Check if this should return string | undefined
                if (propName && (
                  propName.includes('Status') || 
                  propName.includes('Path') || 
                  propName.includes('getRepo') || 
                  propName.includes('getWorkspace') ||
                  propName.includes('getTask') && !propName.includes('getTaskId')
                )) {
                  // Should return string | undefined
                  args[0].replaceWithText('undefined');
                  fileChanges++;
                  totalChanges++;
                  console.log(`  ✅ Fixed Promise.resolve(null) → Promise.resolve(undefined) for ${propName} in ${fileName}`);
                }
              }
            }
          }
        }
      }
    }
  }

  if (fileChanges > 0) {
    console.log(`  📝 ${fileName}: ${fileChanges} final TS2322 errors fixed`);
  }
});

// Save all changes
console.log(`\n💾 Saving changes...`);
project.saveSync();

console.log(`\n🎉 Final TS2322 elimination completed!`);
console.log(`📊 Total changes: ${totalChanges}`);
console.log(`🎯 All remaining TS2322 errors should now be eliminated`);

process.exit(0); 
