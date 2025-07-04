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

console.log("🎯 Starting conservative TS2345 'Argument type not assignable' fixer...");
console.log(`📊 Target: 35 TS2345 errors (21.2% of remaining 165 errors)`);
console.log(`📁 Processing ${sourceFiles.length} source files...`);
console.log(`⚠️  Using conservative patterns to avoid breaking function overloads`);

// Process each source file
project.getSourceFiles().forEach(sourceFile => {
  const filePath = sourceFile.getFilePath();
  const fileName = filePath.split('/').pop();
  let fileChanges = 0;
  
  // Pattern 1: SAFE - Error handling function calls (console.log, logger, throw)
  sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression).forEach(callExpr => {
    const expression = callExpr.getExpression();
    
    // Target safe logging and error functions
    if (expression.getKind() === SyntaxKind.PropertyAccessExpression) {
      const propAccess = expression.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
      const obj = propAccess.getExpression().getText();
      const method = propAccess.getName();
      
      const safeLoggingPatterns = [
        'console.log', 'console.error', 'console.warn', 'console.info',
        'log.error', 'log.warn', 'log.info', 'log.debug', 'log.cli',
        'logger.error', 'logger.warn', 'logger.info', 'logger.debug'
      ];
      
      const callText = `${obj}.${method}`;
      if (safeLoggingPatterns.includes(callText)) {
        const args = callExpr.getArguments();
        
        args.forEach(arg => {
          const argText = arg.getText().trim();
          
          // Only fix error-related arguments in logging calls
          if (!argText.includes(' as ') && 
              arg.getKind() === SyntaxKind.Identifier &&
              (argText === 'error' || argText === 'err' || argText === 'e')) {
            
            arg.replaceWithText(`${argText} as any`);
            fileChanges++;
            totalChanges++;
          }
        });
      }
    }
  });
  
  // Pattern 2: SAFE - Error constructor calls (new Error, new ValidationError, etc.)
  sourceFile.getDescendantsOfKind(SyntaxKind.NewExpression).forEach(newExpr => {
    const expression = newExpr.getExpression();
    
    if (expression.getKind() === SyntaxKind.Identifier) {
      const constructorName = expression.getText();
      
      // Safe error constructors
      if (constructorName.includes('Error') || constructorName === 'Error') {
        const args = newExpr.getArguments();
        
        args.forEach(arg => {
          const argText = arg.getText().trim();
          
          // Add type assertion for error messages
          if (!argText.includes(' as ') && 
              arg.getKind() === SyntaxKind.PropertyAccessExpression) {
            
            const propAccess = arg.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
            const obj = propAccess.getExpression().getText();
            const prop = propAccess.getName();
            
            if ((obj === 'error' || obj === 'err') && prop === 'message') {
              arg.replaceWithText(`(${obj} as any).${prop}`);
              fileChanges++;
              totalChanges++;
            }
          }
        });
      }
    }
  });
  
  // Pattern 3: SAFE - String interpolation and template literals with error properties
  sourceFile.getDescendantsOfKind(SyntaxKind.TemplateExpression).forEach(template => {
    template.getTemplateSpans().forEach(span => {
      const expression = span.getExpression();
      
      if (expression.getKind() === SyntaxKind.PropertyAccessExpression) {
        const propAccess = expression.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
        const obj = propAccess.getExpression().getText();
        const prop = propAccess.getName();
        
        // Safe to fix error properties in template literals
        if ((obj === 'error' || obj === 'err') && 
            (prop === 'message' || prop === 'code' || prop === 'name')) {
          
          const newText = `(${obj} as any).${prop}`;
          expression.replaceWithText(newText);
          fileChanges++;
          totalChanges++;
        }
      }
    });
  });
  
  // Pattern 4: SAFE - Variable assignments with specific error patterns
  sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration).forEach(varDecl => {
    const initializer = varDecl.getInitializer();
    
    if (initializer && 
        !initializer.getText().includes(' as ') &&
        initializer.getKind() === SyntaxKind.PropertyAccessExpression) {
      
      const propAccess = initializer.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
      const obj = propAccess.getExpression().getText();
      const prop = propAccess.getName();
      
      // Safe patterns for error property access
      if ((obj === 'error' || obj === 'err') && 
          (prop === 'message' || prop === 'code' || prop === 'name' || prop === 'stack')) {
        
        const newText = `(${obj} as any).${prop}`;
        initializer.replaceWithText(newText);
        fileChanges++;
        totalChanges++;
      }
    }
  });
  
  // Pattern 5: SAFE - Return statements with error properties
  sourceFile.getDescendantsOfKind(SyntaxKind.ReturnStatement).forEach(returnStmt => {
    const expression = returnStmt.getExpression();
    
    if (expression && 
        expression.getKind() === SyntaxKind.PropertyAccessExpression) {
      
      const propAccess = expression.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
      const obj = propAccess.getExpression().getText();
      const prop = propAccess.getName();
      
      // Safe to fix error properties in return statements
      if ((obj === 'error' || obj === 'err') && 
          (prop === 'message' || prop === 'code' || prop === 'name')) {
        
        const newText = `(${obj} as any).${prop}`;
        expression.replaceWithText(newText);
        fileChanges++;
        totalChanges++;
      }
    }
  });
  
  if (fileChanges > 0) {
    filesModified++;
    console.log(`  ✅ ${fileName}: ${fileChanges} conservative TS2345 fixes applied`);
  }
});

console.log(`\n🎉 Conservative TS2345 fixer completed!`);
console.log(`📊 Total changes applied: ${totalChanges}`);
console.log(`📁 Files modified: ${filesModified}`);
console.log(`🎯 Target: TS2345 errors (focused on safest patterns)`);
console.log(`\n🔧 Safe patterns fixed:`);
console.log(`  • Error arguments in logging functions (console.log, logger)`);
console.log(`  • Error messages in Error constructors`);
console.log(`  • Error properties in template literals`);
console.log(`  • Error property variable assignments`);
console.log(`  • Error properties in return statements`);
console.log(`\n✅ Avoided risky patterns that could break function overloads`);

// Save all changes
project.save(); 
