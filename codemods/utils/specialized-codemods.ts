#!/usr/bin/env bun

import { SyntaxKind, Node, SourceFile } from "ts-morph";
import { CodemodBase, CodemodOptions, ASTUtils, CommonPredicates } from "./codemod-framework";

/**
 * Specialized Codemod Classes
 * 
 * These classes implement common codemod patterns using the framework,
 * making it easy to create new codemods for specific scenarios.
 */

/**
 * Variable Naming Codemod
 * 
 * Fixes variable naming issues, particularly underscore mismatches
 * Based on the successful fix-variable-naming-ast.ts pattern
 */
export class VariableNamingCodemod extends CodemodBase {
  constructor(options: CodemodOptions = {}) {
    super(options);
  }

  protected findIssues(): void {
    this.log("🔍 Finding variable naming issues...");
    
    const sourceFiles = this.project.getSourceFiles();
    this.metrics.filesProcessed = sourceFiles.length;
    
    sourceFiles.forEach(sourceFile => {
      this.analyzeVariableDeclarations(sourceFile);
      this.analyzeFunctionParameters(sourceFile);
    });
    
    this.log(`Found ${this.issues.length} variable naming issues`);
  }

  protected fixIssues(): void {
    this.log("🔧 Fixing variable naming issues...");
    
    this.issues.forEach(issue => {
      try {
        this.fixVariableNaming(issue);
      } catch (error) {
        this.metrics.errors.push(`Failed to fix ${issue.file}:${issue.line} - ${error}`);
      }
    });
    
    this.calculateSuccessRate();
    this.log(`✅ Fixed ${this.metrics.issuesFixed} variable naming issues`);
  }

  private analyzeVariableDeclarations(sourceFile: SourceFile): void {
    const declarations = ASTUtils.findVariableDeclarations(
      sourceFile, 
      CommonPredicates.hasUnderscorePrefix
    );
    
    declarations.forEach(decl => {
      const name = decl.getName();
      const nameWithoutUnderscore = name.replace(/^_+/, "");
      
      // Check if variable is used without underscore
      const usages = ASTUtils.findUsages(sourceFile, nameWithoutUnderscore);
      
      if (usages.length > 0) {
        const { line, column } = this.getLineAndColumn(decl);
        
        this.addIssue({
          file: sourceFile.getFilePath(),
          line,
          column,
          description: `Variable '${name}' declared with underscore but used as '${nameWithoutUnderscore}'`,
          context: this.getContext(decl),
          type: "variable-naming",
          original: name,
          suggested: nameWithoutUnderscore
        });
      }
    });
  }

  private analyzeFunctionParameters(sourceFile: SourceFile): void {
    const parameters = ASTUtils.findFunctionParameters(
      sourceFile,
      CommonPredicates.hasUnderscorePrefix
    );
    
    parameters.forEach(param => {
      const name = param.getName();
      const nameWithoutUnderscore = name.replace(/^_+/, "");
      
      // Check if parameter is used without underscore in function body
      const usages = ASTUtils.findUsages(sourceFile, nameWithoutUnderscore);
      
      if (usages.length > 0) {
        const { line, column } = this.getLineAndColumn(param);
        
        this.addIssue({
          file: sourceFile.getFilePath(),
          line,
          column,
          description: `Parameter '${name}' declared with underscore but used as '${nameWithoutUnderscore}'`,
          context: this.getContext(param.getParent()),
          type: "parameter-naming",
          original: name,
          suggested: nameWithoutUnderscore
        });
      }
    });
  }

  private fixVariableNaming(issue: any): void {
    const sourceFile = this.project.getSourceFile(issue.file);
    if (!sourceFile) return;

    // Find the declaration and rename it
    const declarations = ASTUtils.findVariableDeclarations(sourceFile);
    const parameters = ASTUtils.findFunctionParameters(sourceFile);
    
    [...declarations, ...parameters].forEach(node => {
      const { line } = this.getLineAndColumn(node);
      
      if (line === issue.line && node.getName() === issue.original) {
        const nameNode = node.getNameNode();
        if (nameNode && ASTUtils.safeRename(nameNode, issue.suggested)) {
          this.recordFix(issue.file);
        }
      }
    });
  }
}

/**
 * Unused Import Cleanup Codemod
 * 
 * Removes unused imports from files
 * Consolidates multiple unused import codemods into one
 */
export class UnusedImportCodemod extends CodemodBase {
  constructor(options: CodemodOptions = {}) {
    super(options);
  }

  protected findIssues(): void {
    this.log("🔍 Finding unused imports...");
    
    const sourceFiles = this.project.getSourceFiles();
    this.metrics.filesProcessed = sourceFiles.length;
    
    sourceFiles.forEach(sourceFile => {
      this.analyzeImports(sourceFile);
    });
    
    this.log(`Found ${this.issues.length} unused imports`);
  }

  protected fixIssues(): void {
    this.log("🔧 Removing unused imports...");
    
    // Group issues by file for efficient processing
    const issuesByFile = this.groupIssuesByFile();
    
    Object.entries(issuesByFile).forEach(([filePath, issues]) => {
      this.fixImportsInFile(filePath, issues);
    });
    
    this.calculateSuccessRate();
    this.log(`✅ Removed ${this.metrics.issuesFixed} unused imports`);
  }

  private analyzeImports(sourceFile: SourceFile): void {
    const importDeclarations = ASTUtils.findImportDeclarations(sourceFile);
    
    importDeclarations.forEach(importDecl => {
      const importClause = importDecl.getImportClause();
      if (!importClause) return;

      // Check named imports
      const namedBindings = importClause.getNamedBindings();
      if (namedBindings && namedBindings.getKind() === SyntaxKind.NamedImports) {
        const elements = namedBindings.getElements();
        
        elements.forEach((element: any) => {
          const name = element.getName();
          const usages = ASTUtils.findUsages(sourceFile, name);
          
          if (usages.length === 0) {
            const { line, column } = this.getLineAndColumn(element);
            
            this.addIssue({
              file: sourceFile.getFilePath(),
              line,
              column,
              description: `Unused named import: ${name}`,
              context: this.getContext(importDecl),
              type: "unused-named-import",
              original: name
            });
          }
        });
      }

      // Check default import
      const defaultImport = importClause.getDefaultImport();
      if (defaultImport) {
        const name = defaultImport.getText();
        const usages = ASTUtils.findUsages(sourceFile, name);
        
        if (usages.length === 0) {
          const { line, column } = this.getLineAndColumn(defaultImport);
          
          this.addIssue({
            file: sourceFile.getFilePath(),
            line,
            column,
            description: `Unused default import: ${name}`,
            context: this.getContext(importDecl),
            type: "unused-default-import",
            original: name
          });
        }
      }
    });
  }

  private groupIssuesByFile(): Record<string, any[]> {
    return this.issues.reduce((acc, issue) => {
      if (!acc[issue.file]) acc[issue.file] = [];
      acc[issue.file].push(issue);
      return acc;
    }, {} as Record<string, any[]>);
  }

  private fixImportsInFile(filePath: string, issues: any[]): void {
    const sourceFile = this.project.getSourceFile(filePath);
    if (!sourceFile) return;

    const importDeclarations = ASTUtils.findImportDeclarations(sourceFile);
    
    importDeclarations.forEach(importDecl => {
      const importClause = importDecl.getImportClause();
      if (!importClause) return;

      let shouldRemoveEntireImport = false;
      let hasRemainingImports = false;

      // Handle named imports
      const namedBindings = importClause.getNamedBindings();
      if (namedBindings && namedBindings.getKind() === SyntaxKind.NamedImports) {
        const elements = namedBindings.getElements();
        const unusedElements = elements.filter((element: any) => {
          const name = element.getName();
          return issues.some(issue => 
            issue.type === "unused-named-import" && issue.original === name
          );
        });

        if (unusedElements.length > 0) {
          unusedElements.forEach((element: any) => {
            element.remove();
            this.recordFix(filePath);
          });
        }

        hasRemainingImports = elements.length > unusedElements.length;
      }

      // Handle default import
      const defaultImport = importClause.getDefaultImport();
      if (defaultImport) {
        const name = defaultImport.getText();
        const hasUnusedDefault = issues.some(issue => 
          issue.type === "unused-default-import" && issue.original === name
        );

        if (hasUnusedDefault) {
          if (!hasRemainingImports) {
            shouldRemoveEntireImport = true;
          } else {
            defaultImport.remove();
            this.recordFix(filePath);
          }
        }
      }

      // Remove entire import if nothing is left
      if (shouldRemoveEntireImport) {
        importDecl.remove();
        this.recordFix(filePath);
      }
    });
  }
}

/**
 * Unused Variable Cleanup Codemod
 * 
 * Removes unused variables and parameters
 * Consolidates multiple unused variable codemods
 */
export class UnusedVariableCodemod extends CodemodBase {
  constructor(options: CodemodOptions = {}) {
    super(options);
  }

  protected findIssues(): void {
    this.log("🔍 Finding unused variables...");
    
    const sourceFiles = this.project.getSourceFiles();
    this.metrics.filesProcessed = sourceFiles.length;
    
    sourceFiles.forEach(sourceFile => {
      this.analyzeUnusedVariables(sourceFile);
      this.analyzeUnusedParameters(sourceFile);
    });
    
    this.log(`Found ${this.issues.length} unused variables`);
  }

  protected fixIssues(): void {
    this.log("🔧 Removing unused variables...");
    
    this.issues.forEach(issue => {
      try {
        this.fixUnusedVariable(issue);
      } catch (error) {
        this.metrics.errors.push(`Failed to fix ${issue.file}:${issue.line} - ${error}`);
      }
    });
    
    this.calculateSuccessRate();
    this.log(`✅ Removed ${this.metrics.issuesFixed} unused variables`);
  }

  private analyzeUnusedVariables(sourceFile: SourceFile): void {
    const declarations = ASTUtils.findVariableDeclarations(
      sourceFile,
      CommonPredicates.isUnused
    );
    
    declarations.forEach(decl => {
      const name = decl.getName();
      const { line, column } = this.getLineAndColumn(decl);
      
      this.addIssue({
        file: sourceFile.getFilePath(),
        line,
        column,
        description: `Unused variable: ${name}`,
        context: this.getContext(decl),
        type: "unused-variable",
        original: name
      });
    });
  }

  private analyzeUnusedParameters(sourceFile: SourceFile): void {
    const parameters = ASTUtils.findFunctionParameters(
      sourceFile,
      CommonPredicates.isUnused
    );
    
    parameters.forEach(param => {
      const name = param.getName();
      const { line, column } = this.getLineAndColumn(param);
      
      this.addIssue({
        file: sourceFile.getFilePath(),
        line,
        column,
        description: `Unused parameter: ${name}`,
        context: this.getContext(param.getParent()),
        type: "unused-parameter",
        original: name
      });
    });
  }

  private fixUnusedVariable(issue: any): void {
    const sourceFile = this.project.getSourceFile(issue.file);
    if (!sourceFile) return;

    if (issue.type === "unused-variable") {
      const declarations = ASTUtils.findVariableDeclarations(sourceFile);
      declarations.forEach(decl => {
        const { line } = this.getLineAndColumn(decl);
        
        if (line === issue.line && decl.getName() === issue.original) {
          // Remove the entire variable statement if it's the only declaration
          const variableStatement = decl.getParent().getParent();
          if (variableStatement && variableStatement.getKind() === SyntaxKind.VariableStatement) {
            const declarations = variableStatement.getDeclarations();
            if (declarations.length === 1) {
              variableStatement.remove();
            } else {
              decl.remove();
            }
            this.recordFix(issue.file);
          }
        }
      });
    } else if (issue.type === "unused-parameter") {
      const parameters = ASTUtils.findFunctionParameters(sourceFile);
      parameters.forEach(param => {
        const { line } = this.getLineAndColumn(param);
        
        if (line === issue.line && param.getName() === issue.original) {
          // Prefix with underscore instead of removing (common pattern)
          const nameNode = param.getNameNode();
          if (nameNode && ASTUtils.safeRename(nameNode, `_${issue.original}`)) {
            this.recordFix(issue.file);
          }
        }
      });
    }
  }
}

/**
 * Type Assertion Codemod
 * 
 * Adds or removes type assertions based on TypeScript errors
 * Consolidates multiple type assertion codemods
 */
export class TypeAssertionCodemod extends CodemodBase {
  private typeErrorPatterns: RegExp[] = [
    /TS2322/, // Type not assignable
    /TS2345/, // Argument type not assignable
    /TS2339/, // Property does not exist
    /TS18046/, // Unknown type
  ];

  constructor(options: CodemodOptions = {}) {
    super(options);
  }

  protected findIssues(): void {
    this.log("🔍 Finding type assertion opportunities...");
    
    const sourceFiles = this.project.getSourceFiles();
    this.metrics.filesProcessed = sourceFiles.length;
    
    sourceFiles.forEach(sourceFile => {
      this.analyzeTypeAssertions(sourceFile);
    });
    
    this.log(`Found ${this.issues.length} type assertion opportunities`);
  }

  protected fixIssues(): void {
    this.log("🔧 Applying type assertions...");
    
    this.issues.forEach(issue => {
      try {
        this.fixTypeAssertion(issue);
      } catch (error) {
        this.metrics.errors.push(`Failed to fix ${issue.file}:${issue.line} - ${error}`);
      }
    });
    
    this.calculateSuccessRate();
    this.log(`✅ Applied ${this.metrics.issuesFixed} type assertions`);
  }

  private analyzeTypeAssertions(sourceFile: SourceFile): void {
    // Find expressions that might benefit from type assertions
    const expressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
    
    expressions.forEach(expr => {
      const type = expr.getType();
      const typeText = type.getText();
      
      // Look for unknown types or overly broad types
      if (typeText.includes("unknown") || typeText.includes("any")) {
        const { line, column } = this.getLineAndColumn(expr);
        
        this.addIssue({
          file: sourceFile.getFilePath(),
          line,
          column,
          description: `Expression has ${typeText} type, may need assertion`,
          context: this.getContext(expr),
          type: "type-assertion",
          original: typeText
        });
      }
    });
  }

  private fixTypeAssertion(issue: any): void {
    const sourceFile = this.project.getSourceFile(issue.file);
    if (!sourceFile) return;

    // This is a simplified implementation
    // In practice, you'd need more sophisticated type analysis
    const expressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
    
    expressions.forEach(expr => {
      const { line } = this.getLineAndColumn(expr);
      
      if (line === issue.line) {
        // Add type assertion based on context
        const newText = `${expr.getText()} as string`; // Simplified
        expr.replaceWithText(newText);
        this.recordFix(issue.file);
      }
    });
  }
} 
