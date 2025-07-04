#!/usr/bin/env bun

import { Project, Node, ts } from 'ts-morph';
import { globSync } from 'glob';

/**
 * AST-based Undefined Variables Fix
 * 
 * Fixes variables that are used but not defined, where the issue is incorrect underscore usage.
 * This handles cases like:
 * - `_cause` used but `cause` is in scope
 * - `__result` used but `result` is in scope
 * - `_result` used but `result` is in scope
 * 
 * Different from variable naming fix - this fixes usage sites, not declarations.
 */

interface UndefinedVariableIssue {
  file: string;
  line: number;
  column: number;
  used: string;
  shouldBe: string;
  context: string;
}

class UndefinedVariablesFixer {
  private project: Project;
  private issues: UndefinedVariableIssue[] = [];
  private fixes: number = 0;

  constructor() {
    this.project = new Project({
      tsConfigFilePath: './tsconfig.json',
      skipAddingFilesFromTsConfig: true,
    });
  }

  /**
   * Add source files to the project
   */
  addSourceFiles(patterns: string[]): void {
    const files = patterns.flatMap(pattern => globSync(pattern, { ignore: ['**/*.d.ts'] }));
    console.log(`📁 Adding ${files.length} TypeScript files to project...`);
    
    for (const file of files) {
      try {
        this.project.addSourceFileAtPath(file);
      } catch (error) {
        console.warn(`⚠️  Could not add file ${file}: ${error}`);
      }
    }
  }

  /**
   * Analyze undefined variable issues
   */
  analyzeIssues(): void {
    console.log('🔍 Analyzing undefined variable issues...');
    
    for (const sourceFile of this.project.getSourceFiles()) {
      this.analyzeSourceFile(sourceFile);
    }
    
    console.log(`📊 Found ${this.issues.length} undefined variable issues`);
  }

  /**
   * Analyze a single source file for undefined variable issues
   */
  private analyzeSourceFile(sourceFile: any): void {
    const filePath = sourceFile.getFilePath();
    
    // Get all identifiers in the file
    const identifiers = sourceFile.getDescendantsOfKind(ts.SyntaxKind.Identifier);
    
    for (const identifier of identifiers) {
      const name = identifier.getText();
      
      // Skip if this identifier is a declaration itself
      if (this.isDeclaration(identifier)) {
        continue;
      }
      
      // Check for problematic underscore patterns
      if (name.startsWith('_') && name.length > 1) {
        // Get potential correct variable name by removing underscores
        let correctName = name;
        while (correctName.startsWith('_')) {
          correctName = correctName.substring(1);
        }
        
        // Check if the correct name exists in scope
        if (this.isVariableInScope(sourceFile, identifier, correctName)) {
          const pos = identifier.getStart();
          const lineAndColumn = sourceFile.getLineAndColumnAtPos(pos);
          
          this.issues.push({
            file: filePath,
            line: lineAndColumn.line,
            column: lineAndColumn.column,
            used: name,
            shouldBe: correctName,
            context: identifier.getParent().getText().substring(0, 100)
          });
        }
      }
    }
  }

  /**
   * Check if an identifier is a declaration (variable, parameter, etc.)
   */
  private isDeclaration(identifier: any): boolean {
    const parent = identifier.getParent();
    return (
      Node.isVariableDeclaration(parent) ||
      Node.isParameterDeclaration(parent) ||
      Node.isFunctionDeclaration(parent) ||
      Node.isClassDeclaration(parent) ||
      Node.isInterfaceDeclaration(parent) ||
      Node.isTypeAliasDeclaration(parent) ||
      Node.isEnumDeclaration(parent) ||
      Node.isImportSpecifier(parent) ||
      Node.isImportClause(parent)
    );
  }

  /**
   * Check if a variable name is in scope at the given location
   */
  private isVariableInScope(sourceFile: any, location: any, variableName: string): boolean {
    // Get the scope containing this location
    let currentScope = location.getParent();
    
    while (currentScope) {
      // Check for variable declarations in this scope
      const variableDeclarations = currentScope.getDescendantsOfKind?.(ts.SyntaxKind.VariableDeclaration) || [];
      
      for (const declaration of variableDeclarations) {
        if (declaration.getName() === variableName) {
          return true;
        }
      }
      
      // Check for function parameters if we're in a function
      if (Node.isFunctionDeclaration(currentScope) || 
          Node.isMethodDeclaration(currentScope) || 
          Node.isArrowFunction(currentScope) ||
          Node.isFunctionExpression(currentScope)) {
        const parameters = currentScope.getParameters();
        for (const param of parameters) {
          if (param.getName() === variableName) {
            return true;
          }
        }
      }
      
      // Move up to parent scope
      currentScope = currentScope.getParent();
    }
    
    // Also check for imports and global variables
    const imports = sourceFile.getImportDeclarations();
    for (const importDecl of imports) {
      const namedImports = importDecl.getNamedImports();
      for (const namedImport of namedImports) {
        if (namedImport.getName() === variableName) {
          return true;
        }
      }
    }
    
    return false;
  }

  /**
   * Apply fixes to resolve undefined variable issues
   */
  applyFixes(): void {
    console.log('🔧 Applying undefined variable fixes...');
    
    for (const issue of this.issues) {
      try {
        this.fixUndefinedVariable(issue);
      } catch (error) {
        console.error(`❌ Failed to fix issue in ${issue.file}:${issue.line}: ${error}`);
      }
    }
    
    console.log(`✅ Applied ${this.fixes} fixes`);
  }

  /**
   * Fix a specific undefined variable issue
   */
  private fixUndefinedVariable(issue: UndefinedVariableIssue): void {
    const sourceFile = this.project.getSourceFile(issue.file);
    if (!sourceFile) {
      console.warn(`⚠️  Could not find source file: ${issue.file}`);
      return;
    }

    // Find the identifier at the specific location
    const identifiers = sourceFile.getDescendantsOfKind(ts.SyntaxKind.Identifier);
    
    for (const identifier of identifiers) {
      const pos = identifier.getStart();
      const lineAndColumn = sourceFile.getLineAndColumnAtPos(pos);
      
      if (lineAndColumn.line === issue.line && 
          lineAndColumn.column === issue.column && 
          identifier.getText() === issue.used) {
        
        // Replace the identifier text
        identifier.replaceWithText(issue.shouldBe);
        this.fixes++;
        console.log(`✅ Fixed ${issue.used} → ${issue.shouldBe} in ${issue.file}:${issue.line}`);
        return;
      }
    }
  }

  /**
   * Save all changes to disk
   */
  async saveChanges(): Promise<void> {
    console.log('💾 Saving changes...');
    
    const changedFiles = this.project.getSourceFiles().filter(sf => sf.wasForgotten() === false);
    
    for (const sourceFile of changedFiles) {
      if (sourceFile.isSaved() === false) {
        await sourceFile.save();
      }
    }
    
    console.log(`💾 Saved changes to ${changedFiles.length} files`);
  }

  /**
   * Generate a summary report
   */
  generateReport(): void {
    console.log('\n📋 Undefined Variables Fix Report:');
    console.log(`   Issues found: ${this.issues.length}`);
    console.log(`   Fixes applied: ${this.fixes}`);
    console.log(`   Success rate: ${this.issues.length > 0 ? ((this.fixes / this.issues.length) * 100).toFixed(1) : 0}%`);
    
    if (this.issues.length > this.fixes) {
      console.log('\n⚠️  Unresolved issues:');
      const unresolved = this.issues.slice(this.fixes);
      for (const issue of unresolved.slice(0, 5)) {
        console.log(`   ${issue.file}:${issue.line} - ${issue.used} → ${issue.shouldBe}`);
      }
      if (unresolved.length > 5) {
        console.log(`   ... and ${unresolved.length - 5} more`);
      }
    }
  }
}

// Main execution
async function main() {
  console.log('🚀 Starting AST-based undefined variables fix...\n');
  
  const fixer = new UndefinedVariablesFixer();
  
  try {
    // Add source files
    fixer.addSourceFiles(['src/**/*.ts']);
    
    // Analyze issues
    fixer.analyzeIssues();
    
    // Apply fixes
    fixer.applyFixes();
    
    // Save changes
    await fixer.saveChanges();
    
    // Generate report
    fixer.generateReport();
    
    console.log('\n✅ Undefined variables fix completed successfully!');
    
  } catch (error) {
    console.error('❌ Error during undefined variables fix:', error);
    process.exit(1);
  }
}

// Run the codemod
main().catch(console.error); 
