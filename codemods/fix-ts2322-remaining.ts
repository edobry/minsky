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

console.log("🎯 Fixing remaining TS2322 errors...");

// Fix each specific remaining error
project.getSourceFiles().forEach(sourceFile => {
  const filePath = sourceFile.getFilePath();
  const fileName = filePath.split('/').pop() || 'unknown';
  let fileChanges = 0;

  // Fix 1: Zod schema property assignments in init files
  if (fileName === 'init.ts' && filePath.includes('adapters/mcp')) {
    // Fix the transport property assignment that's a string instead of Zod schema
    const objectLiterals = sourceFile.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression);
    
    for (const objLiteral of objectLiterals) {
      const properties = objLiteral.getProperties();
      
      for (const prop of properties) {
        if (prop.getKind() === SyntaxKind.PropertyAssignment) {
          const propAssign = prop.asKindOrThrow(SyntaxKind.PropertyAssignment);
          
          if (propAssign.getName() === 'transport') {
            const initializer = propAssign.getInitializer();
            if (initializer) {
              const text = initializer.getText();
              
              // Check if this is the problematic line with string assignment
              if (text.includes('params.mcpTransport') || text.includes('|| "stdio"')) {
                // Replace with proper Zod enum
                initializer.replaceWithText('z.enum(["stdio", "sse", "httpStream"]).optional().default("stdio")');
                fileChanges++;
                totalChanges++;
                console.log(`  ✅ Fixed transport property ZodTypeAny issue in MCP ${fileName}`);
              }
            }
          }
        }
      }
    }
  }

  // Fix 2: Domain init.ts Zod schema issues
  if (fileName === 'init.ts' && filePath.includes('domain')) {
    // Similar fix for domain init.ts
    const objectLiterals = sourceFile.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression);
    
    for (const objLiteral of objectLiterals) {
      const properties = objLiteral.getProperties();
      
      for (const prop of properties) {
        if (prop.getKind() === SyntaxKind.PropertyAssignment) {
          const propAssign = prop.asKindOrThrow(SyntaxKind.PropertyAssignment);
          
          if (propAssign.getName() === 'transport') {
            const initializer = propAssign.getInitializer();
            if (initializer) {
              const text = initializer.getText();
              
              if (text.includes('params.mcpTransport') || text.includes('|| "stdio"')) {
                initializer.replaceWithText('z.enum(["stdio", "sse", "httpStream"]).optional().default("stdio")');
                fileChanges++;
                totalChanges++;
                console.log(`  ✅ Fixed transport property ZodTypeAny issue in domain ${fileName}`);
              }
            }
          }
        }
      }
    }
  }

  // Fix 3: Jest mock compatibility - fix the options parameter type
  if (fileName === 'index.ts' && filePath.includes('test-utils/compatibility')) {
    const propertyAssignments = sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAssignment);
    
    for (const prop of propertyAssignments) {
      if (prop.getName() === 'mock') {
        const initializer = prop.getInitializer();
        
        if (initializer && initializer.getKind() === SyntaxKind.ArrowFunction) {
          const arrowFunc = initializer.asKindOrThrow(SyntaxKind.ArrowFunction);
          const params = arrowFunc.getParameters();
          
          // Fix the options parameter type
          if (params.length >= 3) {
            const optionsParam = params[2];
            const typeNode = optionsParam.getTypeNode();
            
            if (typeNode && typeNode.getText() === 'MockModuleOptions') {
              // Change to unknown to match Jest's type
              typeNode.replaceWithText('unknown');
              fileChanges++;
              totalChanges++;
              console.log(`  ✅ Fixed Jest mock options parameter type in ${fileName}`);
            }
          }
        }
      }
    }
  }

  // Fix 4: Promise return type issues in dependencies.ts
  if (fileName === 'dependencies.ts' && filePath.includes('test-utils')) {
    // Fix remaining Promise return type issues
    const propertyAssignments = sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAssignment);
    
    for (const prop of propertyAssignments) {
      const initializer = prop.getInitializer();
      
      if (initializer && initializer.getKind() === SyntaxKind.ArrowFunction) {
        const arrowFunc = initializer.asKindOrThrow(SyntaxKind.ArrowFunction);
        const body = arrowFunc.getBody();
        
        // Check for Promise.resolve(undefined) that should return specific types
        if (body.getKind() === SyntaxKind.CallExpression) {
          const callExpr = body.asKindOrThrow(SyntaxKind.CallExpression);
          const expression = callExpr.getExpression();
          
          if (expression.getKind() === SyntaxKind.PropertyAccessExpression) {
            const propAccess = expression.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
            
            if (propAccess.getExpression().getText() === 'Promise' && propAccess.getName() === 'resolve') {
              const args = callExpr.getArguments();
              
              if (args.length === 1 && args[0].getText() === 'undefined') {
                // Check what type this should return based on property name
                const propName = prop.getName();
                
                if (propName && (propName.includes('Session') || propName.includes('session'))) {
                  // Should return SessionRecord | null
                  args[0].replaceWithText('null');
                  fileChanges++;
                  totalChanges++;
                  console.log(`  ✅ Fixed Promise.resolve(undefined) → Promise.resolve(null) for session in ${fileName}`);
                } else if (propName && (propName.includes('Task') || propName.includes('task'))) {
                  // Should return Task | null
                  args[0].replaceWithText('null');
                  fileChanges++;
                  totalChanges++;
                  console.log(`  ✅ Fixed Promise.resolve(undefined) → Promise.resolve(null) for task in ${fileName}`);
                }
              }
            }
          }
        }
      }
    }
  }

  if (fileChanges > 0) {
    console.log(`  📝 ${fileName}: ${fileChanges} remaining TS2322 errors fixed`);
  }
});

// Save all changes
console.log(`\n💾 Saving changes...`);
project.saveSync();

console.log(`\n🎉 Remaining TS2322 fixes completed!`);
console.log(`📊 Total changes: ${totalChanges}`);
console.log(`🎯 All remaining TS2322 errors should now be eliminated`);

process.exit(0); 
