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

console.log("🎯 Targeting specific TS2322 errors for complete elimination...");

// Fix each specific error location
project.getSourceFiles().forEach(sourceFile => {
  const filePath = sourceFile.getFilePath();
  const fileName = filePath.split('/').pop() || 'unknown';
  let fileChanges = 0;

  // Fix 1: ZodTypeAny issues in init files
  if (fileName === 'init.ts') {
    // Fix issue with parameter access in MCP adapter
    if (filePath.includes('adapters/mcp')) {
      // Look for params.repoPath where it should be params._repoPath
      const propertyAccess = sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression);
      
      for (const prop of propertyAccess) {
        if (prop.getExpression().getText() === 'params' && prop.getName() === 'repoPath') {
          // Change to _repoPath to match schema
          prop.replaceWithText('params._repoPath');
          fileChanges++;
          totalChanges++;
          console.log(`  ✅ Fixed params.repoPath → params._repoPath in MCP ${fileName}`);
        }
      }
    }
  }

  // Fix 2: TaskStatus string assignment in githubIssuesTaskBackend.ts
  if (fileName === 'githubIssuesTaskBackend.ts') {
    // Find the getTaskStatusFromIssue method and fix return type
    const methodDeclarations = sourceFile.getDescendantsOfKind(SyntaxKind.MethodDeclaration);
    
    for (const method of methodDeclarations) {
      if (method.getName() === 'getTaskStatusFromIssue') {
        // Change return type from string to TaskStatus
        const returnTypeNode = method.getReturnTypeNode();
        if (returnTypeNode && returnTypeNode.getText() === 'string') {
          returnTypeNode.replaceWithText('TaskStatus');
          fileChanges++;
          totalChanges++;
          console.log(`  ✅ Fixed return type string → TaskStatus in ${fileName}`);
        }
        
        // Also fix the return statements to use TaskStatus constants
        const returnStatements = method.getDescendantsOfKind(SyntaxKind.ReturnStatement);
        
        for (const returnStmt of returnStatements) {
          const expression = returnStmt.getExpression();
          
          if (expression && expression.getKind() === SyntaxKind.StringLiteral) {
            const value = expression.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue();
            
            if (value === 'DONE' || value === 'TODO' || value === 'IN-PROGRESS' || value === 'BLOCKED') {
              expression.replaceWithText(`TASK_STATUS.${value.replace('-', '_')}`);
              fileChanges++;
              totalChanges++;
              console.log(`  ✅ Fixed TaskStatus string literal "${value}" → TASK_STATUS.${value.replace('-', '_')} in ${fileName}`);
            }
          }
        }
      }
    }
    
    // Add TaskStatus import if not present
    const imports = sourceFile.getImportDeclarations();
    const hasTaskStatusImport = imports.some(imp => 
      imp.getImportClause()?.getNamedBindings()?.getText().includes('TaskStatus') ||
      imp.getImportClause()?.getNamedBindings()?.getText().includes('TASK_STATUS')
    );
    
    if (!hasTaskStatusImport) {
      // Add the import after existing imports
      const lastImport = imports[imports.length - 1];
      if (lastImport) {
        sourceFile.insertImportDeclaration(lastImport.getChildIndex() + 1, {
          moduleSpecifier: "../index.js",
          namedImports: ["TaskStatus", "TASK_STATUS"]
        });
        fileChanges++;
        totalChanges++;
        console.log(`  ✅ Added TaskStatus import to ${fileName}`);
      }
    }
  }

  // Fix 3: unknown[] → string[] in git-exec-enhanced.ts
  if (fileName === 'git-exec-enhanced.ts') {
    // Find the extractConflictFiles function and fix the type issue
    const functionDeclarations = sourceFile.getDescendantsOfKind(SyntaxKind.FunctionDeclaration);
    
    for (const func of functionDeclarations) {
      if (func.getName() === 'extractConflictFiles') {
        // Find the files variable declaration
        const variableDeclarations = func.getDescendantsOfKind(SyntaxKind.VariableDeclaration);
        
        for (const varDecl of variableDeclarations) {
          if (varDecl.getName() === 'files') {
            const initializer = varDecl.getInitializer();
            
            if (initializer) {
              const text = initializer.getText();
              
              // Fix the type assertion to be more explicit
              if (text.includes('filter(Boolean) as string[]')) {
                // It's already fixed, but let's make sure it's properly typed
                continue;
              } else if (text.includes('filter(Boolean)')) {
                // Add proper type assertion
                initializer.replaceWithText(text.replace('filter(Boolean)', 'filter(Boolean as (value: string | null) => value is string)'));
                fileChanges++;
                totalChanges++;
                console.log(`  ✅ Fixed filter(Boolean) type assertion in ${fileName}`);
              }
            }
          }
        }
        
        // Also fix the return statement
        const returnStatements = func.getDescendantsOfKind(SyntaxKind.ReturnStatement);
        
        for (const returnStmt of returnStatements) {
          const expression = returnStmt.getExpression();
          
          if (expression && expression.getText().includes('files as any')) {
            // Replace with proper type assertion
            expression.replaceWithText('[...new Set(files)]');
            fileChanges++;
            totalChanges++;
            console.log(`  ✅ Fixed return type assertion in ${fileName}`);
          }
        }
      }
    }
  }

  // Fix 4: Jest mock compatibility in test-utils
  if (fileName === 'index.ts' && filePath.includes('test-utils/compatibility')) {
    // Find the mock function and fix the signature
    const propertyAssignments = sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAssignment);
    
    for (const prop of propertyAssignments) {
      if (prop.getName() === 'mock') {
        const initializer = prop.getInitializer();
        
        if (initializer && initializer.getKind() === SyntaxKind.ArrowFunction) {
          const arrowFunc = initializer.asKindOrThrow(SyntaxKind.ArrowFunction);
          const params = arrowFunc.getParameters();
          
                     // Make the factory parameter required (remove question mark)
           if (params.length >= 2) {
             const factoryParam = params[1];
             if (factoryParam.hasQuestionToken()) {
               factoryParam.setHasQuestionToken(false);
               fileChanges++;
               totalChanges++;
               console.log(`  ✅ Fixed Jest mock factory parameter signature in ${fileName}`);
             }
           }
        }
      }
    }
  }

  // Fix 5: Promise<null> → Promise<string | undefined> in test dependencies
  if (fileName === 'dependencies.ts' && filePath.includes('test-utils')) {
    // Find arrow functions returning Promise.resolve(null)
    const arrowFunctions = sourceFile.getDescendantsOfKind(SyntaxKind.ArrowFunction);
    
    for (const arrowFunc of arrowFunctions) {
      const body = arrowFunc.getBody();
      
      if (body.getKind() === SyntaxKind.CallExpression) {
        const callExpr = body.asKindOrThrow(SyntaxKind.CallExpression);
        const expression = callExpr.getExpression();
        
        if (expression.getKind() === SyntaxKind.PropertyAccessExpression) {
          const propAccess = expression.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
          
          if (propAccess.getExpression().getText() === 'Promise' && propAccess.getName() === 'resolve') {
            const args = callExpr.getArguments();
            
            if (args.length === 1 && args[0].getText() === 'null') {
              // Change null to undefined
              args[0].replaceWithText('undefined');
              fileChanges++;
              totalChanges++;
              console.log(`  ✅ Fixed Promise.resolve(null) → Promise.resolve(undefined) in ${fileName}`);
            }
          }
        }
      }
    }
  }

  if (fileChanges > 0) {
    console.log(`  📝 ${fileName}: ${fileChanges} TS2322 errors fixed`);
  }
});

// Save all changes
console.log(`\n💾 Saving changes...`);
project.saveSync();

console.log(`\n🎉 TS2322 targeted fixes completed!`);
console.log(`📊 Total changes: ${totalChanges}`);
console.log(`🎯 All 9 TS2322 errors should now be eliminated`);

process.exit(0); 
