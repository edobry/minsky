import { readFileSync, writeFileSync } from 'fs';
import { Project, SourceFile, Node, SyntaxKind } from 'ts-morph';

/**
 * Base Codemod Class
 * 
 * Provides common functionality for all codemods including:
 * - File processing with error handling
 * - AST project management
 * - Safe file transformations
 */
export abstract class BaseCodemod {
  protected project: Project;
  protected name: string = 'BaseCodemod';
  protected description: string = 'Base codemod functionality';

  constructor() {
    this.project = new Project({
      tsConfigFilePath: process.cwd() + '/tsconfig.json',
      skipAddingFilesFromTsConfig: true
    });
  }

  /**
   * Apply the codemod to a single file
   * Should be implemented by subclasses
   */
  abstract applyToFile(filePath: string): boolean;

  /**
   * Safely apply changes to a file with error handling
   */
  protected safeApplyChanges(filePath: string, transformFn: (sourceFile: SourceFile) => boolean): boolean {
    try {
      const sourceFile = this.project.addSourceFileAtPath(filePath);
      const hasChanges = transformFn(sourceFile);
      
      if (hasChanges) {
        sourceFile.saveSync();
        console.log(`✅ Applied changes to ${filePath}`);
      }
      
      return hasChanges;
    } catch (error) {
      console.error(`❌ Error processing ${filePath}:`, error);
      return false;
    }
  }

  /**
   * Helper: Check if a function uses a specific variable
   */
  protected functionUsesVariable(functionNode: Node, variableName: string): boolean {
    const identifiers = functionNode.getDescendantsOfKind(SyntaxKind.Identifier);
    return identifiers.some(id => id.getText() === variableName);
  }

  /**
   * Helper: Check if a scope (block, function, etc.) uses a specific variable
   */
  protected scopeUsesVariable(scopeNode: Node, variableName: string): boolean {
    const identifiers = scopeNode.getDescendantsOfKind(SyntaxKind.Identifier);
    return identifiers.some(id => id.getText() === variableName);
  }
}

/**
 * Variable Naming Codemod
 * 
 * Fixes variable naming issues, particularly underscore mismatches
 * Based on the successful fix-variable-naming-ast.ts pattern
 */
export class VariableNamingCodemod extends BaseCodemod {
  constructor() {
    super();
    this.name = 'VariableNamingCodemod';
    this.description = 'Fixes variable naming issues, particularly underscore mismatches';
  }

  /**
   * Apply variable naming fixes to a file
   */
  applyToFile(filePath: string): boolean {
    return this.safeApplyChanges(filePath, (sourceFile) => {
      let hasChanges = false;
      
      // Fix parameter underscore mismatches
      hasChanges = this.fixParameterUnderscoreMismatches(sourceFile) || hasChanges;
      
      // Fix variable declaration underscore mismatches
      hasChanges = this.fixVariableDeclarationMismatches(sourceFile) || hasChanges;
      
      return hasChanges;
    });
  }

  /**
   * Fix parameter underscore mismatches
   */
  private fixParameterUnderscoreMismatches(sourceFile: SourceFile): boolean {
    let hasChanges = false;
    
    sourceFile.getDescendantsOfKind(SyntaxKind.Parameter).forEach(param => {
      const paramName = param.getName();
      if (paramName?.startsWith('_')) {
        const expectedName = paramName.substring(1);
        const functionNode = param.getParent();
        
        // Check if function body uses the non-underscore version
        if (functionNode && this.functionUsesVariable(functionNode, expectedName)) {
          param.rename(expectedName);
          hasChanges = true;
        }
      }
    });
    
    return hasChanges;
  }

  /**
   * Fix variable declaration underscore mismatches
   */
  private fixVariableDeclarationMismatches(sourceFile: SourceFile): boolean {
    let hasChanges = false;
    
    sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration).forEach(decl => {
      const name = decl.getName();
      if (name?.startsWith('_')) {
        const expectedName = name.substring(1);
        // Find the containing scope
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
  }
}

/**
 * Unused Import Codemod
 * 
 * Removes unused imports from files
 * Consolidates multiple unused import codemods into one
 */
export class UnusedImportCodemod extends BaseCodemod {
  constructor() {
    super();
    this.name = 'UnusedImportCodemod';
    this.description = 'Removes unused imports from files';
  }

  /**
   * Apply unused import cleanup to a file
   */
  applyToFile(filePath: string): boolean {
    return this.safeApplyChanges(filePath, (sourceFile) => {
      let hasChanges = false;
      
      // Remove unused named imports
      hasChanges = this.removeUnusedNamedImports(sourceFile) || hasChanges;
      
      // Remove unused default imports
      hasChanges = this.removeUnusedDefaultImports(sourceFile) || hasChanges;
      
      // Remove empty import statements
      hasChanges = this.removeEmptyImports(sourceFile) || hasChanges;
      
      return hasChanges;
    });
  }

  /**
   * Remove unused named imports
   */
  private removeUnusedNamedImports(sourceFile: SourceFile): boolean {
    let hasChanges = false;
    
    sourceFile.getImportDeclarations().forEach(importDecl => {
      const importClause = importDecl.getImportClause();
      if (!importClause) return;

      const namedBindings = importClause.getNamedBindings();
      if (namedBindings && Node.isNamedImports(namedBindings)) {
        const elements = namedBindings.getElements();
        
        elements.forEach(element => {
          const name = element.getName();
          const usages = this.findUsagesInFile(sourceFile, name);
          
          if (usages.length === 0) {
            element.remove();
            hasChanges = true;
          }
        });
      }
    });
    
    return hasChanges;
  }

  /**
   * Remove unused default imports
   */
  private removeUnusedDefaultImports(sourceFile: SourceFile): boolean {
    let hasChanges = false;
    
    sourceFile.getImportDeclarations().forEach(importDecl => {
      const importClause = importDecl.getImportClause();
      if (!importClause) return;

      const defaultImport = importClause.getDefaultImport();
      if (defaultImport) {
        const name = defaultImport.getText();
        const usages = this.findUsagesInFile(sourceFile, name);
        
        if (usages.length === 0) {
          // Mark entire import for removal if only default import
          const namedBindings = importClause.getNamedBindings();
          if (!namedBindings || (Node.isNamedImports(namedBindings) && namedBindings.getElements().length === 0)) {
            importDecl.remove();
            hasChanges = true;
          }
        }
      }
    });
    
    return hasChanges;
  }

  /**
   * Remove empty import statements
   */
  private removeEmptyImports(sourceFile: SourceFile): boolean {
    let hasChanges = false;
    
    sourceFile.getImportDeclarations().forEach(importDecl => {
      const importClause = importDecl.getImportClause();
      if (!importClause) return;

      const hasDefault = importClause.getDefaultImport();
      const namedBindings = importClause.getNamedBindings();
      const hasNamed = namedBindings && Node.isNamedImports(namedBindings) && 
                      namedBindings.getElements().length > 0;

      if (!hasDefault && !hasNamed) {
        importDecl.remove();
        hasChanges = true;
      }
    });
    
    return hasChanges;
  }

  /**
   * Find usages of a name in the file
   */
  private findUsagesInFile(sourceFile: SourceFile, name: string): Node[] {
    const usages: Node[] = [];
    
    sourceFile.getDescendantsOfKind(SyntaxKind.Identifier).forEach(identifier => {
      if (identifier.getText() === name) {
        // Check if this is a usage (not a declaration)
        const parent = identifier.getParent();
        if (!Node.isImportSpecifier(parent) && !Node.isImportClause(parent)) {
          usages.push(identifier);
        }
      }
    });
    
    return usages;
  }
}

/**
 * Unused Variable Codemod
 * 
 * Handles unused variable and parameter management
 */
export class UnusedVariableCodemod extends BaseCodemod {
  constructor() {
    super();
    this.name = 'UnusedVariableCodemod';
    this.description = 'Handles unused variable and parameter management';
  }

  /**
   * Apply unused variable cleanup to a file
   */
  applyToFile(filePath: string): boolean {
    return this.safeApplyChanges(filePath, (sourceFile) => {
      let hasChanges = false;
      
      // Add underscore prefix to unused parameters
      hasChanges = this.prefixUnusedParameters(sourceFile) || hasChanges;
      
      // Add underscore prefix to unused variables
      hasChanges = this.prefixUnusedVariables(sourceFile) || hasChanges;
      
      return hasChanges;
    });
  }

  /**
   * Add underscore prefix to unused parameters
   */
  private prefixUnusedParameters(sourceFile: SourceFile): boolean {
    let hasChanges = false;
    
    sourceFile.getDescendantsOfKind(SyntaxKind.Parameter).forEach(param => {
      const paramName = param.getName();
      if (!paramName || paramName.startsWith('_')) return;
      
      const functionNode = param.getParent();
      if (!functionNode) return;
      
      // Check if parameter is used in function body
      if (!this.functionUsesVariable(functionNode, paramName)) {
        param.rename('_' + paramName);
        hasChanges = true;
      }
    });
    
    return hasChanges;
  }

  /**
   * Add underscore prefix to unused variables
   */
  private prefixUnusedVariables(sourceFile: SourceFile): boolean {
    let hasChanges = false;
    
    sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration).forEach(decl => {
      const name = decl.getName();
      if (!name || name.startsWith('_')) return;
      
      const scope = decl.getFirstAncestorByKind(SyntaxKind.Block) || 
                   decl.getFirstAncestorByKind(SyntaxKind.FunctionDeclaration) ||
                   decl.getFirstAncestorByKind(SyntaxKind.ArrowFunction) ||
                   sourceFile;
      
      if (!scope) return;
      
      // Check if variable is used in scope
      if (!this.scopeUsesVariable(scope, name)) {
        decl.rename('_' + name);
        hasChanges = true;
      }
    });
    
    return hasChanges;
  }
}

/**
 * Type Assertion Codemod
 * 
 * Manages type assertion fixes and safety improvements
 */
export class TypeAssertionCodemod extends BaseCodemod {
  constructor() {
    super();
    this.name = 'TypeAssertionCodemod';
    this.description = 'Manages type assertion fixes and safety improvements';
  }

  /**
   * Apply type assertion fixes to a file
   */
  applyToFile(filePath: string): boolean {
    return this.safeApplyChanges(filePath, (sourceFile) => {
      let hasChanges = false;
      
      // Fix basic type assertions
      hasChanges = this.fixBasicTypeAssertions(sourceFile) || hasChanges;
      
      // Add safe type guards
      hasChanges = this.addSafeTypeGuards(sourceFile) || hasChanges;
      
      return hasChanges;
    });
  }

  /**
   * Fix basic type assertions
   */
  private fixBasicTypeAssertions(sourceFile: SourceFile): boolean {
    let hasChanges = false;
    
    // Find places where 'as any' might be needed
    sourceFile.getDescendantsOfKind(SyntaxKind.BinaryExpression).forEach(expr => {
      // This is a placeholder - specific type assertion logic would go here
      // Based on the actual TypeScript errors found
    });
    
    return hasChanges;
  }

  /**
   * Add safe type guards
   */
  private addSafeTypeGuards(sourceFile: SourceFile): boolean {
    let hasChanges = false;
    
    // Add type guards where needed
    // This is a placeholder for more complex type safety logic
    
    return hasChanges;
  }
} 
