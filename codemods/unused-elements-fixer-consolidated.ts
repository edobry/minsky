#!/usr/bin/env bun

/**
 * FIXED Unused Elements Fixer - Consolidated Utility
 * 
 * Fixes identified issues:
 * 1. Actually removes unused elements instead of just prefixing them
 * 2. Implements processSingleFile method for test compatibility
 * 3. Fixes file processing and AST manipulation issues
 * 4. Improves error handling and logging
 */

import { Project, SourceFile, Node, SyntaxKind, TypeChecker, VariableDeclaration, ParameterDeclaration, ImportDeclaration } from "ts-morph";
import { readFileSync, writeFileSync } from "fs";
import { globSync } from "glob";

interface UnusedElementResult {
  file: string;
  elementType: string;
  elementsFixed: number;
  description: string;
}

interface UnusedElementPattern {
  type: string;
  description: string;
  fixer: (sourceFile: SourceFile, typeChecker: TypeChecker) => number;
}

class UnusedElementsFixer {
  private project: Project;
  private results: UnusedElementResult[] = [];

  constructor() {
    this.project = new Project({
      compilerOptions: {
        target: 99, // Latest
        module: 99, // ESNext
        moduleResolution: 2, // Node
        allowSyntheticDefaultImports: true,
        esModuleInterop: true,
        strict: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true
      }
    });
  }

  private getElementPatterns(): UnusedElementPattern[] {
    return [
      {
        type: "unused-variables",
        description: "Unused local variables",
        fixer: this.fixUnusedVariables.bind(this)
      },
      {
        type: "unused-parameters",
        description: "Unused function parameters",
        fixer: this.fixUnusedParameters.bind(this)
      },
              {
          type: "unused-imports",
          description: "Unused import statements",
          fixer: this.fixUnusedImports.bind(this)
        },
        {
          type: "unused-class-members",
          description: "Unused class properties and methods",
          fixer: this.fixUnusedClassMembers.bind(this)
        }
      ];
    }

  private fixUnusedVariables(sourceFile: SourceFile, typeChecker: TypeChecker): number {
    let fixes = 0;
    
    // Find all variable declarations
    const variableDeclarations = sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration);
    
    for (const declaration of variableDeclarations) {
      const name = declaration.getName();
      if (!name || name.startsWith('_')) continue; // Skip already prefixed or anonymous
      
      // Don't remove exported variables
      if (this.isVariableExported(declaration, sourceFile)) continue;
      
      // Handle destructuring assignments
      if (declaration.getNameNode()?.getKind() === SyntaxKind.ObjectBindingPattern) {
        fixes += this.fixUnusedDestructuring(declaration, sourceFile);
        continue;
      }
      
      // Don't remove variables that are assigned function expressions or arrow functions
      const initializer = declaration.getInitializer();
      if (initializer && (
        initializer.getKind() === SyntaxKind.FunctionExpression ||
        initializer.getKind() === SyntaxKind.ArrowFunction
      )) {
        continue; // Skip function expressions, let parameter fixing handle them
      }
      
      // Check if variable is used
      const isUsed = this.isVariableUsed(declaration, sourceFile);
      
      if (!isUsed) {
        try {
          // Remove the entire variable declaration
          const variableStatement = declaration.getVariableStatement();
          if (variableStatement) {
            const declarations = variableStatement.getDeclarations();
            if (declarations.length === 1) {
              // Remove entire statement if only one declaration
              variableStatement.remove();
            } else {
              // Remove just this declaration if multiple
              declaration.remove();
            }
            fixes++;
          }
        } catch (error) {
          console.log(`Skipping variable removal for safety: ${error}`);
        }
      }
    }

    return fixes;
  }

  private fixUnusedParameters(sourceFile: SourceFile, typeChecker: TypeChecker): number {
    let fixes = 0;
    
    // Find all function declarations and expressions
    const functions = [
      ...sourceFile.getFunctions(),
      ...sourceFile.getDescendantsOfKind(SyntaxKind.FunctionExpression),
      ...sourceFile.getDescendantsOfKind(SyntaxKind.ArrowFunction),
      ...sourceFile.getDescendantsOfKind(SyntaxKind.MethodDeclaration)
    ];

    for (const func of functions) {
      const parameters = func.getParameters();
      
      // Process parameters in reverse order to avoid index issues
      for (let i = parameters.length - 1; i >= 0; i--) {
        const param = parameters[i];
        const name = param.getName();
        if (!name || name.startsWith('_')) continue; // Skip already prefixed or anonymous
        
        // Check if parameter is used in function body
        const isUsed = this.isParameterUsed(param, func);
        
        if (!isUsed) {
          try {
            // Remove the parameter
            param.remove();
            fixes++;
          } catch (error) {
            console.log(`Skipping parameter removal for safety: ${error}`);
          }
        }
      }
    }

    return fixes;
  }

  private fixUnusedImports(sourceFile: SourceFile, typeChecker: TypeChecker): number {
    let fixes = 0;
    
    // Find all import declarations
    const importDeclarations = sourceFile.getImportDeclarations();
    
    for (const importDecl of importDeclarations) {
      const namedImports = importDecl.getNamedImports();
      const unusedImports: string[] = [];
      
      for (const namedImport of namedImports) {
        const name = namedImport.getName();
        if (!this.isImportUsed(name, sourceFile)) {
          unusedImports.push(name);
        }
      }
      
      if (unusedImports.length > 0) {
        try {
          if (unusedImports.length === namedImports.length) {
            // Remove entire import statement if all imports are unused
            importDecl.remove();
            fixes += unusedImports.length;
          } else {
            // Remove only unused imports
            for (const importName of unusedImports) {
              const importToRemove = namedImports.find(imp => imp.getName() === importName);
              if (importToRemove) {
                importToRemove.remove();
                fixes++;
              }
            }
          }
        } catch (error) {
          console.log(`Skipping import removal for safety: ${error}`);
        }
      }
    }

    return fixes;
  }

  private isVariableUsed(declaration: VariableDeclaration, sourceFile: SourceFile): boolean {
    const name = declaration.getName();
    if (!name) return true; // Conservative: assume used if no name
    
    // Get all identifiers in the file
    const identifiers = sourceFile.getDescendantsOfKind(SyntaxKind.Identifier);
    
    // Check if any identifier (other than the declaration itself) uses this name
    for (const identifier of identifiers) {
      if (identifier.getText() === name && identifier !== declaration.getNameNode()) {
        return true;
      }
    }
    
    return false;
  }

  private isParameterUsed(param: ParameterDeclaration, func: Node): boolean {
    const name = param.getName();
    if (!name) return true; // Conservative: assume used if no name
    
    // Get all identifiers in the function body
    const identifiers = func.getDescendantsOfKind(SyntaxKind.Identifier);
    
    // Check if any identifier (other than the parameter declaration) uses this name
    for (const identifier of identifiers) {
      if (identifier.getText() === name && identifier !== param.getNameNode()) {
        return true;
      }
    }
    
    return false;
  }

  private isImportUsed(importName: string, sourceFile: SourceFile): boolean {
    // Get all identifiers in the file
    const identifiers = sourceFile.getDescendantsOfKind(SyntaxKind.Identifier);
    
    // Check if any identifier uses this import name
    for (const identifier of identifiers) {
      if (identifier.getText() === importName) {
        // Make sure it's not the import declaration itself
        const parent = identifier.getParent();
        if (!Node.isImportSpecifier(parent) && !Node.isImportClause(parent)) {
          return true;
        }
      }
    }
    
    return false;
  }

  private fixUnusedDestructuring(declaration: VariableDeclaration, sourceFile: SourceFile): number {
    let fixes = 0;
    
    try {
      const nameNode = declaration.getNameNode();
      if (nameNode?.getKind() === SyntaxKind.ObjectBindingPattern) {
        const bindingPattern = nameNode as any;
        const elements = bindingPattern.getElements();
        
        // Collect used and unused elements
        const usedElements: string[] = [];
        const unusedElements: string[] = [];
        
        for (const element of elements) {
          const name = element.getName();
          
          if (name && !name.startsWith('_')) {
            // Check if this destructured property is used
            const isUsed = this.isIdentifierUsed(name, sourceFile);
            
            if (isUsed) {
              usedElements.push(name);
            } else {
              unusedElements.push(name);
            }
          } else if (name) {
            // Keep elements that start with underscore (intentionally unused)
            usedElements.push(name);
          }
        }
        
        // If we have unused elements, rebuild the destructuring
        if (unusedElements.length > 0 && usedElements.length > 0) {
          try {
            // Rebuild the destructuring with only used elements
            const newPattern = `{ ${usedElements.join(', ')} }`;
            bindingPattern.replaceWithText(newPattern);
            fixes += unusedElements.length;
          } catch (replaceError) {
            console.log(`Skipping destructuring replacement for safety: ${replaceError}`);
          }
        }
      }
    } catch (error) {
      console.log(`Skipping destructuring fix for safety: ${error}`);
    }
    
    return fixes;
  }

  private isIdentifierUsed(identifierName: string, sourceFile: SourceFile): boolean {
    // Get all identifiers in the file
    const identifiers = sourceFile.getDescendantsOfKind(SyntaxKind.Identifier);
    
    // Check if any identifier uses this name (excluding the declaration itself)
    for (const identifier of identifiers) {
      if (identifier.getText() === identifierName) {
        // Make sure it's not the declaration itself
        const parent = identifier.getParent();
        if (!Node.isVariableDeclaration(parent) && !Node.isBindingElement(parent)) {
          return true;
        }
      }
    }
    
    return false;
  }

  private fixUnusedClassMembers(sourceFile: SourceFile, typeChecker: TypeChecker): number {
    let fixes = 0;
    
    // Find all classes
    const classes = sourceFile.getClasses();
    
    for (const cls of classes) {
      // Handle unused properties
      const properties = cls.getProperties();
      for (const property of properties) {
        const name = property.getName();
        if (!name || name.startsWith('_')) continue;
        
        if (!this.isClassMemberUsed(property, cls)) {
          try {
            property.remove();
            fixes++;
          } catch (error) {
            console.log(`Skipping class property removal for safety: ${error}`);
          }
        }
      }
      
      // Handle unused methods - be conservative about public methods
      const methods = cls.getMethods();
      for (const method of methods) {
        const name = method.getName();
        if (!name || name.startsWith('_')) continue;
        
        // Don't remove constructor
        if (name === 'constructor') continue;
        
        // For public methods, be more conservative - only remove if clearly unused
        const isPublic = method.hasModifier(SyntaxKind.PublicKeyword) || 
                        !method.hasModifier(SyntaxKind.PrivateKeyword) && 
                        !method.hasModifier(SyntaxKind.ProtectedKeyword);
        
        if (isPublic) {
          // For public methods, check if they're used anywhere in the file
          // or if they might be part of the class API
          const isUsedExternally = this.isClassMemberUsed(method, cls);
          if (!isUsedExternally) {
            // Even if not used, keep public methods as they might be part of the API
            continue;
          }
        } else {
          // For private/protected methods, remove if not used
          if (!this.isClassMemberUsed(method, cls)) {
            try {
              method.remove();
              fixes++;
            } catch (error) {
              console.log(`Skipping class method removal for safety: ${error}`);
            }
          }
        }
      }
    }
    
    return fixes;
  }

  private isVariableExported(declaration: VariableDeclaration, sourceFile: SourceFile): boolean {
    // Check if this variable is part of an export statement
    const variableStatement = declaration.getVariableStatement();
    if (!variableStatement) return false;
    
    // Check if the variable statement has export modifier
    return variableStatement.hasExportKeyword();
  }

  private isClassMemberUsed(member: any, cls: any): boolean {
    const name = member.getName();
    if (!name) return true;
    
    // Get all identifiers in the entire source file, not just the class
    const sourceFile = cls.getSourceFile();
    const identifiers = sourceFile.getDescendantsOfKind(SyntaxKind.Identifier);
    
    // Check if the member is used elsewhere in the file
    for (const identifier of identifiers) {
      if (identifier.getText() === name) {
        // Make sure it's not the member declaration itself
        if (identifier.getParent() !== member && identifier !== member.getNameNode()) {
          return true;
        }
      }
    }
    
    return false;
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
      
      // Check for syntax errors - only skip if there are actual syntax errors
      const diagnostics = sourceFile.getPreEmitDiagnostics();
      const syntaxErrors = diagnostics.filter(diagnostic => 
        diagnostic.getCategory() === 1 // Error category
        && diagnostic.getCode() >= 1000 && diagnostic.getCode() < 2000 // Syntax error codes
      );
      
      if (syntaxErrors.length > 0) {
        console.log(`Skipping ${filePath} due to syntax errors`);
        sourceFile.forget();
        return 0;
      }
      
      const typeChecker = this.project.getTypeChecker();
      
      let fileFixes = 0;
      
      // Apply unused element fixes
      const elementPatterns = this.getElementPatterns();
      for (const pattern of elementPatterns) {
        try {
          const fixes = pattern.fixer(sourceFile, typeChecker);
          if (fixes > 0) {
            this.results.push({
              file: filePath,
              elementType: pattern.type,
              elementsFixed: fixes,
              description: pattern.description
            });
            fileFixes += fixes;
          }
        } catch (error) {
          console.error(`Error fixing ${pattern.type} in ${filePath}:`, error);
        }
      }

      // Save changes if any fixes were applied
      if (fileFixes > 0) {
        const newContent = sourceFile.getFullText();
        writeFileSync(filePath, newContent, "utf-8");
        console.log(`✅ Fixed ${fileFixes} unused elements in ${filePath}`);
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

    console.log(`🧹 Processing ${files.length} TypeScript files for unused element cleanup...`);

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
    console.log(`\nUnused Elements Fix Results:`);
    console.log(`   Files processed: ${processedFiles}/${totalFiles}`);
    console.log(`   Total fixes applied: ${totalFixes}`);
    console.log(`   Total unused elements removed: ${totalFixes}`);
    console.log(`   Success rate: ${((processedFiles / totalFiles) * 100).toFixed(1)}%`);

    if (this.results.length > 0) {
      console.log(`\n📊 Element type breakdown:`);
      const elementSummary: Record<string, number> = {};
      
      for (const result of this.results) {
        elementSummary[result.elementType] = (elementSummary[result.elementType] || 0) + result.elementsFixed;
      }

      for (const [elementType, count] of Object.entries(elementSummary)) {
        console.log(`   ${elementType}: ${count} fixes`);
      }
    }
  }
}

// Main execution
async function main() {
  const fixer = new UnusedElementsFixer();
  await fixer.processFiles();
}

// Execute if run directly
if (typeof require !== 'undefined' && require.main === module) {
  main().catch(console.error);
}

export { UnusedElementsFixer }; 
