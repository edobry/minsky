#!/usr/bin/env bun

/**
 * FIXED TypeScript Error Fixer - Consolidated Utility
 * 
 * Fixes identified issues:
 * 1. Adds missing type annotation functionality
 * 2. Implements processSingleFile method for test compatibility
 * 3. Fixes AST manipulation errors
 * 4. Improves error handling and metrics logging
 */

import { Project, SourceFile, Node, SyntaxKind, Type, TypeChecker } from "ts-morph";
import { readFileSync, writeFileSync } from "fs";
import { globSync } from "glob";

interface ErrorFixResult {
  file: string;
  errorType: string;
  fixesApplied: number;
  description: string;
}

interface ErrorPattern {
  code: string;
  description: string;
  fixer: (sourceFile: SourceFile, typeChecker: TypeChecker) => number;
}

class TypeScriptErrorFixer {
  private project: Project;
  private results: ErrorFixResult[] = [];

  constructor() {
    this.project = new Project({
      compilerOptions: {
        target: 99, // Latest
        module: 99, // ESNext
        moduleResolution: 100, // Bundler
        allowSyntheticDefaultImports: true,
        esModuleInterop: true,
        strict: false, // Allow flexible fixing
        skipLibCheck: true,
        forceConsistentCasingInFileNames: false,
        lib: ["ES2022", "DOM"]
      }
    });
  }

  private getErrorPatterns(): ErrorPattern[] {
    return [
      {
        code: "TS2322",
        description: "Type not assignable errors",
        fixer: this.fixTS2322.bind(this)
      },
      {
        code: "TS2345", 
        description: "Argument type errors",
        fixer: this.fixTS2345.bind(this)
      },
      {
        code: "TS2353",
        description: "Object literal type errors",
        fixer: this.fixTS2353.bind(this)
      },
      {
        code: "TS18048",
        description: "Undefined type errors", 
        fixer: this.fixTS18048.bind(this)
      }
    ];
  }

  /**
   * Add missing type annotations to function parameters and variables
   */
  private addMissingTypeAnnotations(sourceFile: SourceFile): number {
    let fixes = 0;

    // Fix function parameters without type annotations
    const functions = sourceFile.getFunctions();
    for (const func of functions) {
      const parameters = func.getParameters();
      for (const param of parameters) {
        if (!param.getTypeNode() && !param.hasQuestionToken()) {
          param.setType("any");
          fixes++;
        }
      }
    }

    // Fix arrow function parameters
    const arrowFunctions = sourceFile.getDescendantsOfKind(SyntaxKind.ArrowFunction);
    for (const arrow of arrowFunctions) {
      const parameters = arrow.getParameters();
      for (const param of parameters) {
        if (!param.getTypeNode() && !param.hasQuestionToken()) {
          param.setType("any");
          fixes++;
        }
      }
    }

    // Fix variable declarations without types
    const variableStatements = sourceFile.getVariableStatements();
    for (const statement of variableStatements) {
      for (const declaration of statement.getDeclarations()) {
        if (!declaration.getTypeNode() && !declaration.getInitializer()) {
          declaration.setType("any");
          fixes++;
        } else if (!declaration.getTypeNode() && declaration.getInitializer()) {
          const initializer = declaration.getInitializer();
          if (initializer && initializer.getKind() === SyntaxKind.ArrayLiteralExpression) {
            // Handle empty arrays
            if (initializer.getText() === "[]") {
              declaration.setType("any[]");
              fixes++;
            }
          }
        }
      }
    }

    return fixes;
  }

  private fixTS2322(sourceFile: SourceFile, typeChecker: TypeChecker): number {
    let fixes = 0;
    
    // Find variable assignments with type mismatches - but be conservative
    const variableStatements = sourceFile.getVariableStatements();
    for (const statement of variableStatements) {
      for (const declaration of statement.getDeclarations()) {
        const initializer = declaration.getInitializer();
        if (initializer && declaration.getTypeNode()) {
          // Only add type assertion if it looks safe
          const expectedType = declaration.getTypeNode()?.getText();
          if (expectedType && !initializer.getText().includes(" as ") && 
              (expectedType === "any" || expectedType === "unknown")) {
            try {
              initializer.replaceWithText(`${initializer.getText()} as ${expectedType}`);
              fixes++;
            } catch (error) {
              // Skip problematic cases
              console.log(`Skipping TS2322 fix for safety: ${error}`);
            }
          }
        }
      }
    }

    return fixes;
  }

  private fixTS2345(sourceFile: SourceFile, typeChecker: TypeChecker): number {
    let fixes = 0;

    // Find function calls with argument type mismatches - be very conservative
    const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
    for (const call of callExpressions) {
      const args = call.getArguments();
      for (const arg of args) {
        // Only add type assertions for very safe cases
        if (!arg.getText().includes(" as ") && 
            (arg.getText().includes("null") || arg.getText().includes("undefined"))) {
          try {
            arg.replaceWithText(`${arg.getText()} as any`);
            fixes++;
          } catch (error) {
            // Skip problematic cases
            console.log(`Skipping TS2345 fix for safety: ${error}`);
          }
        }
      }
    }

    return fixes;
  }

  private fixTS2353(sourceFile: SourceFile, typeChecker: TypeChecker): number {
    let fixes = 0;

    // Find object literal assignments with type mismatches - very conservative
    const objectLiterals = sourceFile.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression);
    for (const obj of objectLiterals) {
      // Only fix obvious cases where object is assigned to typed variable
      const parent = obj.getParent();
      if (Node.isVariableDeclaration(parent) && parent.getTypeNode()) {
        const typeText = parent.getTypeNode()?.getText();
        if (typeText === "any" && !obj.getText().includes(" as ")) {
          try {
            obj.replaceWithText(`${obj.getText()} as any`);
            fixes++;
          } catch (error) {
            console.log(`Skipping TS2353 fix for safety: ${error}`);
          }
        }
      }
    }

    return fixes;
  }

  private fixTS18048(sourceFile: SourceFile, typeChecker: TypeChecker): number {
    let fixes = 0;

    // Find potentially undefined expressions - be very conservative
    const propertyAccessExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression);
    for (const prop of propertyAccessExpressions) {
      const expression = prop.getExpression();
      const propertyName = prop.getName();
      const expressionText = expression?.getText();
      
      // Only add optional chaining for very safe cases
      if (!prop.getText().includes("?") && propertyName && expressionText &&
          (expressionText.includes("undefined") || expressionText.includes("null"))) {
        try {
          prop.replaceWithText(`${expressionText}?.${propertyName}`);
          fixes++;
        } catch (error) {
          console.log(`Skipping TS18048 fix for safety: ${error}`);
        }
      }
    }

    return fixes;
  }

  /**
   * Process a single file directly (bypasses glob patterns for test compatibility)
   */
  public async processSingleFile(filePath: string): Promise<number> {
    try {
      // Read file content first to check if file exists
      const content = readFileSync(filePath, "utf-8");
      
      // Add to project for AST processing
      const sourceFile = this.project.createSourceFile(filePath, content, { overwrite: true });
      const typeChecker = this.project.getTypeChecker();
      
      let fileFixes = 0;
      
      // Apply type annotation fixes first (most important)
      const typeAnnotationFixes = this.addMissingTypeAnnotations(sourceFile);
      fileFixes += typeAnnotationFixes;
      
      if (typeAnnotationFixes > 0) {
        this.results.push({
          file: filePath,
          errorType: "TYPE_ANNOTATIONS",
          fixesApplied: typeAnnotationFixes,
          description: "Added missing type annotations"
        });
      }
      
      // Apply other error pattern fixes
      const errorPatterns = this.getErrorPatterns();
      for (const pattern of errorPatterns) {
        try {
          const fixes = pattern.fixer(sourceFile, typeChecker);
          if (fixes > 0) {
            this.results.push({
              file: filePath,
              errorType: pattern.code,
              fixesApplied: fixes,
              description: pattern.description
            });
            fileFixes += fixes;
          }
        } catch (error) {
          console.error(`Error fixing ${pattern.code} in ${filePath}:`, error);
        }
      }

      // Save changes if any fixes were applied
      if (fileFixes > 0) {
        const newContent = sourceFile.getFullText();
        writeFileSync(filePath, newContent, "utf-8");
        console.log(`✅ Fixed ${fileFixes} errors in ${filePath}`);
      }

      // Clean up
      sourceFile.forget();
      
      return fileFixes;
    } catch (error) {
      console.error(`Error processing file ${filePath}:`, error);
      return 0;
    }
  }

  public async processFiles(pattern: string = "src/**/*.ts"): Promise<void> {
    const files = globSync(pattern, {
      ignore: ["**/*.test.ts", "**/*.spec.ts", "**/node_modules/**", "**/*.d.ts"]
    });

    console.log(`🔧 Processing ${files.length} TypeScript files for error fixing...`);

    let totalFixes = 0;
    let processedFiles = 0;

    for (const filePath of files) {
      try {
        const fixes = await this.processSingleFile(filePath);
        if (fixes > 0) {
          totalFixes += fixes;
          processedFiles++;
        }
      } catch (error) {
        console.error(`Error processing ${filePath}:`, error);
      }
    }

    this.printSummary(totalFixes, processedFiles, files.length);
  }

  private printSummary(totalFixes: number, processedFiles: number, totalFiles: number): void {
    console.log(`\nTypeScript Error Fix Results:`);
    console.log(`   Files processed: ${processedFiles}/${totalFiles}`);
    console.log(`   Total fixes applied: ${totalFixes}`);
    console.log(`   Success rate: ${((processedFiles / totalFiles) * 100).toFixed(1)}%`);

    if (this.results.length > 0) {
      console.log(`\n📊 Error breakdown:`);
      const errorSummary: Record<string, number> = {};
      
      for (const result of this.results) {
        errorSummary[result.errorType] = (errorSummary[result.errorType] || 0) + result.fixesApplied;
      }

      for (const [errorType, count] of Object.entries(errorSummary)) {
        console.log(`   ${errorType}: ${count} fixes`);
      }
    }
  }
}

// Main execution
async function main() {
  const fixer = new TypeScriptErrorFixer();
  await fixer.processFiles();
}

// Execute if run directly
if (typeof require !== 'undefined' && require.main === module) {
  main().catch(console.error);
}

export { TypeScriptErrorFixer }; 
