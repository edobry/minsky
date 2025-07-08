#!/usr/bin/env bun

import { Project } from "ts-morph";
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

console.log("🎯 Starting syntax error fixer...");
console.log(`📊 Target: TS1109 and TS1005 syntax errors`);
console.log(`📁 Processing ${sourceFiles.length} source files...`);

// Process each source file
project.getSourceFiles().forEach(sourceFile => {
  const filePath = sourceFile.getFilePath();
  const fileName = filePath.split('/').pop();
  let fileChanges = 0;
  
  // Get the full text of the file
  const fullText = sourceFile.getFullText();
  
  // Pattern 1: Fix }! that should be }
  const fixedText1 = fullText.replace(/(\s*})\s*!\s*(;?\s*[\)\]])/g, '$1$2');
  
  // Pattern 2: Fix }! that should be }
  const fixedText2 = fixedText1.replace(/(\s*})\s*!\s*;?\s*$/gm, '$1');
  
  // Pattern 3: Fix )! that should be )
  const fixedText3 = fixedText2.replace(/(\s*\))\s*!\s*(;?\s*[\)\]])/g, '$1$2');
  
  // Pattern 4: Fix ]! that should be ]
  const fixedText4 = fixedText3.replace(/(\s*\])\s*!\s*(;?\s*[\)\]])/g, '$1$2');
  
  // Pattern 5: Fix standalone !; or !);
  const fixedText5 = fixedText4.replace(/\s*!\s*;?\s*\)/g, ')');
  
  // Pattern 6: Fix !; at end of lines
  const fixedText6 = fixedText5.replace(/\s*!\s*;?\s*$/gm, '');
  
  // Count changes
  if (fixedText6 !== fullText) {
    sourceFile.replaceWithText(fixedText6);
    
    const changes = (fullText.match(/!\s*[\)\];]/g) || []).length;
    fileChanges += changes;
    totalChanges += changes;
    
    if (fileChanges > 0) {
      filesModified++;
      console.log(`  ✅ ${fileName}: ${fileChanges} syntax fixes applied`);
    }
  }
});

// Save all changes
console.log(`\n💾 Saving all changes...`);
project.saveSync();

console.log(`\n🎉 Syntax error fixer completed!`);
console.log(`📊 Total changes applied: ${totalChanges}`);
console.log(`📁 Files modified: ${filesModified}`);
console.log(`🎯 Target: TS1109 and TS1005 syntax errors`); 
