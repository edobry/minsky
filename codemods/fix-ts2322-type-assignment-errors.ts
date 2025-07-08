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

console.log("🎯 Starting precise fix for TS2322 type assignment errors...");
console.log(`📊 Target: Fix specific type assignment mismatches`);
console.log(`📁 Processing ${sourceFiles.length} source files...`);

// Process each source file
project.getSourceFiles().forEach(sourceFile => {
  const filePath = sourceFile.getFilePath();
  const fileName = filePath.split('/').pop() || 'unknown';
  let fileChanges = 0;
  
  try {
    // Fix 1: githubIssuesTaskBackend.ts - Replace string literals with TaskStatus constants
    if (fileName === 'githubIssuesTaskBackend.ts') {
      // Add import for TASK_STATUS if not already present
      const imports = sourceFile.getImportDeclarations();
      const hasTaskStatusImport = imports.some(imp => 
        imp.getModuleSpecifierValue().includes('taskConstants') && 
        imp.getNamedImports().some(ni => ni.getName() === 'TASK_STATUS')
      );
      
      if (!hasTaskStatusImport) {
        // Add the import
        sourceFile.addImportDeclaration({
          namedImports: ['TASK_STATUS'],
          moduleSpecifier: './taskConstants.js'
        });
        fileChanges++;
        totalChanges++;
        console.log(`  ✅ Added TASK_STATUS import to ${fileName}`);
      }
      
      // Find the getTaskStatusFromIssue method
      const methods = sourceFile.getDescendantsOfKind(SyntaxKind.MethodDeclaration);
      
      for (const method of methods) {
        if (method.getName() === 'getTaskStatusFromIssue') {
          // Find return statements with string literals
          const returnStatements = method.getDescendantsOfKind(SyntaxKind.ReturnStatement);
          
          for (const returnStmt of returnStatements) {
            const expression = returnStmt.getExpression();
            if (expression && expression.getKind() === SyntaxKind.ConditionalExpression) {
              const conditional = expression.asKindOrThrow(SyntaxKind.ConditionalExpression);
              const whenTrue = conditional.getWhenTrue();
              const whenFalse = conditional.getWhenFalse();
              
              // Replace "DONE" with TASK_STATUS.DONE
              if (whenTrue.getKind() === SyntaxKind.StringLiteral && whenTrue.getText() === '"DONE"') {
                whenTrue.replaceWithText('TASK_STATUS.DONE');
                fileChanges++;
                totalChanges++;
                console.log(`  ✅ Fixed "DONE" string literal in ${fileName}`);
              }
              
              // Replace "TODO" with TASK_STATUS.TODO
              if (whenFalse.getKind() === SyntaxKind.StringLiteral && whenFalse.getText() === '"TODO"') {
                whenFalse.replaceWithText('TASK_STATUS.TODO');
                fileChanges++;
                totalChanges++;
                console.log(`  ✅ Fixed "TODO" string literal in ${fileName}`);
              }
            }
          }
        }
      }
    }
    
    // Fix 2: taskFunctions.ts - Fix return type of parseMarkdownToTaskState
    if (fileName === 'taskFunctions.ts') {
      const functions = sourceFile.getDescendantsOfKind(SyntaxKind.FunctionDeclaration);
      
      for (const func of functions) {
        if (func.getName() === 'parseMarkdownToTaskState') {
          const returnType = func.getReturnTypeNode();
          if (returnType && returnType.getText() === 'TaskStatus') {
            // Change return type from TaskStatus to TaskData[]
            returnType.replaceWithText('TaskData[]');
            fileChanges++;
            totalChanges++;
            console.log(`  ✅ Fixed return type of parseMarkdownToTaskState in ${fileName}`);
          }
        }
      }
    }
    
  } catch (error) {
    console.log(`  ⚠️  Error processing ${fileName}: ${error}`);
  }
  
  if (fileChanges > 0) {
    filesModified++;
    console.log(`  ✅ ${fileName}: ${fileChanges} type assignment errors fixed`);
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

console.log(`\n🎉 Type assignment error fixes completed!`);
console.log(`📊 Total changes applied: ${totalChanges}`);
console.log(`📁 Files modified: ${filesModified}`);
console.log(`🎯 Target: Fix specific TS2322 type assignment mismatches`);

process.exit(0); 
