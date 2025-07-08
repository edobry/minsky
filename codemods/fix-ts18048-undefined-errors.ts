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

console.log("🎯 Starting TS18048 'possibly undefined' error fixer...");
console.log(`📊 Target: 13 TS18048 errors (13.7% of remaining 95 errors)`);
console.log(`📁 Processing ${sourceFiles.length} source files...`);

// Process each source file
project.getSourceFiles().forEach(sourceFile => {
  const filePath = sourceFile.getFilePath();
  const fileName = filePath.split('/').pop();
  let fileChanges = 0;
  
  // Pattern 1: Fix property access expressions that might be undefined
  const propertyAccessExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression);
  
  for (const propAccess of propertyAccessExpressions) {
    try {
      const expression = propAccess.getExpression();
      const name = propAccess.getName();
      
      // Common patterns that need fixes
      const problemPatterns = [
        { expr: 'config.github', prop: 'github' },
        { expr: 'globalConfig.github', prop: 'github' },
        { expr: 'repository.sessiondb', prop: 'sessiondb' },
        { expr: 'globalUser.sessiondb', prop: 'sessiondb' }
      ];
      
      const fullText = propAccess.getText();
      
      for (const pattern of problemPatterns) {
        if (fullText === pattern.expr) {
          // Check if we're in an assignment or conditional context
          const parent = propAccess.getParent();
          
          // If we're accessing a property after this, use optional chaining
          if (parent && parent.getKind() === SyntaxKind.PropertyAccessExpression) {
            // Replace with optional chaining
            propAccess.replaceWithText(`${expression.getText()}?.${name}`);
            fileChanges++;
            totalChanges++;
            console.log(`  ✅ Fixed optional chaining for ${pattern.expr} in ${fileName}`);
            break;
          }
          // If we're in a condition or assignment, add null check
          else if (parent && (
            parent.getKind() === SyntaxKind.IfStatement ||
            parent.getKind() === SyntaxKind.BinaryExpression ||
            parent.getKind() === SyntaxKind.ConditionalExpression
          )) {
            // Add parentheses and optional chaining
            propAccess.replaceWithText(`(${expression.getText()}?.${name})`);
            fileChanges++;
            totalChanges++;
            console.log(`  ✅ Fixed conditional access for ${pattern.expr} in ${fileName}`);
            break;
          }
        }
      }
    } catch (error) {
      console.log(`  ⚠️  Skipping complex property access in ${fileName}`);
      continue;
    }
  }
  
  // Pattern 2: Fix variable access that might be undefined
  const identifiers = sourceFile.getDescendantsOfKind(SyntaxKind.Identifier);
  
  for (const identifier of identifiers) {
    try {
      const text = identifier.getText();
      
      // Common undefined variables we see in errors
      if (text === 'lastError') {
        const parent = identifier.getParent();
        
        // If we're accessing a property on lastError
        if (parent && parent.getKind() === SyntaxKind.PropertyAccessExpression) {
          const propAccess = parent.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
          
          // Check if lastError is the expression part (not the property part)
          if (propAccess.getExpression() === identifier) {
            // Replace with optional chaining
            identifier.replaceWithText(`${text}?`);
            fileChanges++;
            totalChanges++;
            console.log(`  ✅ Fixed optional chaining for ${text} in ${fileName}`);
          }
        }
      }
    } catch (error) {
      console.log(`  ⚠️  Skipping identifier in ${fileName}`);
      continue;
    }
  }
  
  // Pattern 3: Fix assignment expressions with potentially undefined values
  const binaryExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.BinaryExpression);
  
  for (const binaryExpr of binaryExpressions) {
    try {
      const operator = binaryExpr.getOperatorToken();
      
      if (operator.getKind() === SyntaxKind.EqualsToken) {
        const right = binaryExpr.getRight();
        
        // Check if right side is a property access that might be undefined
        if (right.getKind() === SyntaxKind.PropertyAccessExpression) {
          const propAccess = right.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
          const fullText = propAccess.getText();
          
          // Common patterns that need default values
          const needsDefault = [
            'config.github',
            'globalConfig.github', 
            'repository.sessiondb',
            'globalUser.sessiondb'
          ];
          
          if (needsDefault.includes(fullText)) {
            // Add nullish coalescing with empty object
            right.replaceWithText(`${fullText} ?? {}`);
            fileChanges++;
            totalChanges++;
            console.log(`  ✅ Fixed assignment with default value for ${fullText} in ${fileName}`);
          }
        }
      }
    } catch (error) {
      console.log(`  ⚠️  Skipping binary expression in ${fileName}`);
      continue;
    }
  }
  
  if (fileChanges > 0) {
    filesModified++;
    console.log(`  ✅ ${fileName}: ${fileChanges} undefined fixes applied`);
  }
});

// Save all changes
console.log(`\n💾 Saving all changes...`);
project.saveSync();

console.log(`\n🎉 TS18048 'possibly undefined' fixer completed!`);
console.log(`📊 Total changes applied: ${totalChanges}`);
console.log(`📁 Files modified: ${filesModified}`);
console.log(`🎯 Target: TS18048 possibly undefined errors`); 
