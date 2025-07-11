#!/usr/bin/env bun

import { Project, Node, ts, SyntaxKind } from "ts-morph";
import { globSync } from "glob";

/**
 * Codemod Framework Utilities
 * 
 * This framework provides standardized utilities for developing codemods
 * following the AST-first principles established in Task #178.
 * 
 * Key Features:
 * - Standardized project setup
 * - Common issue tracking patterns
 * - Consistent file management
 * - Performance monitoring
 * - Reporting framework
 */

export interface CodemodIssue {
  file: string;
  line: number;
  column: number;
  description: string;
  context: string;
  severity: "error" | "warning" | "info";
  type: string;
  original?: string;
  suggested?: string;
}

export interface CodemodMetrics {
  filesProcessed: number;
  issuesFound: number;
  issuesFixed: number;
  processingTime: number;
  successRate: number;
  errors: string[];
  fileChanges: Map<string, number>;
}

export interface CodemodOptions {
  tsConfigPath?: string;
  includePatterns?: string[];
  excludePatterns?: string[];
  dryRun?: boolean;
  verbose?: boolean;
}

export abstract class CodemodBase {
  protected project: Project;
  protected issues: CodemodIssue[] = [];
  protected metrics: CodemodMetrics = {
    filesProcessed: 0,
    issuesFound: 0,
    issuesFixed: 0,
    processingTime: 0,
    successRate: 0,
    errors: [],
    fileChanges: new Map()
  };
  
  protected options: CodemodOptions;

  constructor(options: CodemodOptions = {}) {
    this.options = {
      tsConfigPath: "./tsconfig.json",
      includePatterns: ["src/**/*.ts", "src/**/*.tsx"],
      excludePatterns: ["**/*.d.ts", "**/*.test.ts", "**/node_modules/**"],
      dryRun: false,
      verbose: false,
      ...options
    };

    this.project = new Project({
      tsConfigFilePath: this.options.tsConfigPath,
      skipAddingFilesFromTsConfig: true,
    });
  }

  /**
   * Main execution method
   */
  async execute(): Promise<void> {
    const startTime = Date.now();
    
    try {
      this.log("🚀 Starting codemod execution...");
      
      // Phase 1: Setup
      this.addSourceFiles();
      
      // Phase 2: Analysis
      this.findIssues();
      
      // Phase 3: Transformation
      if (!this.options.dryRun) {
        this.fixIssues();
        this.saveChanges();
      }
      
      // Phase 4: Reporting
      this.metrics.processingTime = Date.now() - startTime;
      this.generateReport();
      
    } catch (error) {
      this.metrics.errors.push(`Fatal error: ${error}`);
      throw error;
    }
  }

  /**
   * Add source files to the project
   */
  protected addSourceFiles(): void {
    this.log("📁 Adding source files...");
    
    const files = this.options.includePatterns!.flatMap(pattern => 
      globSync(pattern, { ignore: this.options.excludePatterns })
    );
    
    this.log(`Found ${files.length} files to process`);
    
    try {
      this.project.addSourceFilesAtPaths(files);
      this.log(`✅ Added ${files.length} source files`);
    } catch (error) {
      this.metrics.errors.push(`Failed to add source files: ${error}`);
      throw error;
    }
  }

  /**
   * Abstract method for finding issues - must be implemented by subclasses
   */
  protected abstract findIssues(): void;

  /**
   * Abstract method for fixing issues - must be implemented by subclasses
   */
  protected abstract fixIssues(): void;

  /**
   * Save changes to disk
   */
  protected saveChanges(): void {
    this.log("💾 Saving changes...");
    
    const sourceFiles = this.project.getSourceFiles();
    let savedCount = 0;
    
    sourceFiles.forEach(sourceFile => {
      try {
        if (!sourceFile.isSaved()) {
          sourceFile.saveSync();
          savedCount++;
        }
      } catch (error) {
        this.metrics.errors.push(`Failed to save ${sourceFile.getFilePath()}: ${error}`);
      }
    });
    
    this.log(`✅ Saved ${savedCount} modified files`);
  }

  /**
   * Generate comprehensive report
   */
  protected generateReport(): void {
    this.log("\n📊 Codemod Execution Report");
    this.log("=".repeat(50));
    this.log(`Files Processed: ${this.metrics.filesProcessed}`);
    this.log(`Issues Found: ${this.metrics.issuesFound}`);
    this.log(`Issues Fixed: ${this.metrics.issuesFixed}`);
    this.log(`Success Rate: ${this.metrics.successRate.toFixed(1)}%`);
    this.log(`Processing Time: ${this.metrics.processingTime}ms`);
    
    if (this.metrics.errors.length > 0) {
      this.log("\n❌ Errors Encountered:");
      this.metrics.errors.forEach((error, index) => {
        this.log(`${index + 1}. ${error}`);
      });
    }
    
    // Group issues by type
    const issuesByType = this.groupIssuesByType();
    this.log("\n📈 Issues by Type:");
    Object.entries(issuesByType).forEach(([type, count]) => {
      this.log(`${type}: ${count}`);
    });
    
    // File change summary
    if (this.metrics.fileChanges.size > 0) {
      this.log("\n📝 File Changes:");
      Array.from(this.metrics.fileChanges.entries())
        .sort(([, a], [, b]) => b - a)
        .slice(0, 10)
        .forEach(([file, changes]) => {
          this.log(`${file}: ${changes} changes`);
        });
    }
  }

  /**
   * Helper method to add an issue
   */
  protected addIssue(issue: Omit<CodemodIssue, "severity"> & { severity?: CodemodIssue["severity"] }): void {
    this.issues.push({
      severity: "warning",
      ...issue
    });
    this.metrics.issuesFound++;
  }

  /**
   * Helper method to record a fix
   */
  protected recordFix(filePath: string): void {
    this.metrics.issuesFixed++;
    const current = this.metrics.fileChanges.get(filePath) || 0;
    this.metrics.fileChanges.set(filePath, current + 1);
  }

  /**
   * Helper method to get line and column from AST node
   */
  protected getLineAndColumn(node: Node): { line: number; column: number } {
    const sourceFile = node.getSourceFile();
    const pos = node.getStart();
    const lineAndColumn = sourceFile.getLineAndColumnAtPos(pos);
    return {
      line: lineAndColumn.line,
      column: lineAndColumn.column
    };
  }

  /**
   * Helper method to get context around an AST node
   */
  protected getContext(node: Node, maxLength: number = 100): string {
    const text = node.getText();
    return text.length > maxLength ? text.substring(0, maxLength) + "..." : text;
  }

  /**
   * Helper method for logging
   */
  protected log(message: string): void {
    if (this.options.verbose || !message.startsWith("  ")) {
      console.log(message);
    }
  }

  /**
   * Group issues by type for reporting
   */
  private groupIssuesByType(): Record<string, number> {
    return this.issues.reduce((acc, issue) => {
      acc[issue.type] = (acc[issue.type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
  }

  /**
   * Calculate success rate
   */
  protected calculateSuccessRate(): void {
    this.metrics.successRate = this.metrics.issuesFound > 0 
      ? (this.metrics.issuesFixed / this.metrics.issuesFound) * 100 
      : 100;
  }
}

/**
 * Utility functions for common AST operations
 */
export class ASTUtils {
  /**
   * Find all nodes of a specific kind in a source file
   */
  static findNodesOfKind<T extends Node>(sourceFile: Node, kind: SyntaxKind): T[] {
    return sourceFile.getDescendantsOfKind(kind) as T[];
  }

  /**
   * Find variable declarations with specific patterns
   */
  static findVariableDeclarations(sourceFile: Node, predicate?: (decl: any) => boolean): any[] {
    const declarations = sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration);
    return predicate ? declarations.filter(predicate) : declarations;
  }

  /**
   * Find function parameters with specific patterns
   */
  static findFunctionParameters(sourceFile: Node, predicate?: (param: any) => boolean): any[] {
    const parameters = sourceFile.getDescendantsOfKind(SyntaxKind.Parameter);
    return predicate ? parameters.filter(predicate) : parameters;
  }

  /**
   * Find import declarations
   */
  static findImportDeclarations(sourceFile: Node): any[] {
    return sourceFile.getDescendantsOfKind(SyntaxKind.ImportDeclaration);
  }

  /**
   * Find all identifiers with a specific name
   */
  static findIdentifiersByName(sourceFile: Node, name: string): any[] {
    return sourceFile.getDescendantsOfKind(SyntaxKind.Identifier)
      .filter(id => id.getText() === name);
  }

  /**
   * Check if a node is in a specific context (e.g., import declaration)
   */
  static isInContext(node: Node, contextKind: SyntaxKind): boolean {
    let parent = node.getParent();
    while (parent) {
      if (parent.getKind() === contextKind) {
        return true;
      }
      parent = parent.getParent();
    }
    return false;
  }

  /**
   * Safe rename operation with error handling
   */
  static safeRename(node: any, newName: string): boolean {
    try {
      if (node.rename) {
        node.rename(newName);
        return true;
      }
      return false;
    } catch (error) {
      console.error(`Error renaming ${node.getText()} to ${newName}:`, error);
      return false;
    }
  }

  /**
   * Get all usages of a variable/identifier
   */
  static findUsages(sourceFile: Node, variableName: string): any[] {
    const identifiers = sourceFile.getDescendantsOfKind(SyntaxKind.Identifier);
    return identifiers.filter(id => 
      id.getText() === variableName && 
      !ASTUtils.isInContext(id, SyntaxKind.VariableDeclaration) &&
      !ASTUtils.isInContext(id, SyntaxKind.Parameter)
    );
  }
}

/**
 * Common predicate functions for filtering AST nodes
 */
export class CommonPredicates {
  /**
   * Variable has underscore prefix
   */
  static hasUnderscorePrefix(decl: any): boolean {
    const name = decl.getName();
    return typeof name === "string" && name.startsWith("_");
  }

  /**
   * Variable is unused (no references found)
   */
  static isUnused(decl: any): boolean {
    const name = decl.getName();
    if (typeof name !== "string") return false;
    
    const sourceFile = decl.getSourceFile();
    const usages = ASTUtils.findUsages(sourceFile, name);
    return usages.length === 0;
  }

  /**
   * Import is unused
   */
  static isUnusedImport(importDecl: any): boolean {
    const sourceFile = importDecl.getSourceFile();
    const importClause = importDecl.getImportClause();
    if (!importClause) return true;

    // Check named imports
    const namedBindings = importClause.getNamedBindings();
    if (namedBindings && namedBindings.getKind() === SyntaxKind.NamedImports) {
      const elements = namedBindings.getElements();
      return elements.every((element: any) => {
        const name = element.getName();
        const usages = ASTUtils.findUsages(sourceFile, name);
        return usages.length === 0;
      });
    }

    // Check default import
    const defaultImport = importClause.getDefaultImport();
    if (defaultImport) {
      const name = defaultImport.getText();
      const usages = ASTUtils.findUsages(sourceFile, name);
      return usages.length === 0;
    }

    return true;
  }
}

/**
 * Performance monitoring utilities
 */
export class PerformanceMonitor {
  private static timers: Map<string, number> = new Map();

  static start(label: string): void {
    this.timers.set(label, Date.now());
  }

  static end(label: string): number {
    const start = this.timers.get(label);
    if (!start) {
      throw new Error(`Timer ${label} not found`);
    }
    const duration = Date.now() - start;
    this.timers.delete(label);
    return duration;
  }

  static measure<T>(label: string, fn: () => T): T {
    this.start(label);
    try {
      return fn();
    } finally {
      const duration = this.end(label);
      console.log(`⏱️  ${label}: ${duration}ms`);
    }
  }
} 
