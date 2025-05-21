import { Node, SourceFile, SyntaxKind } from "ts-morph";
import { Transformer } from "./pipeline";

/**
 * Base class for import transformers
 */
abstract class ImportTransformer implements Transformer {
  abstract patternId: string;
  priority = 100; // High priority to handle imports first
  safetyLevel: 'low' | 'medium' | 'high' = 'high'; // Safe for all safety levels
  
  /**
   * Transform an import statement
   * 
   * @param text Original import statement
   * @param node AST node for the import
   * @param sourceFile Source file containing the import
   * @returns Transformed import statement
   */
  async transform(text: string, node: Node, sourceFile: SourceFile): Promise<string> {
    if (Node.isImportDeclaration(node)) {
      return this.transformImport(node, sourceFile);
    }
    return text;
  }
  
  /**
   * Transform an import declaration
   * 
   * @param importDecl Import declaration to transform
   * @param sourceFile Source file containing the import
   * @returns Transformed import text
   */
  protected abstract transformImport(importDecl: Node, sourceFile: SourceFile): string;
}

/**
 * Transformer for Jest import statements
 */
export class JestImportTransformer extends ImportTransformer {
  patternId = 'jest-import';
  
  /**
   * Transform a Jest import declaration
   * 
   * @param importDecl Import declaration to transform
   * @param sourceFile Source file containing the import
   * @returns Transformed import text
   */
  protected transformImport(importDecl: Node, sourceFile: SourceFile): string {
    if (Node.isImportDeclaration(importDecl)) {
      const moduleSpecifier = importDecl.getModuleSpecifierValue();
      
      if (moduleSpecifier === '@jest/globals') {
        const namedImports = importDecl.getNamedImports();
        const importSpecifiers = namedImports.map(spec => spec.getName());
        
        // Check if we need to add a compatibility layer import
        const needsCompat = importSpecifiers.includes('jest');
        
        if (needsCompat) {
          // Add import for compatibility layer
          return "import { createCompatMock } from '../utils/test-utils/compatibility/mock-function';";
        } else {
          // Remove import entirely, as Bun globals are available without import
          return '// Removed Jest import - Bun globals are available without import';
        }
      }
    }
    
    // If we can't transform it, return the original text
    return importDecl.getText();
  }
}

/**
 * Transformer for Vitest import statements
 */
export class VitestImportTransformer extends ImportTransformer {
  patternId = 'vitest-import';
  
  /**
   * Transform a Vitest import declaration
   * 
   * @param importDecl Import declaration to transform
   * @param sourceFile Source file containing the import
   * @returns Transformed import text
   */
  protected transformImport(importDecl: Node, sourceFile: SourceFile): string {
    if (Node.isImportDeclaration(importDecl)) {
      const moduleSpecifier = importDecl.getModuleSpecifierValue();
      
      if (moduleSpecifier === 'vitest') {
        const namedImports = importDecl.getNamedImports();
        const importSpecifiers = namedImports.map(spec => spec.getName());
        
        // Check if we need to add a compatibility layer import
        const needsCompat = importSpecifiers.includes('vi');
        
        if (needsCompat) {
          // Add import for compatibility layer
          return "import { createCompatMock } from '../utils/test-utils/compatibility/mock-function';";
        } else {
          // Remove import entirely, as Bun globals are available without import
          return '// Removed Vitest import - Bun globals are available without import';
        }
      }
    }
    
    // If we can't transform it, return the original text
    return importDecl.getText();
  }
} 
