#!/usr/bin/env bun

/**
 * Comprehensive AST Codemod for Task #280 - New Pattern Discovery
 * 
 * Enhanced with patterns discovered from linting errors:
 * - Indentation fixes from previous AST transforms
 * - Config object patterns: (config as unknown)
 * - Session/service object patterns
 * - Error handling patterns
 * - Promise return patterns
 * - Mock function patterns
 */

import { Project, SyntaxKind, AsExpression, Node, SourceFile } from "ts-morph";
import { writeFileSync } from "fs";

interface TransformationResult {
  file: string;
  line: number;
  before: string;
  after: string;
  pattern: string;
}

class ComprehensiveAsUnknownFixer {
  private project: Project;
  private transformations: TransformationResult[] = [];

  constructor() {
    this.project = new Project({
      tsConfigFilePath: "./tsconfig.json",
    });
  }

  public async fixAllPatterns(): Promise<void> {
    console.log("🔧 Starting comprehensive 'as unknown' pattern fixes...");
    
    // Load all source files
    const sourceFiles = this.project.getSourceFiles();
    
    for (const sourceFile of sourceFiles) {
      if (this.shouldSkipFile(sourceFile.getFilePath())) continue;
      
      // Apply all our transformation patterns
      this.fixConfigObjectPatterns(sourceFile);
      this.fixSessionServicePatterns(sourceFile);
      this.fixPromiseReturnPatterns(sourceFile);
      this.fixErrorHandlingPatterns(sourceFile);
      this.fixMockFunctionPatterns(sourceFile);
      this.fixSimplePropertyAccess(sourceFile);
      this.fixParameterPatterns(sourceFile);
      
      // Fix indentation issues from previous transforms
      this.fixIndentationIssues(sourceFile);
    }

    // Save all changes
    await this.project.save();
    
    this.generateReport();
  }

  private shouldSkipFile(filePath: string): boolean {
    return filePath.includes("node_modules") || 
           filePath.includes(".test.") || 
           filePath.includes(".spec.") ||
           filePath.includes("__tests__") ||
           filePath.endsWith(".d.ts");
  }

  private fixConfigObjectPatterns(sourceFile: SourceFile): void {
    // Pattern: (config as unknown) - very common in our codebase
    sourceFile.forEachDescendant((node) => {
      if (Node.isAsExpression(node)) {
        const expression = node.getExpression();
        const typeNode = node.getTypeNode();
        
        // Look for patterns like: (config as unknown) or (options as unknown)
        if (Node.isIdentifier(expression) && 
            typeNode && typeNode.getKind() === SyntaxKind.UnknownKeyword) {
          
          const varName = expression.getText();
          if (varName.match(/^(config|options|params|settings|data)$/)) {
            const before = node.getText();
            const after = varName;
            
            this.transformations.push({
              file: sourceFile.getFilePath(),
              line: node.getStartLineNumber(),
              before,
              after,
              pattern: "config-object-cast"
            });
            
            node.replaceWithText(after);
          }
        }
      }
    });
  }

  private fixSessionServicePatterns(sourceFile: SourceFile): void {
    // Pattern: (sessionProvider as unknown), (sessionRecord as unknown)
    sourceFile.forEachDescendant((node) => {
      if (Node.isAsExpression(node)) {
        const expression = node.getExpression();
        const typeNode = node.getTypeNode();
        
        if (Node.isIdentifier(expression) && 
            typeNode && typeNode.getKind() === SyntaxKind.UnknownKeyword) {
          
          const varName = expression.getText();
          if (varName.match(/^(session|provider|record|service|backend|db)/) || 
              varName.match(/(Provider|Record|Service|Backend|Db)$/)) {
            
            const before = node.getText();
            const after = varName;
            
            this.transformations.push({
              file: sourceFile.getFilePath(),
              line: node.getStartLineNumber(),
              before,
              after,
              pattern: "session-service-cast"
            });
            
            node.replaceWithText(after);
          }
        }
      }
    });
  }

  private fixPromiseReturnPatterns(sourceFile: SourceFile): void {
    // Pattern: Promise.resolve(value) as unknown, return (result as unknown)
    sourceFile.forEachDescendant((node) => {
      if (Node.isAsExpression(node)) {
        const expression = node.getExpression();
        const typeNode = node.getTypeNode();
        
        if (typeNode && typeNode.getKind() === SyntaxKind.UnknownKeyword) {
          
          const exprText = expression.getText();
          
          // Promise.resolve/reject patterns
          if (exprText.includes("Promise.resolve") || exprText.includes("Promise.reject")) {
            const before = node.getText();
            const after = exprText;
            
            this.transformations.push({
              file: sourceFile.getFilePath(),
              line: node.getStartLineNumber(),
              before,
              after,
              pattern: "promise-return-cast"
            });
            
            node.replaceWithText(after);
          }
        }
      }
    });
  }

  private fixErrorHandlingPatterns(sourceFile: SourceFile): void {
    // Pattern: (error as unknown), (e as unknown)
    sourceFile.forEachDescendant((node) => {
      if (Node.isAsExpression(node)) {
        const expression = node.getExpression();
        const typeNode = node.getTypeNode();
        
        if (Node.isIdentifier(expression) && 
            typeNode && typeNode.getKind() === SyntaxKind.UnknownKeyword) {
          
          const varName = expression.getText();
          if (varName.match(/^(error|err|e|exception)$/)) {
            const before = node.getText();
            const after = varName;
            
            this.transformations.push({
              file: sourceFile.getFilePath(),
              line: node.getStartLineNumber(),
              before,
              after,
              pattern: "error-handling-cast"
            });
            
            node.replaceWithText(after);
          }
        }
      }
    });
  }

  private fixMockFunctionPatterns(sourceFile: SourceFile): void {
    // Pattern: jest.fn() as unknown, mock objects as unknown
    sourceFile.forEachDescendant((node) => {
      if (Node.isAsExpression(node)) {
        const expression = node.getExpression();
        const typeNode = node.getTypeNode();
        
        if (typeNode && typeNode.getKind() === SyntaxKind.UnknownKeyword) {
          
          const exprText = expression.getText();
          
          // Mock function patterns
          if (exprText.includes("jest.fn()") || 
              exprText.includes("mockResolvedValue") ||
              exprText.includes("mockImplementation")) {
            
            const before = node.getText();
            const after = exprText;
            
            this.transformations.push({
              file: sourceFile.getFilePath(),
              line: node.getStartLineNumber(),
              before,
              after,
              pattern: "mock-function-cast"
            });
            
            node.replaceWithText(after);
          }
        }
      }
    });
  }

  private fixSimplePropertyAccess(sourceFile: SourceFile): void {
    // Pattern: (obj.prop as unknown) for simple property access
    sourceFile.forEachDescendant((node) => {
      if (Node.isAsExpression(node)) {
        const expression = node.getExpression();
        const typeNode = node.getTypeNode();
        
        if (Node.isPropertyAccessExpression(expression) && 
            Node.isKeywordTypeNode(typeNode) && 
            typeNode.getKind() === SyntaxKind.UnknownKeyword) {
          
          const before = node.getText();
          const after = expression.getText();
          
          // Only for simple property access, not complex chains
          if (!after.includes("(") && !after.includes("[") && 
              after.split(".").length <= 3) {
            
            this.transformations.push({
              file: sourceFile.getFilePath(),
              line: node.getStartLineNumber(),
              before,
              after,
              pattern: "simple-property-access"
            });
            
            node.replaceWithText(after);
          }
        }
      }
    });
  }

  private fixParameterPatterns(sourceFile: SourceFile): void {
    // Pattern: (params as unknown), (result as unknown) for simple variables
    sourceFile.forEachDescendant((node) => {
      if (Node.isAsExpression(node)) {
        const expression = node.getExpression();
        const typeNode = node.getTypeNode();
        
        if (Node.isIdentifier(expression) && 
            Node.isKeywordTypeNode(typeNode) && 
            typeNode.getKind() === SyntaxKind.UnknownKeyword) {
          
          const varName = expression.getText();
          if (varName.match(/^(params|result|data|value|item|element)$/)) {
            const before = node.getText();
            const after = varName;
            
            this.transformations.push({
              file: sourceFile.getFilePath(),
              line: node.getStartLineNumber(),
              before,
              after,
              pattern: "parameter-cast"
            });
            
            node.replaceWithText(after);
          }
        }
      }
    });
  }

  private fixIndentationIssues(sourceFile: SourceFile): void {
    // Fix indentation issues caused by AST transformations
    const text = sourceFile.getFullText();
    const lines = text.split('\n');
    let modified = false;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trimStart();
      
      // Look for lines with excessive indentation (14+ spaces when expecting 8)
      if (line.match(/^              \w/) && !trimmed.startsWith('//')) {
        // Reduce indentation by 6 spaces (from 14 to 8)
        lines[i] = line.replace(/^              /, '        ');
        modified = true;
      }
      // Look for lines with 18 spaces when expecting 10
      else if (line.match(/^                  \w/) && !trimmed.startsWith('//')) {
        // Reduce indentation by 8 spaces (from 18 to 10)
        lines[i] = line.replace(/^                  /, '          ');
        modified = true;
      }
      // Look for lines with 16 spaces when expecting 8
      else if (line.match(/^                \w/) && !trimmed.startsWith('//')) {
        // Reduce indentation by 8 spaces (from 16 to 8)
        lines[i] = line.replace(/^                /, '        ');
        modified = true;
      }
      // Look for lines with 12 spaces when expecting 6
      else if (line.match(/^            \w/) && !trimmed.startsWith('//')) {
        // Check if this should actually be 6 spaces
        if (i > 0 && lines[i-1].match(/^      \w/) && !lines[i-1].includes('{')) {
          lines[i] = line.replace(/^            /, '      ');
          modified = true;
        }
      }
    }
    
    if (modified) {
      sourceFile.replaceWithText(lines.join('\n'));
      this.transformations.push({
        file: sourceFile.getFilePath(),
        line: 0,
        before: "incorrect indentation",
        after: "fixed indentation",
        pattern: "indentation-fix"
      });
    }
  }

  private generateReport(): void {
    const reportPath = "comprehensive-transformation-report.json";
    const report = {
      timestamp: new Date().toISOString(),
      totalTransformations: this.transformations.length,
      patternBreakdown: this.getPatternBreakdown(),
      transformations: this.transformations
    };
    
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    
    console.log(`\n✅ Comprehensive fixes completed!`);
    console.log(`📊 Total transformations: ${this.transformations.length}`);
    console.log(`📋 Pattern breakdown:`);
    
    Object.entries(this.getPatternBreakdown()).forEach(([pattern, count]) => {
      console.log(`   ${pattern}: ${count}`);
    });
    
    console.log(`📄 Full report: ${reportPath}`);
  }

  private getPatternBreakdown(): Record<string, number> {
    const breakdown: Record<string, number> = {};
    this.transformations.forEach(t => {
      breakdown[t.pattern] = (breakdown[t.pattern] || 0) + 1;
    });
    return breakdown;
  }
}

// Run the comprehensive fixer
async function main() {
  const fixer = new ComprehensiveAsUnknownFixer();
  await fixer.fixAllPatterns();
}

if (import.meta.main) {
  main().catch(console.error);
} 
