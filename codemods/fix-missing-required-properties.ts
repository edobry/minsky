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
      !file.includes('__tests__') && !file.includes('/tests/')
);

sourceFiles.forEach(file => project.addSourceFileAtPath(file));

let totalChanges = 0;
let filesModified = 0;

console.log("🎯 Starting precise fix for missing required properties...");
console.log(`📊 Target: Fix 12 TS2741 errors introduced by previous cleanup`);
console.log(`📁 Processing ${sourceFiles.length} source files...`);

// Process each source file
project.getSourceFiles().forEach(sourceFile => {
  const filePath = sourceFile.getFilePath();
  const fileName = filePath.split('/').pop() || 'unknown';
  let fileChanges = 0;
  
  try {
    // Fix 1: init.ts - Add missing transport property
    if (fileName === 'init.ts') {
      const objectLiterals = sourceFile.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression);
      
      for (const objLiteral of objectLiterals) {
        const properties = objLiteral.getProperties();
        
        // Look for the mcp object that has enabled but missing transport
        const hasEnabled = properties.some(prop => 
          prop.getKind() === SyntaxKind.PropertyAssignment &&
          prop.asKindOrThrow(SyntaxKind.PropertyAssignment).getName() === 'enabled'
        );
        
        const hasTransport = properties.some(prop => 
          prop.getKind() === SyntaxKind.PropertyAssignment &&
          prop.asKindOrThrow(SyntaxKind.PropertyAssignment).getName() === 'transport'
        );
        
        if (hasEnabled && !hasTransport) {
          // Add transport property after enabled
          const enabledProp = properties.find(prop => 
            prop.getKind() === SyntaxKind.PropertyAssignment &&
            prop.asKindOrThrow(SyntaxKind.PropertyAssignment).getName() === 'enabled'
          );
          
          if (enabledProp) {
            // Insert transport property right after enabled
            const enabledIndex = properties.indexOf(enabledProp);
            objLiteral.insertPropertyAssignment(enabledIndex + 1, {
              name: 'transport',
              initializer: '(params.mcpTransport as "stdio" | "sse" | "httpStream") || "stdio"'
            });
            fileChanges++;
            totalChanges++;
            console.log(`  ✅ Added missing transport property in ${fileName}`);
          }
        }
      }
    }
    
    // Fix 2: conflict-detection.ts - Add missing workdir properties to EnhancedMergeResult and SmartUpdateResult
    if (fileName === 'conflict-detection.ts') {
      const returnStatements = sourceFile.getDescendantsOfKind(SyntaxKind.ReturnStatement);
      
      for (const returnStmt of returnStatements) {
        const expression = returnStmt.getExpression();
        
        if (expression && expression.getKind() === SyntaxKind.ObjectLiteralExpression) {
          const objLiteral = expression.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
          const properties = objLiteral.getProperties();
          
          // Check if this object has merged/conflicts (EnhancedMergeResult) or updated/skipped (SmartUpdateResult)
          const hasEnhancedMergeProps = properties.some(prop => 
            prop.getKind() === SyntaxKind.PropertyAssignment &&
            ['merged', 'conflicts'].includes(prop.asKindOrThrow(SyntaxKind.PropertyAssignment).getName())
          );
          
          const hasSmartUpdateProps = properties.some(prop => 
            prop.getKind() === SyntaxKind.PropertyAssignment &&
            ['updated', 'skipped'].includes(prop.asKindOrThrow(SyntaxKind.PropertyAssignment).getName())
          );
          
          const hasWorkdir = properties.some(prop => 
            prop.getKind() === SyntaxKind.PropertyAssignment &&
            prop.asKindOrThrow(SyntaxKind.PropertyAssignment).getName() === 'workdir'
          );
          
          if ((hasEnhancedMergeProps || hasSmartUpdateProps) && !hasWorkdir) {
            // Add workdir property at the beginning
            objLiteral.insertPropertyAssignment(0, {
              name: 'workdir',
              initializer: 'repoPath'
            });
            
            fileChanges++;
            totalChanges++;
            console.log(`  ✅ Added missing workdir property to result object in ${fileName}`);
          }
        }
      }
    }
    
    // Fix 3: localGitBackend.ts and remoteGitBackend.ts - Add missing workdir to BranchResult
    if (fileName === 'localGitBackend.ts' || fileName === 'remoteGitBackend.ts') {
      const returnStatements = sourceFile.getDescendantsOfKind(SyntaxKind.ReturnStatement);
      
      for (const returnStmt of returnStatements) {
        const expression = returnStmt.getExpression();
        
        if (expression && expression.getKind() === SyntaxKind.ObjectLiteralExpression) {
          const objLiteral = expression.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
          const properties = objLiteral.getProperties();
          
          // Check if this has branch property but missing workdir (BranchResult)
          const hasBranch = properties.some(prop => 
            prop.getKind() === SyntaxKind.PropertyAssignment &&
            prop.asKindOrThrow(SyntaxKind.PropertyAssignment).getName() === 'branch'
          );
          
          const hasWorkdir = properties.some(prop => 
            prop.getKind() === SyntaxKind.PropertyAssignment &&
            prop.asKindOrThrow(SyntaxKind.PropertyAssignment).getName() === 'workdir'
          );
          
          if (hasBranch && !hasWorkdir) {
            // Add workdir property before branch
            objLiteral.insertPropertyAssignment(0, {
              name: 'workdir',
              initializer: 'this.localPath!'
            });
            
            fileChanges++;
            totalChanges++;
            console.log(`  ✅ Added missing workdir property to BranchResult in ${fileName}`);
          }
        }
      }
    }
    
  } catch (error) {
    console.log(`  ⚠️  Error processing ${fileName}: ${error}`);
  }
  
  if (fileChanges > 0) {
    filesModified++;
    console.log(`  ✅ ${fileName}: ${fileChanges} required properties restored`);
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

console.log(`\n🎉 Precise property restoration completed!`);
console.log(`📊 Total changes applied: ${totalChanges}`);
console.log(`📁 Files modified: ${filesModified}`);
console.log(`🎯 Target: Restore required properties without breaking existing functionality`);

process.exit(0); 
