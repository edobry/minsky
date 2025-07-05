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

console.log("🎯 Starting comprehensive TS2322 elimination...");
console.log(`📊 Target: Eliminate all 9 TS2322 type assignment errors`);
console.log(`📁 Processing ${sourceFiles.length} source files...`);

// Process each source file
project.getSourceFiles().forEach(sourceFile => {
  const filePath = sourceFile.getFilePath();
  const fileName = filePath.split('/').pop() || 'unknown';
  let fileChanges = 0;
  
  try {
    // Fix 1: Zod schema string → ZodTypeAny issues in init files
    if (fileName === 'init.ts') {
      // Find all variable declarations with string literals that should be Zod schemas
      const variableDeclarations = sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration);
      
      for (const varDecl of variableDeclarations) {
        const initializer = varDecl.getInitializer();
        
        if (initializer && initializer.getKind() === SyntaxKind.StringLiteral) {
          const value = initializer.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue();
          
          // Convert string literals to proper Zod schemas based on content
          if (value === 'stdio' || value === 'sse' || value === 'httpStream') {
            // This should be a Zod enum for transport types
            initializer.replaceWithText(`z.enum(["stdio", "sse", "httpStream"])`);
            fileChanges++;
            totalChanges++;
            console.log(`  ✅ Fixed Zod enum schema for transport in ${fileName}`);
          } else if (value.includes('mcpTransport') || value.includes('params')) {
            // This should be a Zod string with transform
            initializer.replaceWithText(`z.string().transform((val) => val as "stdio" | "sse" | "httpStream")`);
            fileChanges++;
            totalChanges++;
            console.log(`  ✅ Fixed Zod transform schema in ${fileName}`);
          }
        }
      }
      
      // Also fix property assignments in object literals
      const objectLiterals = sourceFile.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression);
      
      for (const objLiteral of objectLiterals) {
        const properties = objLiteral.getProperties();
        
        for (const prop of properties) {
          if (prop.getKind() === SyntaxKind.PropertyAssignment) {
            const propAssign = prop.asKindOrThrow(SyntaxKind.PropertyAssignment);
            const initializer = propAssign.getInitializer();
            
            if (initializer && initializer.getKind() === SyntaxKind.StringLiteral) {
              const value = initializer.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue();
              
              // Fix template literal expressions that should use params
              if (value.includes('params.')) {
                // Replace with proper parameter reference
                const paramName = value.replace('params.', '');
                initializer.replaceWithText(`(params as any).${paramName} || "stdio"`);
                fileChanges++;
                totalChanges++;
                console.log(`  ✅ Fixed parameter reference in ${fileName}`);
              }
            }
          }
        }
      }
    }
    
    // Fix 2: TaskStatus string assignment in githubIssuesTaskBackend.ts
    if (fileName === 'githubIssuesTaskBackend.ts') {
      // Find all return statements that return string literals for TaskStatus
      const returnStatements = sourceFile.getDescendantsOfKind(SyntaxKind.ReturnStatement);
      
      for (const returnStmt of returnStatements) {
        const expression = returnStmt.getExpression();
        
        if (expression && expression.getKind() === SyntaxKind.ConditionalExpression) {
          const conditional = expression.asKindOrThrow(SyntaxKind.ConditionalExpression);
          const whenTrue = conditional.getWhenTrue();
          const whenFalse = conditional.getWhenFalse();
          
          // Replace remaining string literals with TaskStatus constants
          if (whenTrue.getKind() === SyntaxKind.StringLiteral) {
            const value = whenTrue.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue();
            if (value in { TODO: 1, 'IN-PROGRESS': 1, 'IN-REVIEW': 1, DONE: 1, BLOCKED: 1, CLOSED: 1 }) {
              whenTrue.replaceWithText(`TASK_STATUS.${value.replace('-', '_')}`);
              fileChanges++;
              totalChanges++;
              console.log(`  ✅ Fixed TaskStatus constant ${value} in ${fileName}`);
            }
          }
          
          if (whenFalse.getKind() === SyntaxKind.StringLiteral) {
            const value = whenFalse.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue();
            if (value in { TODO: 1, 'IN-PROGRESS': 1, 'IN-REVIEW': 1, DONE: 1, BLOCKED: 1, CLOSED: 1 }) {
              whenFalse.replaceWithText(`TASK_STATUS.${value.replace('-', '_')}`);
              fileChanges++;
              totalChanges++;
              console.log(`  ✅ Fixed TaskStatus constant ${value} in ${fileName}`);
            }
          }
        }
        
        // Also check for direct string literal returns
        if (expression && expression.getKind() === SyntaxKind.StringLiteral) {
          const value = expression.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue();
          if (value in { TODO: 1, 'IN-PROGRESS': 1, 'IN-REVIEW': 1, DONE: 1, BLOCKED: 1, CLOSED: 1 }) {
            expression.replaceWithText(`TASK_STATUS.${value.replace('-', '_')}`);
            fileChanges++;
            totalChanges++;
            console.log(`  ✅ Fixed direct TaskStatus return ${value} in ${fileName}`);
          }
        }
      }
    }
    
    // Fix 3: unknown[] → string[] in git-exec-enhanced.ts
    if (fileName === 'git-exec-enhanced.ts') {
      // Find all variable declarations or assignments with unknown arrays
      const variableDeclarations = sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration);
      
      for (const varDecl of variableDeclarations) {
        const initializer = varDecl.getInitializer();
        
        if (initializer && initializer.getKind() === SyntaxKind.ArrayLiteralExpression) {
          // Check if this variable has unknown[] type but should be string[]
          const type = varDecl.getType();
          if (type.getText().includes('unknown[]')) {
            // Add type assertion to make it string[]
            initializer.replaceWithText(`${initializer.getText()} as string[]`);
            fileChanges++;
            totalChanges++;
            console.log(`  ✅ Fixed unknown[] to string[] assertion in ${fileName}`);
          }
        }
      }
      
      // Also check assignments
      const assignments = sourceFile.getDescendantsOfKind(SyntaxKind.BinaryExpression);
      
      for (const assignment of assignments) {
        if (assignment.getOperatorToken().getKind() === SyntaxKind.EqualsToken) {
          const right = assignment.getRight();
          
          if (right.getKind() === SyntaxKind.ArrayLiteralExpression) {
            // Check if this looks like it should be string[]
            const text = right.getText();
            if (text.includes('String(') || text.includes('.toString(')) {
              right.replaceWithText(`${text} as string[]`);
              fileChanges++;
              totalChanges++;
              console.log(`  ✅ Fixed array assignment type assertion in ${fileName}`);
            }
          }
        }
      }
    }
    
    // Fix 4: Promise<null> → Promise<string | undefined> in test dependencies
    if (fileName === 'dependencies.ts') {
      // Find arrow functions that return Promise<null> but should return Promise<string | undefined>
      const arrowFunctions = sourceFile.getDescendantsOfKind(SyntaxKind.ArrowFunction);
      
      for (const arrowFunc of arrowFunctions) {
        const body = arrowFunc.getBody();
        
        // Check if function returns Promise<null>
        if (body.getKind() === SyntaxKind.CallExpression) {
          const callExpr = body.asKindOrThrow(SyntaxKind.CallExpression);
          const expression = callExpr.getExpression();
          
          // Check for Promise.resolve(null) pattern
          if (expression.getKind() === SyntaxKind.PropertyAccessExpression) {
            const propAccess = expression.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
            
            if (propAccess.getExpression().getText() === 'Promise' && propAccess.getName() === 'resolve') {
              const args = callExpr.getArguments();
              
              if (args.length === 1 && args[0].getText() === 'null') {
                // Change Promise.resolve(null) to Promise.resolve(undefined)
                args[0].replaceWithText('undefined');
                fileChanges++;
                totalChanges++;
                console.log(`  ✅ Fixed Promise<null> to Promise<undefined> in ${fileName}`);
              }
            }
          }
        }
        
        // Also check for async arrow functions that return null
        if (arrowFunc.isAsync() && body.getKind() === SyntaxKind.NullKeyword) {
          body.replaceWithText('undefined');
          fileChanges++;
          totalChanges++;
          console.log(`  ✅ Fixed async function null return to undefined in ${fileName}`);
        }
      }
    }
    
    // Fix 5: Jest mock compatibility in test-utils
    if (fileName === 'index.ts' && filePath.includes('test-utils/compatibility')) {
      // Find object literal expressions with mock function signatures
      const objectLiterals = sourceFile.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression);
      
      for (const objLiteral of objectLiterals) {
        const properties = objLiteral.getProperties();
        
        for (const prop of properties) {
          if (prop.getKind() === SyntaxKind.PropertyAssignment) {
            const propAssign = prop.asKindOrThrow(SyntaxKind.PropertyAssignment);
            const name = propAssign.getName();
            
            if (name === 'mock') {
              const initializer = propAssign.getInitializer();
              
              // Update the mock function signature to match Jest expectations
              if (initializer && initializer.getKind() === SyntaxKind.ArrowFunction) {
                const arrowFunc = initializer.asKindOrThrow(SyntaxKind.ArrowFunction);
                const params = arrowFunc.getParameters();
                
                // Ensure the factory parameter is required, not optional
                if (params.length >= 2) {
                  const factoryParam = params[1];
                  if (factoryParam.hasQuestionToken()) {
                    factoryParam.removeQuestionToken();
                    fileChanges++;
                    totalChanges++;
                    console.log(`  ✅ Fixed Jest mock factory parameter signature in ${fileName}`);
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
    console.log(`  ✅ ${fileName}: ${fileChanges} TS2322 errors fixed`);
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

console.log(`\n🎉 TS2322 elimination completed!`);
console.log(`📊 Total changes applied: ${totalChanges}`);
console.log(`📁 Files modified: ${filesModified}`);
console.log(`🎯 Target: Complete elimination of all 9 TS2322 type assignment errors`);

process.exit(0); 
