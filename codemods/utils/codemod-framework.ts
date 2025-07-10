#!/usr/bin/env bun

/**
 * CODEMOD FRAMEWORK
 * 
 * Provides reusable utilities for creating targeted, modular codemods.
 * This framework handles the common scaffolding so individual codemods can focus on their specific transformations.
 */

import { Project, SourceFile, SyntaxKind, Node } from "ts-morph";
import { readFileSync, writeFileSync } from "fs";
import { globSync } from "glob";

export interface CodemodResult {
  file: string;
  fixType: string;
  fixesApplied: number;
  description: string;
  originalCode?: string;
  fixedCode?: string;
}



export interface ASTTransform {
  name: string;
  description: string;
  nodeType: SyntaxKind;
  matcher: (node: Node) => boolean;
  transformer: (node: Node) => { applied: boolean; description: string };
  category?: string;
}

export class CodemodFramework {
  protected project: Project;
  protected results: CodemodResult[] = [];
  protected skipSyntaxCheck: boolean = false;

  constructor(options: {
    skipLibCheck?: boolean;
    strict?: boolean;
    skipSyntaxCheck?: boolean;
  } = {}) {
    this.project = new Project({
      compilerOptions: {
        target: 99, // Latest
        module: 99, // ESNext
        moduleResolution: 2, // Node
        allowSyntheticDefaultImports: true,
        esModuleInterop: true,
        strict: options.strict ?? false,
        skipLibCheck: options.skipLibCheck ?? true,
        forceConsistentCasingInFileNames: false,
        lib: ["ES2022", "DOM"]
      }
    });
    
    this.skipSyntaxCheck = options.skipSyntaxCheck || false;
  }



  /**
   * Apply AST-based transformations to a source file
   */
  protected applyASTTransforms(sourceFile: SourceFile, transforms: ASTTransform[]): number {
    let fixes = 0;
    
    for (const transform of transforms) {
      const nodes = sourceFile.getDescendantsOfKind(transform.nodeType);
      
      // Collect transformations first to avoid node invalidation
      const transformations: { node: Node; originalText: string }[] = [];
      
      for (const node of nodes) {
        if (transform.matcher(node)) {
          transformations.push({ node, originalText: node.getText() });
        }
      }
      
      // Apply transformations
      for (const { node, originalText } of transformations) {
        try {
          const result = transform.transformer(node);
          if (result.applied) {
            fixes++;
            
            this.results.push({
              file: sourceFile.getFilePath(),
              fixType: transform.name,
              fixesApplied: 1,
              description: result.description,
              originalCode: originalText.substring(0, 50) + '...',
              fixedCode: 'ast-transformed'
            });
          }
        } catch (error) {
          // Skip nodes that have become invalid
          console.log(`Warning: Skipping invalid node in ${transform.name}: ${error}`);
        }
      }
    }
    
    return fixes;
  }

  /**
   * Check if a file has syntax errors and should be skipped
   */
  protected hasSyntaxErrors(sourceFile: SourceFile): boolean {
    try {
      const diagnostics = sourceFile.getPreEmitDiagnostics();
      // Only treat actual syntax errors as blocking, not semantic errors
      const syntaxErrors = diagnostics.filter(d => {
        const code = d.getCode();
        // Skip library path resolution errors and undefined name errors
        return d.getCategory() === 1 && 
               code !== 6231 && // Could not resolve path
               code !== 2304 && // Cannot find name
               code !== 2552 && // Cannot find name (with suggestion)
               code !== 1422 && // Library specified in compilerOptions
               code !== 1430 && // File is in program because
               code !== 1005;   // 'try' expected (for catch-only test code)
      });
      return syntaxErrors.length > 0;
    } catch (error) {
      return true; // If we can't parse, treat as syntax error
    }
  }

  /**
   * Process a single file with AST transforms only
   */
  protected processFile(
    filePath: string, 
    transforms: ASTTransform[] = []
  ): number {
    try {
      const content = readFileSync(filePath, "utf-8");
      const sourceFile = this.project.createSourceFile(filePath, content, { overwrite: true });
      
      // Skip files with syntax errors (unless skipSyntaxCheck is enabled)
      if (!this.skipSyntaxCheck && this.hasSyntaxErrors(sourceFile)) {
        console.log(`⚠️  Skipping ${filePath} due to syntax errors`);
        return 0;
      }
      
      let totalFixes = 0;
      
      // Apply AST transforms only
      if (transforms.length > 0) {
        totalFixes += this.applyASTTransforms(sourceFile, transforms);
      }
      
      // Save changes
      if (totalFixes > 0) {
        writeFileSync(filePath, sourceFile.getFullText());
      }
      
      return totalFixes;
    } catch (error) {
      console.log(`Error processing ${filePath}: ${error}`);
      return 0;
    }
  }

  /**
   * Process a single file directly (for test compatibility)
   */
  public async processSingleFile(
    filePath: string, 
    transforms: ASTTransform[] = []
  ): Promise<number> {
    return this.processFile(filePath, transforms);
  }

  /**
   * Process multiple files matching a pattern
   */
  public async processFiles(
    pattern: string = "src/**/*.ts",
    transforms: ASTTransform[] = [],
    options: {
      name?: string;
      description?: string;
    } = {}
  ): Promise<void> {
    const files = globSync(pattern, { ignore: ['**/*.d.ts', '**/node_modules/**'] });
    
    const name = options.name || 'Codemod';
    const description = options.description || 'Applying AST transforms';
    
    console.log(`🎯 ${name} - Processing ${files.length} files...`);
    console.log(`🔧 ${description}\n`);
    
    let totalFixes = 0;
    let processedFiles = 0;
    
    for (const filePath of files) {
      const fixes = this.processFile(filePath, transforms);
      if (fixes > 0) {
        console.log(`✅ ${filePath}: ${fixes} fixes applied`);
        processedFiles++;
        totalFixes += fixes;
      }
    }
    
    this.printSummary(totalFixes, processedFiles, files.length, name);
  }

  /**
   * Print a summary of the codemod results
   */
  protected printSummary(totalFixes: number, processedFiles: number, totalFiles: number, name: string): void {
    console.log(`\n🎉 ${name} Results:`);
    console.log(`   Files processed: ${processedFiles}/${totalFiles}`);
    console.log(`   Total fixes applied: ${totalFixes}`);
    console.log(`   Success rate: ${((processedFiles / totalFiles) * 100).toFixed(1)}%`);

    if (this.results.length > 0) {
      console.log(`\n📊 Fix breakdown by type:`);
      const fixTypeSummary: Record<string, number> = {};
      
      for (const result of this.results) {
        fixTypeSummary[result.fixType] = (fixTypeSummary[result.fixType] || 0) + result.fixesApplied;
      }
      
      for (const [fixType, count] of Object.entries(fixTypeSummary)) {
        console.log(`     ${fixType}: ${count} fixes`);
      }
    }
  }

  /**
   * Get the results of the codemod
   */
  public getResults(): CodemodResult[] {
    return this.results;
  }

  /**
   * Clear the results (useful for testing)
   */
  public clearResults(): void {
    this.results = [];
  }
}



/**
 * COMMON AST TRANSFORMS
 * 
 * Pre-defined AST transformations for common patterns
 */

export const CommonTransforms = {
  /**
   * Optional chaining transforms
   */
  optionalChaining: {
    propertyAccess: {
      name: "OPTIONAL_CHAINING",
      description: "Add optional chaining to property access",
      nodeType: SyntaxKind.PropertyAccessExpression,
      matcher: (node: Node) => {
        if (!Node.isPropertyAccessExpression(node)) return false;
        const expression = node.getExpression();
        return Node.isIdentifier(expression) && 
               !node.getText().includes('?') &&
               !node.getName().includes('prototype');
      },
      transformer: (node: Node) => {
        const propAccess = node as any;
        const expression = propAccess.getExpression();
        const propertyName = propAccess.getName();
        
        const newText = `${expression.getText()}?.${propertyName}`;
        propAccess.replaceWithText(newText);
        
        return { 
          applied: true, 
          description: `Added optional chaining: ${expression.getText()}.${propertyName} → ${newText}`
        };
      }
    } as ASTTransform
  },

  /**
   * Type assertion transforms
   */
  typeAssertions: {
    unknownPropertyAccess: {
      name: "UNKNOWN_PROPERTY_ASSERTION",
      description: "Add type assertion for property access on unknown types",
      nodeType: SyntaxKind.PropertyAccessExpression,
      matcher: (node: Node) => {
        if (!Node.isPropertyAccessExpression(node)) return false;
        const expression = node.getExpression();
        return Node.isIdentifier(expression) && 
               ["params", "args", "options", "config", "context"].includes(expression.getText()) &&
               !expression.getText().includes(' as ');
      },
      transformer: (node: Node) => {
        const propAccess = node as any;
        const expression = propAccess.getExpression();
        const varName = expression.getText();
        
        const newText = `(${varName} as any)`;
        expression.replaceWithText(newText);
        
        return { 
          applied: true, 
          description: `Added type assertion: ${varName} → (${varName} as any)`
        };
      }
    } as ASTTransform
  }
};

export default CodemodFramework; 
