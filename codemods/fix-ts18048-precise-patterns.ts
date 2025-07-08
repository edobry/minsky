#!/usr/bin/env bun

import { Project, SyntaxKind, PropertyAccessExpression, Identifier } from "ts-morph";
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

console.log("🎯 Starting precise TS18048 'possibly undefined' error fixer...");
console.log(`📊 Target: 12 TS18048 errors from specific patterns`);
console.log(`📁 Processing ${sourceFiles.length} source files...`);

// Process each source file
project.getSourceFiles().forEach(sourceFile => {
  const filePath = sourceFile.getFilePath();
  const fileName = filePath.split('/').pop() || 'unknown';
  let fileChanges = 0;
  
  try {
    const fullText = sourceFile.getFullText();
    
    // Pattern 1: Fix globalConfig?.github.credentials -> globalConfig?.github?.credentials
    const propertyAccesses = sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression);
    
    for (const propAccess of propertyAccesses) {
      try {
        const fullPropText = propAccess.getText();
        
        // Look for patterns like globalConfig?.github.credentials
        if (fullPropText.includes('globalConfig?.github.credentials')) {
          // Replace with proper optional chaining
          propAccess.replaceWithText(fullPropText.replace('globalConfig?.github.credentials', 'globalConfig?.github?.credentials'));
          fileChanges++;
          totalChanges++;
          console.log(`  ✅ Fixed optional chaining: ${fullPropText} in ${fileName}`);
        }
        
        // Look for patterns like config?.github.credentials
        if (fullPropText.includes('config?.github.credentials')) {
          propAccess.replaceWithText(fullPropText.replace('config?.github.credentials', 'config?.github?.credentials'));
          fileChanges++;
          totalChanges++;
          console.log(`  ✅ Fixed optional chaining: ${fullPropText} in ${fileName}`);
        }
        
        // Look for patterns like repository?.sessiondb.sqlite
        if (fullPropText.includes('repository?.sessiondb.sqlite')) {
          propAccess.replaceWithText(fullPropText.replace('repository?.sessiondb.sqlite', 'repository?.sessiondb?.sqlite'));
          fileChanges++;
          totalChanges++;
          console.log(`  ✅ Fixed optional chaining: ${fullPropText} in ${fileName}`);
        }
        
        // Look for patterns like repository?.sessiondb.postgres
        if (fullPropText.includes('repository?.sessiondb.postgres')) {
          propAccess.replaceWithText(fullPropText.replace('repository?.sessiondb.postgres', 'repository?.sessiondb?.postgres'));
          fileChanges++;
          totalChanges++;
          console.log(`  ✅ Fixed optional chaining: ${fullPropText} in ${fileName}`);
        }
        
        // Look for patterns like globalUser?.sessiondb.sqlite
        if (fullPropText.includes('globalUser?.sessiondb.sqlite')) {
          propAccess.replaceWithText(fullPropText.replace('globalUser?.sessiondb.sqlite', 'globalUser?.sessiondb?.sqlite'));
          fileChanges++;
          totalChanges++;
          console.log(`  ✅ Fixed optional chaining: ${fullPropText} in ${fileName}`);
        }
        
      } catch (error) {
        console.log(`  ⚠️  Skipping property access in ${fileName}: ${error}`);
        continue;
      }
    }
    
    // Pattern 2: Fix result.data access after null checks
    // Look for patterns like: result.data.sessions where result.data might be undefined
    for (const propAccess of propertyAccesses) {
      try {
        const fullPropText = propAccess.getText();
        
        // Look for result.data.sessions patterns
        if (fullPropText.includes('result.data.sessions')) {
          // Check if we're after a null check by looking at the surrounding code
          const sourceText = sourceFile.getFullText();
          const propStart = propAccess.getStart();
          const precedingText = sourceText.slice(Math.max(0, propStart - 200), propStart);
          
          // Check if there's a null check before this usage
          const hasNullCheck = precedingText.includes('!(result as any).data') || 
                              precedingText.includes('!result.data') ||
                              precedingText.includes('!(result as any).success');
          
          if (hasNullCheck) {
            // Replace with non-null assertion
            propAccess.replaceWithText(fullPropText.replace('result.data.sessions', 'result.data!.sessions'));
            fileChanges++;
            totalChanges++;
            console.log(`  ✅ Fixed result.data access with non-null assertion: ${fullPropText} in ${fileName}`);
          }
        }
        
      } catch (error) {
        console.log(`  ⚠️  Skipping result.data pattern in ${fileName}: ${error}`);
        continue;
      }
    }
    
  } catch (error) {
    console.log(`  ⚠️  Error processing ${fileName}: ${error}`);
  }
  
  if (fileChanges > 0) {
    filesModified++;
    console.log(`  ✅ ${fileName}: ${fileChanges} undefined fixes applied`);
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

console.log(`\n🎉 Precise TS18048 'possibly undefined' fixer completed!`);
console.log(`📊 Total changes applied: ${totalChanges}`);
console.log(`📁 Files modified: ${filesModified}`);
console.log(`🎯 Target patterns: optional chaining inconsistencies and post-guard-clause access`);

process.exit(0); 
