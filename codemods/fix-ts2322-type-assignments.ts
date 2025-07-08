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

console.log("🎯 Starting TS2322 type assignment error fixer...");
console.log(`📊 Target: Type 'unknown' is not assignable errors in catch blocks`);
console.log(`📁 Processing ${sourceFiles.length} source files...`);

// Process each source file
project.getSourceFiles().forEach(sourceFile => {
  const filePath = sourceFile.getFilePath();
  const fileName = filePath.split('/').pop();
  let fileChanges = 0;
  
  // Find all catch clauses
  const catchClauses = sourceFile.getDescendantsOfKind(SyntaxKind.CatchClause);
  
  for (const catchClause of catchClauses) {
    try {
      const parameter = catchClause.getVariableDeclaration();
      if (!parameter) continue;
      
      const parameterName = parameter.getName();
      const block = catchClause.getBlock();
      
      // Look for return statements in catch blocks
      const returnStatements = block.getDescendantsOfKind(SyntaxKind.ReturnStatement);
      
      for (const returnStatement of returnStatements) {
        const expression = returnStatement.getExpression();
        if (!expression) continue;
        
        // Check if it's an object literal with error property
        if (expression.getKind() === SyntaxKind.ObjectLiteralExpression) {
          const objectLiteral = expression.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
          
          // Look for error property assignment
          const errorProperty = objectLiteral.getProperties().find(prop => {
            if (prop.getKind() === SyntaxKind.PropertyAssignment) {
              const propAssignment = prop.asKindOrThrow(SyntaxKind.PropertyAssignment);
              const name = propAssignment.getName();
              return name === 'error';
            }
            return false;
          });
          
          if (errorProperty) {
            const propAssignment = errorProperty.asKindOrThrow(SyntaxKind.PropertyAssignment);
            const initializer = propAssignment.getInitializer();
            
            // Check if the initializer is just the error parameter
            if (initializer && initializer.getKind() === SyntaxKind.Identifier) {
              const identifier = initializer.asKindOrThrow(SyntaxKind.Identifier);
              if (identifier.getText() === parameterName) {
                // Replace with proper type assertion
                identifier.replaceWithText(`${parameterName} instanceof Error ? ${parameterName} : new Error(String(${parameterName}))`);
                fileChanges++;
                totalChanges++;
                console.log(`  ✅ Fixed catch block error assignment in ${fileName}`);
              }
            }
          }
        }
      }
    } catch (error) {
      console.log(`  ⚠️  Skipping complex catch clause in ${fileName}`);
      continue;
    }
  }
  
  // Pattern 2: Fix string literals that should be enums
  const stringLiterals = sourceFile.getDescendantsOfKind(SyntaxKind.StringLiteral);
  
  for (const stringLiteral of stringLiterals) {
    try {
      const text = stringLiteral.getLiteralValue();
      
      // Check if it's a TaskStatus-like value
      const taskStatusValues = ['OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED', 'BLOCKED'];
      
      if (taskStatusValues.includes(text)) {
        const parent = stringLiteral.getParent();
        
        // Check if parent is a property assignment and we're assigning to status
        if (parent && parent.getKind() === SyntaxKind.PropertyAssignment) {
          const propAssignment = parent.asKindOrThrow(SyntaxKind.PropertyAssignment);
          const name = propAssignment.getName();
          
          if (name === 'status' || name === 'taskStatus') {
            // Add type assertion
            stringLiteral.replaceWithText(`"${text}" as TaskStatus`);
            fileChanges++;
            totalChanges++;
            console.log(`  ✅ Fixed TaskStatus assignment in ${fileName}`);
          }
        }
      }
    } catch (error) {
      console.log(`  ⚠️  Skipping string literal in ${fileName}`);
      continue;
    }
  }
  
  // Pattern 3: Fix object literal type assignments in error handling
  const objectLiterals = sourceFile.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression);
  
  for (const objectLiteral of objectLiterals) {
    try {
      const properties = objectLiteral.getProperties();
      
      // Look for error objects with type and severity properties
      const hasType = properties.some(prop => {
        if (prop.getKind() === SyntaxKind.PropertyAssignment) {
          const propAssignment = prop.asKindOrThrow(SyntaxKind.PropertyAssignment);
          return propAssignment.getName() === 'type';
        }
        return false;
      });
      
      const hasSeverity = properties.some(prop => {
        if (prop.getKind() === SyntaxKind.PropertyAssignment) {
          const propAssignment = prop.asKindOrThrow(SyntaxKind.PropertyAssignment);
          return propAssignment.getName() === 'severity';
        }
        return false;
      });
      
      if (hasType && hasSeverity) {
        // Look for properties with 'as any' that need proper typing
        for (const prop of properties) {
          if (prop.getKind() === SyntaxKind.PropertyAssignment) {
            const propAssignment = prop.asKindOrThrow(SyntaxKind.PropertyAssignment);
            const initializer = propAssignment.getInitializer();
            
            if (initializer && initializer.getText().includes(' as any')) {
              const propName = propAssignment.getName();
              
              // Remove the 'as any' cast for common error object properties
              if (propName === 'type' || propName === 'severity') {
                const newText = initializer.getText().replace(' as any', '');
                initializer.replaceWithText(newText);
                fileChanges++;
                totalChanges++;
                console.log(`  ✅ Fixed error object property ${propName} in ${fileName}`);
              }
            }
          }
        }
      }
    } catch (error) {
      console.log(`  ⚠️  Skipping object literal in ${fileName}`);
      continue;
    }
  }
  
  if (fileChanges > 0) {
    filesModified++;
    console.log(`  ✅ ${fileName}: ${fileChanges} type assignment fixes applied`);
  }
});

// Save all changes
console.log(`\n💾 Saving all changes...`);
project.saveSync();

console.log(`\n🎉 TS2322 type assignment fixer completed!`);
console.log(`📊 Total changes applied: ${totalChanges}`);
console.log(`📁 Files modified: ${filesModified}`);
console.log(`🎯 Target: TS2322 type assignment errors`); 
