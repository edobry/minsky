#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'fs';
import { Project, SourceFile, Node, SyntaxKind } from 'ts-morph';

/**
 * Base class for all specialized codemods
 * Provides common functionality and enforces AST-based approaches
 */
export abstract class BaseCodemod {
  protected project: Project;
  public name: string = '';
  public description: string = '';
  
  constructor() {
    this.project = new Project({
      useInMemoryFileSystem: true,
      compilerOptions: {
        target: 99, // Latest
        module: 99, // ESNext
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
      }
    });
  }

  /**
   * Apply the codemod to a file
   * @param filePath - Path to the file to transform
   * @returns Whether the transformation was successful
   */
  abstract applyToFile(filePath: string): boolean;

  /**
   * Validate that a transformation is safe to apply
   * @param sourceFile - The source file being transformed
   * @returns Whether the transformation is safe
   */
  protected validateTransformation(sourceFile: SourceFile): boolean {
    // Check for syntax errors
    const diagnostics = sourceFile.getPreEmitDiagnostics();
    if (diagnostics.length > 0) {
      console.warn(`Validation failed for ${sourceFile.getFilePath()}: ${diagnostics.length} diagnostics`);
      return false;
    }
    return true;
  }

  /**
   * Apply changes to a file with safety checks
   * @param filePath - Path to the file
   * @param transformFn - Function to apply transformations
   * @returns Whether the transformation was successful
   */
  protected safeApplyChanges(filePath: string, transformFn: (sourceFile: SourceFile) => boolean): boolean {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const sourceFile = this.project.createSourceFile(filePath, content, { overwrite: true });
      
      // Apply transformations
      const hasChanges = transformFn(sourceFile);
      
      if (!hasChanges) {
        return true; // No changes needed
      }

      // Validate before saving
      if (!this.validateTransformation(sourceFile)) {
        return false;
      }

      // Save changes
      writeFileSync(filePath, sourceFile.getFullText());
      return true;
    } catch (error) {
      console.error(`Error applying changes to ${filePath}:`, error);
      return false;
    }
  }
}

/**
 * Handles variable naming fixes, specifically underscore prefix issues
 * Based on AST analysis to ensure syntax correctness
 */
export class VariableNamingCodemod extends BaseCodemod {
  constructor() {
    super();
    this.name = 'VariableNamingCodemod';
    this.description = 'Fixes variable naming issues using AST-based analysis';
  }

  applyToFile(filePath: string): boolean {
    return this.safeApplyChanges(filePath, (sourceFile) => {
      let hasChanges = false;
      
      // Fix parameter underscore mismatches
      sourceFile.getDescendantsOfKind(SyntaxKind.Parameter).forEach(param => {
        const paramName = param.getName();
        if (paramName?.startsWith('_')) {
          const expectedName = paramName.substring(1);
          const function_ = param.getParent();
          
          // Check if function body uses the non-underscore version
          if (function_ && this.functionUsesVariable(function_, expectedName)) {
            param.rename(expectedName);
            hasChanges = true;
          }
        }
      });

             // Fix variable declaration underscore mismatches
       sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration).forEach(decl => {
         const name = decl.getName();
         if (name?.startsWith('_')) {
           const expectedName = name.substring(1);
           // Find the containing scope (function, block, or source file)
           const scope = decl.getFirstAncestorByKind(SyntaxKind.Block) || 
                        decl.getFirstAncestorByKind(SyntaxKind.FunctionDeclaration) ||
                        decl.getFirstAncestorByKind(SyntaxKind.ArrowFunction) ||
                        sourceFile;
           
           // Check if the variable is used without underscore in the same scope
           if (scope && this.scopeUsesVariable(scope, expectedName)) {
             decl.rename(expectedName);
             hasChanges = true;
           }
         }
       });

      return hasChanges;
    });
  }

  private functionUsesVariable(functionNode: Node, variableName: string): boolean {
    return functionNode.getDescendantsOfKind(SyntaxKind.Identifier)
      .some(id => id.getText() === variableName);
  }

  private scopeUsesVariable(scope: Node, variableName: string): boolean {
    return scope.getDescendantsOfKind(SyntaxKind.Identifier)
      .some(id => id.getText() === variableName);
  }
}

/**
 * Handles unused import removal using AST analysis
 * Ensures import statements are actually unused before removal
 */
export class UnusedImportCodemod extends BaseCodemod {
  constructor() {
    super();
    this.name = 'UnusedImportCodemod';
    this.description = 'Removes unused imports using AST-based analysis';
  }

  applyToFile(filePath: string): boolean {
    return this.safeApplyChanges(filePath, (sourceFile) => {
      let hasChanges = false;
      
      sourceFile.getImportDeclarations().forEach(importDecl => {
        const namedImports = importDecl.getNamedImports();
        const unusedImports: string[] = [];
        
        namedImports.forEach(namedImport => {
          const importName = namedImport.getName();
          const isUsed = this.isIdentifierUsed(sourceFile, importName);
          
          if (!isUsed) {
            unusedImports.push(importName);
          }
        });
        
        if (unusedImports.length > 0) {
          // Remove unused named imports
          unusedImports.forEach(unusedImport => {
            const namedImport = namedImports.find(ni => ni.getName() === unusedImport);
            if (namedImport) {
              namedImport.remove();
              hasChanges = true;
            }
          });
          
          // Remove entire import declaration if no named imports remain
          if (importDecl.getNamedImports().length === 0 && !importDecl.getDefaultImport()) {
            importDecl.remove();
            hasChanges = true;
          }
        }
      });

      return hasChanges;
    });
  }

  private isIdentifierUsed(sourceFile: SourceFile, identifier: string): boolean {
    return sourceFile.getDescendantsOfKind(SyntaxKind.Identifier)
      .some(id => id.getText() === identifier && !this.isInImportDeclaration(id));
  }

  private isInImportDeclaration(node: Node): boolean {
    return node.getAncestors().some(ancestor => 
      ancestor.getKind() === SyntaxKind.ImportDeclaration
    );
  }
}

/**
 * Handles unused variable removal using AST analysis
 * Identifies and removes truly unused variables and parameters
 */
export class UnusedVariableCodemod extends BaseCodemod {
  constructor() {
    super();
    this.name = 'UnusedVariableCodemod';
    this.description = 'Removes unused variables using AST-based analysis';
  }

  applyToFile(filePath: string): boolean {
    return this.safeApplyChanges(filePath, (sourceFile) => {
      let hasChanges = false;
      
      // Handle unused parameters by prefixing with underscore
      sourceFile.getDescendantsOfKind(SyntaxKind.Parameter).forEach(param => {
        const paramName = param.getName();
        if (paramName && !paramName.startsWith('_')) {
          const function_ = param.getParent();
          
          if (function_ && !this.functionUsesVariable(function_, paramName)) {
            param.rename(`_${paramName}`);
            hasChanges = true;
          }
        }
      });

             // Handle unused variable declarations
       sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration).forEach(decl => {
         const name = decl.getName();
         if (name && !name.startsWith('_')) {
           // Find the containing scope (function, block, or source file)
           const scope = decl.getFirstAncestorByKind(SyntaxKind.Block) || 
                        decl.getFirstAncestorByKind(SyntaxKind.FunctionDeclaration) ||
                        decl.getFirstAncestorByKind(SyntaxKind.ArrowFunction) ||
                        sourceFile;
           
           if (scope && !this.scopeUsesVariable(scope, name)) {
             // For unused variables, we can either remove them or prefix with underscore
             // Prefixing is safer as it preserves the declaration
             decl.rename(`_${name}`);
             hasChanges = true;
           }
         }
       });

      return hasChanges;
    });
  }

  private functionUsesVariable(functionNode: Node, variableName: string): boolean {
    return functionNode.getDescendantsOfKind(SyntaxKind.Identifier)
      .some(id => id.getText() === variableName && !this.isInParameterDeclaration(id));
  }

  private scopeUsesVariable(scope: Node, variableName: string): boolean {
    return scope.getDescendantsOfKind(SyntaxKind.Identifier)
      .some(id => id.getText() === variableName && !this.isInVariableDeclaration(id));
  }

  private isInParameterDeclaration(node: Node): boolean {
    return node.getAncestors().some(ancestor => 
      ancestor.getKind() === SyntaxKind.Parameter
    );
  }

  private isInVariableDeclaration(node: Node): boolean {
    return node.getAncestors().some(ancestor => 
      ancestor.getKind() === SyntaxKind.VariableDeclaration
    );
  }
}

/**
 * Handles type assertion fixes using AST analysis
 * Converts unsafe type assertions to proper type handling
 */
export class TypeAssertionCodemod extends BaseCodemod {
  constructor() {
    super();
    this.name = 'TypeAssertionCodemod';
    this.description = 'Fixes type assertions using AST-based analysis';
  }

  applyToFile(filePath: string): boolean {
    return this.safeApplyChanges(filePath, (sourceFile) => {
      let hasChanges = false;
      
      // Fix 'as any' type assertions
      sourceFile.getDescendantsOfKind(SyntaxKind.AsExpression).forEach(asExpr => {
        const typeNode = asExpr.getTypeNode();
        if (typeNode && typeNode.getText() === 'any') {
          // Replace 'as any' with 'as unknown' which is safer
          typeNode.replaceWithText('unknown');
          hasChanges = true;
        }
      });

      // Fix implicit any by adding explicit unknown
      sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration).forEach(decl => {
        if (!decl.getTypeNode() && !decl.getInitializer()) {
          // Add explicit unknown type for untyped variables
          decl.setType('unknown');
          hasChanges = true;
        }
      });

      return hasChanges;
    });
  }
} 
