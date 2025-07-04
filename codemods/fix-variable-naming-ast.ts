#!/usr/bin/env bun

import { Project, Node, ts } from 'ts-morph';
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
 */

interface VariableIssue {
  file: string;
  line: number;
  column: number;
  declared: string;
  used: string;
  context: string;
}

class VariableNamingFixer {
  private project: Project;
  private issues: VariableIssue[] = [];
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
   * Analyze variable naming issues
   */
  analyzeIssues(): void {
    console.log('🔍 Analyzing variable naming issues...');
    
    for (const sourceFile of this.project.getSourceFiles()) {
      this.analyzeSourceFile(sourceFile);
    }
    
    console.log(`📊 Found ${this.issues.length} variable naming issues`);
  }

  /**
   * Analyze a single source file for variable naming issues
   */
  private analyzeSourceFile(sourceFile: any): void {
    const filePath = sourceFile.getFilePath();
    
    // Find variable declarations with underscores
    const variableDeclarations = sourceFile.getDescendantsOfKind(ts.SyntaxKind.VariableDeclaration);
    
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
    const parameters = sourceFile.getDescendantsOfKind(ts.SyntaxKind.Parameter);
    
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
  private findVariableUsages(sourceFile: any, variableName: string): any[] {
    const usages: any[] = [];
    
    // Find all identifiers that match the variable name
    const identifiers = sourceFile.getDescendantsOfKind(ts.SyntaxKind.Identifier);
    
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
   * Apply fixes to resolve variable naming issues
   */
  applyFixes(): void {
    console.log('🔧 Applying variable naming fixes...');
    
    for (const issue of this.issues) {
      try {
        this.fixVariableNaming(issue);
      } catch (error) {
        console.error(`❌ Failed to fix issue in ${issue.file}:${issue.line}: ${error}`);
      }
    }
    
    console.log(`✅ Applied ${this.fixes} fixes`);
  }

  /**
   * Fix a specific variable naming issue
   */
  private fixVariableNaming(issue: VariableIssue): void {
    const sourceFile = this.project.getSourceFile(issue.file);
    if (!sourceFile) {
      console.warn(`⚠️  Could not find source file: ${issue.file}`);
      return;
    }

    // Find the variable declaration
    const variableDeclarations = sourceFile.getDescendantsOfKind(ts.SyntaxKind.VariableDeclaration);
    
    for (const declaration of variableDeclarations) {
      const pos = declaration.getStart();
      const lineAndColumn = sourceFile.getLineAndColumnAtPos(pos);
      
      if (lineAndColumn.line === issue.line && declaration.getName() === issue.declared) {
        // Rename the variable declaration
        const nameNode = declaration.getNameNode();
        if (Node.isIdentifier(nameNode)) {
          nameNode.rename(issue.used);
          this.fixes++;
          console.log(`✅ Fixed ${issue.declared} → ${issue.used} in ${issue.file}:${issue.line}`);
        }
        return;
      }
    }
    
    // Also check function parameters
    const parameters = sourceFile.getDescendantsOfKind(ts.SyntaxKind.Parameter);
    
    for (const param of parameters) {
      const pos = param.getStart();
      const lineAndColumn = sourceFile.getLineAndColumnAtPos(pos);
      
      if (lineAndColumn.line === issue.line && param.getName() === issue.declared) {
        // Rename the parameter
        const nameNode = param.getNameNode();
        if (Node.isIdentifier(nameNode)) {
          nameNode.rename(issue.used);
          this.fixes++;
          console.log(`✅ Fixed ${issue.declared} → ${issue.used} in ${issue.file}:${issue.line}`);
        }
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
    console.log('\n📋 Variable Naming Fix Report:');
    console.log(`   Issues found: ${this.issues.length}`);
    console.log(`   Fixes applied: ${this.fixes}`);
    console.log(`   Success rate: ${this.issues.length > 0 ? ((this.fixes / this.issues.length) * 100).toFixed(1) : 0}%`);
    
    if (this.issues.length > this.fixes) {
      console.log('\n⚠️  Unresolved issues:');
      const unresolved = this.issues.slice(this.fixes);
      for (const issue of unresolved.slice(0, 5)) {
        console.log(`   ${issue.file}:${issue.line} - ${issue.declared} → ${issue.used}`);
      }
      if (unresolved.length > 5) {
        console.log(`   ... and ${unresolved.length - 5} more`);
      }
    }
  }
}

// Main execution
async function main() {
  console.log('🚀 Starting AST-based variable naming fix...\n');
  
  const fixer = new VariableNamingFixer();
  
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
    
    console.log('\n✅ Variable naming fix completed successfully!');
    
  } catch (error) {
    console.error('❌ Error during variable naming fix:', error);
    process.exit(1);
  }
}

// Run the codemod
main().catch(console.error); 
