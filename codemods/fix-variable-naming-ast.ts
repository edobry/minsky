#!/usr/bin/env bun

import { VariableNamingCodemod } from './utils/specialized-codemods';
import { SourceFile, Node, SyntaxKind } from 'ts-morph';
import { globSync } from 'glob';

/**
 * AST-based Variable Naming Fix
 * 
 * Uses ts-morph to safely fix variable naming issues by:
 * 1. Parsing TypeScript AST to understand context
 * 2. Identifying variable declarations with underscores
 * 3. Checking if variables are used without underscores
 * 4. Safely renaming variables to match usage patterns
 * 
 * Following Task #178 best practices for proper codemod development
 * Refactored to use VariableNamingCodemod utility class
 */

interface VariableIssue {
  file: string;
  line: number;
  column: number;
  declared: string;
  used: string;
  context: string;
}

class AdvancedVariableNamingFixer extends VariableNamingCodemod {
  private issues: VariableIssue[] = [];
  private fixes: number = 0;

  constructor() {
    super();
  }

  /**
   * Override the base applyToFile method with comprehensive logic
   */
  applyToFile(filePath: string): boolean {
    console.log(`🔄 Processing ${filePath}...`);
    
    return this.safeApplyChanges(filePath, (sourceFile) => {
      let hasChanges = false;
      
      // First apply the base class logic
      const baseChanges = super.applyToFile(filePath);
      
      // Then apply our specific comprehensive logic
      const advancedChanges = this.applyAdvancedNamingFixes(sourceFile);
      
      return baseChanges || advancedChanges;
    });
  }

  /**
   * Apply advanced naming fixes with comprehensive analysis
   */
  private applyAdvancedNamingFixes(sourceFile: SourceFile): boolean {
    let hasChanges = false;
    
    // Analyze this file for complex underscore patterns
    this.analyzeSourceFile(sourceFile);
    
    // Apply fixes based on analysis
    for (const issue of this.issues) {
      if (issue.file === sourceFile.getFilePath()) {
        try {
          if (this.fixVariableNaming(sourceFile, issue)) {
            hasChanges = true;
            this.fixes++;
          }
        } catch (error) {
          console.error(`❌ Failed to fix issue in ${issue.file}:${issue.line}: ${error}`);
        }
      }
    }
    
    return hasChanges;
  }

  /**
   * Analyze a single source file for variable naming issues
   */
  private analyzeSourceFile(sourceFile: SourceFile): void {
    const filePath = sourceFile.getFilePath();
    
    // Find variable declarations with underscores
    const variableDeclarations = sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration);
    
    for (const declaration of variableDeclarations) {
      const name = declaration.getName();
      
      // Check if variable has underscore prefix but is used without it
      if (name.startsWith('_') && name.length > 1) {
        // Handle multiple underscores: __result -> result, _result -> result
        let nameWithoutUnderscore = name;
        while (nameWithoutUnderscore.startsWith('_')) {
          nameWithoutUnderscore = nameWithoutUnderscore.substring(1);
        }
        
        // Check if the variable without underscore is used in the file
        const usages = this.findVariableUsages(sourceFile, nameWithoutUnderscore);
        
        if (usages.length > 0) {
          const pos = declaration.getStart();
          const lineAndColumn = sourceFile.getLineAndColumnAtPos(pos);
          
          this.issues.push({
            file: filePath,
            line: lineAndColumn.line,
            column: lineAndColumn.column,
            declared: name,
            used: nameWithoutUnderscore,
            context: declaration.getParent().getText().substring(0, 100)
          });
        }
      }
    }
    
    // Also check function parameters with underscores
    const parameters = sourceFile.getDescendantsOfKind(SyntaxKind.Parameter);
    
    for (const param of parameters) {
      const name = param.getName();
      
      // Check if parameter has underscore prefix but is used without it
      if (name.startsWith('_') && name.length > 1) {
        const nameWithoutUnderscore = name.substring(1);
        
        // Check if the variable without underscore is used in the function
        const usages = this.findVariableUsages(sourceFile, nameWithoutUnderscore);
        
        if (usages.length > 0) {
          const pos = param.getStart();
          const lineAndColumn = sourceFile.getLineAndColumnAtPos(pos);
          
          this.issues.push({
            file: filePath,
            line: lineAndColumn.line,
            column: lineAndColumn.column,
            declared: name,
            used: nameWithoutUnderscore,
            context: param.getParent().getText().substring(0, 100)
          });
        }
      }
    }
  }

  /**
   * Find usages of a variable name in the source file
   */
  private findVariableUsages(sourceFile: SourceFile, variableName: string): any[] {
    const usages: any[] = [];
    
    // Find all identifiers that match the variable name
    const identifiers = sourceFile.getDescendantsOfKind(SyntaxKind.Identifier);
    
    for (const identifier of identifiers) {
      if (identifier.getText() === variableName) {
        // Check if this is actually a variable reference (not a declaration)
        const parent = identifier.getParent();
        if (!Node.isVariableDeclaration(parent) && !Node.isParameterDeclaration(parent)) {
          usages.push(identifier);
        }
      }
    }
    
    return usages;
  }

  /**
   * Fix a specific variable naming issue
   */
  private fixVariableNaming(sourceFile: SourceFile, issue: VariableIssue): boolean {
    // Find the variable declaration
    const variableDeclarations = sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration);
    
    for (const declaration of variableDeclarations) {
      const pos = declaration.getStart();
      const lineAndColumn = sourceFile.getLineAndColumnAtPos(pos);
      
      if (lineAndColumn.line === issue.line && declaration.getName() === issue.declared) {
        // Rename the variable declaration
        const nameNode = declaration.getNameNode();
        if (Node.isIdentifier(nameNode)) {
          nameNode.rename(issue.used);
          console.log(`✅ Fixed ${issue.declared} → ${issue.used} in ${issue.file}:${issue.line}`);
          return true;
        }
      }
    }

    // Also check function parameters
    const parameters = sourceFile.getDescendantsOfKind(SyntaxKind.Parameter);
    
    for (const param of parameters) {
      const pos = param.getStart();
      const lineAndColumn = sourceFile.getLineAndColumnAtPos(pos);
      
      if (lineAndColumn.line === issue.line && param.getName() === issue.declared) {
        // Rename the parameter
        const nameNode = param.getNameNode();
        if (Node.isIdentifier(nameNode)) {
          nameNode.rename(issue.used);
          console.log(`✅ Fixed parameter ${issue.declared} → ${issue.used} in ${issue.file}:${issue.line}`);
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Batch process multiple files
   */
  async processFiles(patterns: string[]): Promise<void> {
    console.log('🔄 Starting advanced variable naming fix...');
    
    const files = patterns.flatMap(pattern => globSync(pattern, { ignore: ['**/*.d.ts'] }));
    console.log(`📁 Processing ${files.length} TypeScript files...`);
    
    let totalFixed = 0;
    
    for (const file of files) {
      const success = this.applyToFile(file);
      if (success) {
        totalFixed++;
      }
    }
    
    console.log(`\n📊 Advanced Variable Naming Fix Complete:`);
    console.log(`✅ Files processed: ${files.length}`);
    console.log(`✅ Files with fixes: ${totalFixed}`);
    console.log(`✅ Total fixes applied: ${this.fixes}`);
    console.log(`📋 Issues found: ${this.issues.length}`);
  }

  /**
   * Generate detailed report
   */
  generateReport(): void {
    console.log('\n📋 Variable Naming Analysis Report:');
    console.log('================================');
    
    if (this.issues.length === 0) {
      console.log('✅ No variable naming issues found!');
      return;
    }
    
    console.log(`📊 Total Issues: ${this.issues.length}`);
    console.log(`🔧 Fixes Applied: ${this.fixes}`);
    console.log(`⚠️  Remaining Issues: ${this.issues.length - this.fixes}\n`);
    
    // Group issues by file
    const issuesByFile = this.issues.reduce((acc, issue) => {
      if (!acc[issue.file]) acc[issue.file] = [];
      acc[issue.file].push(issue);
      return acc;
    }, {} as Record<string, VariableIssue[]>);
    
    for (const [file, issues] of Object.entries(issuesByFile)) {
      console.log(`📄 ${file}:`);
      for (const issue of issues) {
        console.log(`  Line ${issue.line}: ${issue.declared} → ${issue.used}`);
        console.log(`    Context: ${issue.context.trim()}...`);
      }
      console.log('');
    }
  }
}

// Execute if run directly
async function main() {
  const fixer = new AdvancedVariableNamingFixer();
  
  const patterns = process.argv.slice(2);
  if (patterns.length === 0) {
    console.log('Usage: bun run fix-variable-naming-ast.ts <pattern1> [pattern2] ...');
    console.log('Example: bun run fix-variable-naming-ast.ts "src/**/*.ts"');
    process.exit(1);
  }
  
  await fixer.processFiles(patterns);
  fixer.generateReport();
}

if (import.meta.main) {
  await main();
}

export default AdvancedVariableNamingFixer; 
