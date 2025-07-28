#!/usr/bin/env bun

/**
 * AST Codemod: Global to Module-Level Mocking Migration
 *
 * PROBLEM: Test files use problematic global mocking patterns that cause test isolation failures:
 * - spyOn(fs, "existsSync") creates global state contamination
 * - Complex beforeEach/afterEach cleanup indicates test interference
 * - 129 failing tests likely caused by these patterns
 *
 * SOLUTION: Transform to module-level mocking for proper test isolation:
 * - spyOn(fs, "method") → mock.module("fs", () => ({ method: mock(...) }))
 * - Remove complex mock variable management
 * - Eliminate beforeEach/afterEach mock cleanup
 *
 * Target: Task #176 - Comprehensive Test Architecture Fix
 */

import { Project, SourceFile, SyntaxKind, CallExpression, VariableDeclaration } from "ts-morph";
import { CodemodBase, CodemodIssue, CodemodOptions } from "./utils/codemod-framework";

interface SpyOnPattern {
  variable: string;
  module: string;
  method: string;
  mockImplementations: CallExpression[];
  variableDeclaration: VariableDeclaration;
  spyOnCalls: CallExpression[];
}

export class GlobalToModuleMockingMigrator extends CodemodBase {
  constructor(options: CodemodOptions = {}) {
    super({
      includePatterns: ["**/*.test.ts", "**/*.spec.ts"],
      excludePatterns: [
        "**/node_modules/**", 
        "**/codemods/**",
        "**/*.d.ts"
      ],
      ...options,
    });
  }

  protected findIssues(): void {
    this.log("🔍 Finding global mocking patterns for migration...");

    const sourceFiles = this.project.getSourceFiles();

    for (const sourceFile of sourceFiles) {
      const spyOnPatterns = this.findSpyOnPatterns(sourceFile);
      
      for (const pattern of spyOnPatterns) {
        this.addIssue({
          file: sourceFile.getFilePath(),
          line: pattern.variableDeclaration.getStartLineNumber(),
          column: pattern.variableDeclaration.getStart() - pattern.variableDeclaration.getStartLinePos() + 1,
          description: `Global mocking pattern: ${pattern.variable} = spyOn(${pattern.module}, "${pattern.method}")`,
          context: pattern.variableDeclaration.getFullText().trim(),
          severity: "warning",
          type: "global-mocking",
          original: `spyOn(${pattern.module}, "${pattern.method}")`,
          suggested: `mock.module("${pattern.module}", () => ({ ${pattern.method}: mock(...) }))`,
        });
      }

      this.metrics.filesProcessed++;
    }

    this.log(`📊 Found ${this.metrics.issuesFound} global mocking patterns`);
  }

  protected fixIssues(): void {
    this.log("🔧 Starting global-to-module mocking transformation...");
    
    const sourceFiles = this.project.getSourceFiles();
    
    for (const sourceFile of sourceFiles) {
      const patterns = this.findSpyOnPatterns(sourceFile);
      
      if (patterns.length > 0) {
        this.log(`📁 ${sourceFile.getBaseName()}: Found ${patterns.length} patterns`);
        
        // Add mock import if needed
        this.ensureMockImport(sourceFile);
        
        // Transform each pattern
        for (const pattern of patterns) {
          this.transformPattern(sourceFile, pattern);
        }
        
        this.recordFix(sourceFile.getFilePath());
      }
    }

    this.log(`🎉 Applied transformations to ${this.metrics.issuesFixed} files`);
  }

  private findSpyOnPatterns(sourceFile: SourceFile): SpyOnPattern[] {
    const patterns: SpyOnPattern[] = [];
    const spyOnMap = new Map<string, SpyOnPattern>();

    // Find variable declarations with spyOn
    const variableDeclarations = sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration);
    
    for (const varDecl of variableDeclarations) {
      const initializer = varDecl.getInitializer();
      if (!initializer) continue;

      const spyOnInfo = this.extractSpyOnInfo(initializer);
      if (spyOnInfo) {
        const variable = varDecl.getName();
        const pattern: SpyOnPattern = {
          variable,
          module: spyOnInfo.module,
          method: spyOnInfo.method,
          mockImplementations: [],
          variableDeclaration: varDecl,
          spyOnCalls: [spyOnInfo.callExpression],
        };
        
        spyOnMap.set(variable, pattern);
        patterns.push(pattern);
      }
    }

    // Find mockImplementation calls for each spyOn variable
    const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
    
    for (const callExpr of callExpressions) {
      const expression = callExpr.getExpression();
      
      if (expression.getKind() === SyntaxKind.PropertyAccessExpression) {
        const propAccess = expression.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
        const object = propAccess.getExpression().getText();
        const property = propAccess.getName();
        
        if (property === "mockImplementation" && spyOnMap.has(object)) {
          spyOnMap.get(object)!.mockImplementations.push(callExpr);
        }
      }
    }

    return patterns;
  }

  private extractSpyOnInfo(node: any): { module: string; method: string; callExpression: CallExpression } | null {
    if (node.getKind() !== SyntaxKind.CallExpression) return null;
    
    const callExpr = node as CallExpression;
    const expression = callExpr.getExpression();
    
    if (expression.getText() === "spyOn") {
      const args = callExpr.getArguments();
      if (args.length >= 2) {
        const module = args[0].getText();
        const method = args[1].getText().replace(/["']/g, "");
        return { module, method, callExpression: callExpr };
      }
    }
    
    return null;
  }

  private ensureMockImport(sourceFile: SourceFile): void {
    const bunTestImport = sourceFile
      .getImportDeclarations()
      .find(imp => imp.getModuleSpecifierValue() === "bun:test");
    
    if (bunTestImport) {
      const mockImport = bunTestImport.getNamedImports()
        .find(imp => imp.getName() === "mock");
      
      if (!mockImport) {
        bunTestImport.addNamedImport("mock");
      }
    }
  }

  private transformPattern(sourceFile: SourceFile, pattern: SpyOnPattern): void {
    // Generate mock.module call
    const mockImplementation = this.extractMockImplementation(pattern);
    const mockModuleCall = `mock.module("${pattern.module}", () => ({
  ${pattern.method}: mock(${mockImplementation})
}));`;

    // Add mock.module call at top of describe block
    this.addMockModuleCall(sourceFile, mockModuleCall);
    
    // Remove variable declaration statement
    const varStatement = pattern.variableDeclaration.getVariableStatement();
    if (varStatement) {
      varStatement.remove();
    }
    
    // Remove mockImplementation calls
    pattern.mockImplementations.forEach(call => {
      const statement = call.getFirstAncestorByKind(SyntaxKind.ExpressionStatement);
      if (statement) {
        statement.remove();
      }
    });
    
    // TODO: Remove beforeEach/afterEach cleanup logic
    // TODO: Handle multiple spyOn calls for same variable
    
    this.log(`✅ Transformed ${pattern.variable} from global to module mocking`);
  }

  private extractMockImplementation(pattern: SpyOnPattern): string {
    if (pattern.mockImplementations.length > 0) {
      const firstMock = pattern.mockImplementations[0];
      const args = firstMock.getArguments();
      if (args.length > 0) {
        return args[0].getText();
      }
    }
    return "() => {}";
  }

  private addMockModuleCall(sourceFile: SourceFile, mockCall: string): void {
    // Find the first describe block and add mock.module before it
    const describes = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter(call => call.getExpression().getText() === "describe");
    
    if (describes.length > 0) {
      const firstDescribe = describes[0];
      const statement = firstDescribe.getFirstAncestorByKind(SyntaxKind.ExpressionStatement);
      if (statement) {
        // Insert mock.module call before the describe statement using insertText
        const insertPosition = statement.getStart();
        sourceFile.insertText(insertPosition, `${mockCall}\n\n`);
      }
    }
  }
}

// Export for CLI usage
export default GlobalToModuleMockingMigrator; 
