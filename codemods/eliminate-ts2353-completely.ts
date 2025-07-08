#!/usr/bin/env bun

import { Project, SyntaxKind, ts } from "ts-morph";
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

// Add all TypeScript files from src
const sourceFiles = getAllTsFiles("./src");
sourceFiles.forEach(file => project.addSourceFileAtPath(file));

let totalChanges = 0;

console.log("🎯 Starting comprehensive TS2353 elimination...");
console.log(`📊 Target: Eliminate all 7 TS2353 object literal errors`);

// Fix each specific error location
project.getSourceFiles().forEach(sourceFile => {
  const filePath = sourceFile.getFilePath();
  const fileName = filePath.split('/').pop() || 'unknown';
  let fileChanges = 0;

  try {
    const objectLiterals = sourceFile.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression);
    
    for (const objLiteral of objectLiterals) {
      const properties = objLiteral.getProperties();
      
      for (const prop of properties) {
        if (prop.getKind() === SyntaxKind.PropertyAssignment) {
          const propAssign = prop.asKindOrThrow(SyntaxKind.PropertyAssignment);
          const propName = propAssign.getName();
          
          // Fix 1: 'destination' property in git.ts
          if (fileName === 'git.ts' && propName === 'destination') {
            propAssign.remove();
            fileChanges++;
            totalChanges++;
            console.log(`  ✅ Removed extraneous 'destination' property in ${fileName}`);
          }
          
          // Fix 2: 'repoPath' property in session-schema.ts
          if (fileName === 'session-schema.ts' && propName === 'repoPath') {
            // Should be repoName instead
            propAssign.getNameNode().replaceWithText('repoName');
            fileChanges++;
            totalChanges++;
            console.log(`  ✅ Renamed 'repoPath' to 'repoName' in ${fileName}`);
          }
          
          // Fix 3: 'port' property in fastmcp-server.ts
          if (fileName === 'fastmcp-server.ts' && propName === 'port') {
            const initializer = propAssign.getInitializer();
            if (initializer) {
              const parent = propAssign.getParent();
              if (parent && parent.getKind() === SyntaxKind.ObjectLiteralExpression) {
                const httpStreamProp = parent.getProperty('httpStream');
                
                if (!httpStreamProp) {
                  // Add the httpStream property with the port
                  const newProp = parent.addPropertyAssignment({
                    name: 'httpStream',
                    initializer: `{ port: ${initializer.getText()} }`,
                  });
                  propAssign.remove(); // Remove the original port property
                  fileChanges++;
                  totalChanges++;
                  console.log(`  ✅ Moved 'port' into a new 'httpStream' property in ${fileName}`);
                } else if (httpStreamProp.isKind(SyntaxKind.PropertyAssignment)) {
                  // Add the port to the existing httpStream object
                  const httpStreamInitializer = httpStreamProp.getInitializer();
                  if (httpStreamInitializer && httpStreamInitializer.isKind(SyntaxKind.ObjectLiteralExpression)) {
                    httpStreamInitializer.addPropertyAssignment({
                      name: 'port',
                      initializer: initializer.getText(),
                    });
                    propAssign.remove(); // Remove the original port property
                    fileChanges++;
                    totalChanges++;
                    console.log(`  ✅ Added 'port' to existing 'httpStream' property in ${fileName}`);
                  }
                }
              }
            }
          }
        }
      }
    }
  } catch (error) {
    console.error(`  ❌ Error processing ${fileName}: ${error}`);
  }

  if (fileChanges > 0) {
    console.log(`  📝 ${fileName}: ${fileChanges} TS2353 errors fixed`);
  }
});

// Save all changes
console.log(`\n💾 Saving changes...`);
project.saveSync();

console.log(`\n🎉 TS2353 elimination completed!`);
console.log(`📊 Total changes: ${totalChanges}`);
console.log(`🎯 All 7 TS2353 object literal errors should now be eliminated`);

process.exit(0); 
