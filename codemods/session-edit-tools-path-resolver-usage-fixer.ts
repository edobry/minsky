#!/usr/bin/env bun

/**
 * AST Codemod: Session Edit Tools SessionPathResolver Usage Fixer
 * 
 * SYSTEMATIC AST CODEMOD - Session Edit Tools Mock Infrastructure (Part 2)
 * 
 * Problem: Session Edit Tools tests try to instantiate SessionPathResolver directly
 * - Tests use: new SessionPathResolver() - not available in mocked context
 * - Module mock provides: mockResolvePath, mockValidatePath - available globally
 * 
 * This codemod:
 * 1. Removes direct SessionPathResolver instantiation attempts
 * 2. Updates tests to use the existing module-level mocks (mockResolvePath, mockValidatePath)
 * 3. Ensures test logic works with the properly mocked behavior
 * 
 * Target Files:
 * - tests/adapters/mcp/session-edit-tools.test.ts
 * 
 * Expected Impact: +3 passing tests (remaining Session Edit Tools test failures)
 */

import { Project, SourceFile, SyntaxKind, NewExpression, VariableDeclaration } from "ts-morph";

interface PathResolverFixResult {
  filePath: string;
  changed: boolean;
  reason: string;
}

export function fixSessionPathResolverUsage(sourceFile: SourceFile): PathResolverFixResult {
  const filePath = sourceFile.getFilePath();
  const content = sourceFile.getFullText();
  
  // Only process the specific test file
  if (!filePath.includes('session-edit-tools.test.ts')) {
    return {
      filePath,
      changed: false,
      reason: 'Not the target session-edit-tools test file - skipped'
    };
  }
  
  let fixed = false;
  
  // Find all variable declarations that instantiate SessionPathResolver
  const variableDeclarations = sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration);
  
  for (const varDecl of variableDeclarations) {
    const initializer = varDecl.getInitializer();
    
    if (initializer && initializer.getKind() === SyntaxKind.NewExpression) {
      const newExpr = initializer as NewExpression;
      const expression = newExpr.getExpression();
      
      if (expression.getText() === "SessionPathResolver") {
        // Found: const mockPathResolver = new SessionPathResolver() as unknown;
        // Remove this entire variable declaration as it's not needed
        
        const variableStatement = varDecl.getParent().getParent();
        if (variableStatement) {
          variableStatement.remove();
          fixed = true;
          console.log(`✅ Removed unnecessary SessionPathResolver instantiation in ${filePath}`);
        }
      }
    }
  }
  
  // Also look for any usage of mockPathResolver.resolvePath or mockPathResolver.validatePath
  // and replace with direct mock usage
  const propertyAccessExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression);
  
  for (const propAccess of propertyAccessExpressions) {
    const objectName = propAccess.getExpression().getText();
    const propertyName = propAccess.getName();
    
    if (objectName === "mockPathResolver") {
      if (propertyName === "resolvePath") {
        // Replace mockPathResolver.resolvePath with mockResolvePath
        propAccess.replaceWithText("mockResolvePath");
        fixed = true;
        console.log(`✅ Replaced mockPathResolver.resolvePath with mockResolvePath in ${filePath}`);
      } else if (propertyName === "validatePath" || propertyName === "validatePathExists") {
        // Replace mockPathResolver.validatePath with mockValidatePath
        propAccess.replaceWithText("mockValidatePath");
        fixed = true;
        console.log(`✅ Replaced mockPathResolver.${propertyName} with mockValidatePath in ${filePath}`);
      }
    }
  }
  
  if (fixed) {
    sourceFile.saveSync();
    return {
      filePath,
      changed: true,
      reason: 'Updated SessionPathResolver usage to use module-level mocks instead of instantiation'
    };
  }
  
  return {
    filePath,
    changed: false,
    reason: 'No SessionPathResolver instantiation issues found'
  };
}

export function fixSessionEditToolsPathResolver(filePaths: string[]): PathResolverFixResult[] {
  const project = new Project({
    tsConfigFilePath: "./tsconfig.json",
    skipAddingFilesFromTsConfig: true,
  });
  
  // Add source files to project
  for (const filePath of filePaths) {
    project.addSourceFileAtPath(filePath);
  }
  
  const results: PathResolverFixResult[] = [];
  
  for (const sourceFile of project.getSourceFiles()) {
    const result = fixSessionPathResolverUsage(sourceFile);
    results.push(result);
  }
  
  return results;
}

// Self-executing main function for standalone usage
if (import.meta.main) {
  const sessionEditToolsTestFiles = [
    "/Users/edobry/.local/state/minsky/sessions/task#276/tests/adapters/mcp/session-edit-tools.test.ts"
  ];
  
  console.log("🔧 Fixing Session Edit Tools SessionPathResolver usage issues...");
  const results = fixSessionEditToolsPathResolver(sessionEditToolsTestFiles);
  
  const changedCount = results.filter(r => r.changed).length;
  console.log(`\n🎯 Fixed SessionPathResolver usage in ${changedCount} Session Edit Tools test files!`);
  
  if (changedCount > 0) {
    console.log("\n🧪 You can now run: bun test tests/adapters/mcp/session-edit-tools.test.ts");
  }
} 
