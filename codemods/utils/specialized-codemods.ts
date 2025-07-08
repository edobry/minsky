import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { Project, SourceFile, Node, SyntaxKind } from 'ts-morph';
import { join, basename } from 'path';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

/**
 * Options for configuring codemod behavior
 */
export interface CodemodOptions {
  dryRun?: boolean;
  verbose?: boolean;
  includeTests?: boolean;
}

/**
 * Result of applying a codemod to a file
 */
export interface CodemodResult {
  success: boolean;
  changesApplied: number;
  error?: string;
  details?: string;
}

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

/**
 * TypeScript Error Codemod - Handles specific TypeScript error codes systematically
 * 
 * This class provides a framework for fixing specific TypeScript error codes
 * by implementing error-specific patterns while maintaining common functionality
 * like project initialization, file filtering, and progress reporting.
 */
export abstract class TypeScriptErrorCodemod extends BaseCodemod {
  protected project: Project;
  protected abstract errorCode: string;
  protected abstract errorDescription: string;
  protected abstract targetPatterns: string[];

  constructor(options: CodemodOptions = {}) {
    super();
    this.project = new Project({
      tsConfigFilePath: this.findTsConfig(),
      skipAddingFilesFromTsConfig: true,
    });
  }

  private findTsConfig(): string {
    const paths = ['./tsconfig.json', '../tsconfig.json', '../../tsconfig.json'];
    for (const path of paths) {
      if (fs.existsSync(path)) {
        return path;
      }
    }
    return './tsconfig.json';
  }

  protected getSourceFiles(): SourceFile[] {
    const sourceFiles = this.getAllTsFiles('./src').filter(file => 
      !file.includes('/scripts/') && 
      !file.includes('test-utils') &&
      !file.includes('__tests__') &&
      !file.includes('.test.ts') &&
      !file.includes('.spec.ts')
    );

    sourceFiles.forEach(file => this.project.addSourceFileAtPath(file));
    return this.project.getSourceFiles();
  }

  private getAllTsFiles(dir: string): string[] {
    const files: string[] = [];
    
    if (!fs.existsSync(dir)) {
      return files;
    }

    const items = fs.readdirSync(dir);
    
    for (const item of items) {
      const fullPath = path.join(dir, item);
      const stat = fs.statSync(fullPath);
      
      if (stat.isDirectory() && !item.startsWith('.') && item !== 'node_modules') {
        files.push(...this.getAllTsFiles(fullPath));
      } else if (item.endsWith('.ts') && !item.endsWith('.d.ts')) {
        files.push(fullPath);
      }
    }
    
    return files;
  }

  /**
   * Synchronous wrapper for BaseCodemod interface
   */
  applyToFile(filePath: string): boolean {
    const result = this.applyToFileSync(filePath);
    return result.success && result.changesApplied > 0;
  }

  /**
   * Synchronous implementation of file processing
   */
  protected applyToFileSync(filePath: string): CodemodResult {
    const sourceFile = this.project.getSourceFile(filePath);
    if (!sourceFile) {
      return {
        success: false,
        error: `Source file not found: ${filePath}`,
        changesApplied: 0
      };
    }

    const fileName = path.basename(filePath);
    let fileChanges = 0;

    try {
      console.log(`Processing ${fileName} for ${this.errorCode} errors...`);

      // Apply error-specific fixes synchronously
      const changes = this.applyErrorSpecificFixesSync(sourceFile, fileName);
      fileChanges += changes;

      if (fileChanges > 0) {
        console.log(`  ✅ ${fileName}: ${fileChanges} ${this.errorCode} fixes applied`);
      }

      return {
        success: true,
        changesApplied: fileChanges,
        details: `Applied ${fileChanges} ${this.errorCode} fixes`
      };
    } catch (error) {
      return {
        success: false,
        error: `Error processing ${fileName}: ${error}`,
        changesApplied: fileChanges
      };
    }
  }

  /**
   * Abstract method to implement error-specific fixes
   * Each TypeScript error code should implement this method
   */
  protected abstract applyErrorSpecificFixesSync(sourceFile: SourceFile, fileName: string): number;

  /**
   * Helper method to save all changes to project
   */
  protected saveAllChanges(): void {
    this.project.saveSync();
  }

  /**
   * Helper method to get nodes of a specific syntax kind
   */
  protected getNodesOfKind<T extends SyntaxKind>(
    sourceFile: SourceFile,
    kind: T
  ): Node<ts.Node>[] {
    return sourceFile.getDescendantsOfKind(kind);
  }

  /**
   * Helper method to safely replace text in a node
   */
  protected safeReplace(node: Node, newText: string, description: string): boolean {
    try {
      node.replaceWithText(newText);
      console.log(`    ✅ ${description}`);
      return true;
    } catch (error) {
      console.log(`    ⚠️  Failed to replace: ${description} - ${error}`);
      return false;
    }
  }

  /**
   * Helper method to check if a node matches a pattern
   */
  protected matchesPattern(node: Node, patterns: string[]): boolean {
    const nodeText = node.getText();
    return patterns.some(pattern => nodeText.includes(pattern));
  }

  /**
   * Helper method to get function context for a node
   */
  protected getFunctionContext(node: Node): Node | undefined {
    return node.getFirstAncestorByKind(SyntaxKind.FunctionDeclaration) ||
           node.getFirstAncestorByKind(SyntaxKind.ArrowFunction) ||
           node.getFirstAncestorByKind(SyntaxKind.MethodDeclaration);
  }

  /**
   * Helper method to check if a node is in a specific context
   */
  protected isInContext(node: Node, contextKinds: SyntaxKind[]): boolean {
    return contextKinds.some(kind => node.getFirstAncestorByKind(kind) !== undefined);
  }

  run(): void {
    console.log(`🎯 Starting ${this.errorCode} (${this.errorDescription}) error fixer...`);
    console.log(`📊 Target patterns: ${this.targetPatterns.join(', ')}`);

    const sourceFiles = this.getSourceFiles();
    console.log(`📁 Processing ${sourceFiles.length} source files...`);

    let totalChanges = 0;
    let filesModified = 0;

    for (const sourceFile of sourceFiles) {
      const filePath = sourceFile.getFilePath();
      const result = this.applyToFileSync(filePath);
      
      if (result.success && result.changesApplied > 0) {
        totalChanges += result.changesApplied;
        filesModified++;
      } else if (!result.success) {
        console.log(`  ❌ ${result.error}`);
      }
    }

    // Save all changes
    console.log(`\n💾 Saving all changes...`);
    this.saveAllChanges();

    console.log(`\n🎉 ${this.errorCode} error fixer completed!`);
    console.log(`📊 Total changes applied: ${totalChanges}`);
    console.log(`📁 Files modified: ${filesModified}`);
    console.log(`🎯 Target: ${this.errorCode} ${this.errorDescription} errors`);
  }
} 
