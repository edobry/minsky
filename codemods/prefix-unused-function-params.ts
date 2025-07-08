#!/usr/bin/env bun

import { UnusedVariableCodemod } from './utils/specialized-codemods';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { resolve, join, extname } from 'path';
import { SourceFile, SyntaxKind, Node } from 'ts-morph';
import { globSync } from 'glob';

/**
 * Enhanced Unused Function Parameter Prefixer
 * 
 * Prefixes unused function parameters with underscores using:
 * - AST-based analysis for accurate detection
 * - Regex-based patterns for additional edge cases
 * - Comprehensive parameter usage analysis
 * - Safe parameter renaming with scope awareness
 * 
 * Refactored to extend UnusedVariableCodemod utility class
 */

interface ParameterUsageInfo {
  paramName: string;
  isUsed: boolean;
  usageCount: number;
  locations: string[];
  functionName: string;
}

class EnhancedUnusedParameterPrefixer extends UnusedVariableCodemod {
  private sessionDir: string;
  private processedFiles: number = 0;
  private modifiedFiles: number = 0;
  private parametersModified: number = 0;

  constructor(sessionDir: string = process.cwd()) {
    super();
    this.sessionDir = sessionDir;
  }

  /**
   * Override applyToFile to add enhanced parameter prefixing logic
   */
  applyToFile(filePath: string): boolean {
    console.log(`🔄 Processing ${filePath}...`);
    
    return this.safeApplyChanges(filePath, (sourceFile) => {
      let hasChanges = false;
      
      // First apply the base class logic (handles basic unused parameters)
      const baseChanges = super.applyToFile(filePath);
      
      // Then apply our enhanced regex-based logic for complex patterns
      const regexChanges = this.applyRegexBasedParameterPrefixing(sourceFile);
      
      // Finally apply AST-based analysis for comprehensive coverage
      const astChanges = this.applyASTBasedParameterPrefixing(sourceFile);
      
      return baseChanges || regexChanges || astChanges;
    });
  }

  /**
   * Apply regex-based parameter prefixing for edge cases
   */
  private applyRegexBasedParameterPrefixing(sourceFile: SourceFile): boolean {
    let hasChanges = false;
    const originalText = sourceFile.getFullText();
    const modifiedText = this.prefixUnusedFunctionParams(originalText);
    
    if (originalText !== modifiedText) {
      sourceFile.replaceWithText(modifiedText);
      hasChanges = true;
    }
    
    return hasChanges;
  }

  /**
   * Apply AST-based parameter prefixing for comprehensive analysis
   */
  private applyASTBasedParameterPrefixing(sourceFile: SourceFile): boolean {
    let hasChanges = false;
    
    // Analyze arrow functions
    sourceFile.getDescendantsOfKind(SyntaxKind.ArrowFunction).forEach(arrowFunc => {
      if (this.processParametersInFunction(arrowFunc)) {
        hasChanges = true;
      }
    });
    
    // Analyze function declarations
    sourceFile.getDescendantsOfKind(SyntaxKind.FunctionDeclaration).forEach(funcDecl => {
      if (this.processParametersInFunction(funcDecl)) {
        hasChanges = true;
      }
    });
    
    // Analyze method declarations
    sourceFile.getDescendantsOfKind(SyntaxKind.MethodDeclaration).forEach(methodDecl => {
      if (this.processParametersInFunction(methodDecl)) {
        hasChanges = true;
      }
    });
    
    return hasChanges;
  }

  /**
   * Process parameters in a function node
   */
  private processParametersInFunction(functionNode: Node): boolean {
    let hasChanges = false;
    
    const parameters = functionNode.getChildrenOfKind(SyntaxKind.Parameter);
    const functionBody = functionNode.getDescendantsOfKind(SyntaxKind.Block)[0];
    
    if (!functionBody) return false;
    
    parameters.forEach(param => {
      const paramName = param.getSymbol()?.getName();
      if (!paramName || paramName.startsWith('_')) return;
      
      // Check if parameter is used in the function body
      const usages = this.findParameterUsages(functionBody, paramName);
      
      if (usages.length === 0) {
        // Parameter is unused, prefix with underscore
        const nameNode = param.getNameNode();
        if (nameNode && Node.isIdentifier(nameNode)) {
          nameNode.rename('_' + paramName);
          hasChanges = true;
          this.parametersModified++;
        }
      }
    });
    
    return hasChanges;
  }

  /**
   * Find usages of a parameter in a function body
   */
  private findParameterUsages(functionBody: Node, paramName: string): Node[] {
    const usages: Node[] = [];
    
    functionBody.getDescendantsOfKind(SyntaxKind.Identifier).forEach(identifier => {
      if (identifier.getText() === paramName) {
        // Check if this is a usage (not a declaration)
        const parent = identifier.getParent();
        if (!Node.isParameterDeclaration(parent)) {
          usages.push(identifier);
        }
      }
    });
    
    return usages;
  }

  /**
   * Regex-based unused function parameter prefixing (enhanced from original)
   */
  private prefixUnusedFunctionParams(content: string): string {
    let modified = content;
    
    // Pattern 1: Simple callback function parameters
    // Look for patterns like: (param) => { ... } where param is not used
    modified = modified.replace(/\(([a-zA-Z_][a-zA-Z0-9_]*)\)\s*=>\s*\{([^}]*)\}/g,
      (match, param, body) => {
        // Skip if already prefixed with underscore
        if (param.startsWith('_')) return match;
        
        // Check if parameter is used in the function body
        const escapedParam = this.escapeRegexChars(param);
        const usageRegex = new RegExp(`\\b${escapedParam}\\b`, 'g');
        if (!usageRegex.test(body)) {
          return match.replace(`(${param})`, `(_${param})`);
        }
        
        return match;
      }
    );
    
    // Pattern 2: Function declaration parameters that are unused
    // Look for patterns like: function name(param) { ... } where param is not used
    modified = modified.replace(/function\s+\w+\s*\(([a-zA-Z_][a-zA-Z0-9_]*)\)\s*\{([^}]*)\}/g,
      (match, param, body) => {
        // Skip if already prefixed with underscore
        if (param.startsWith('_')) return match;
        
        // Check if parameter is used in the function body
        const escapedParam = this.escapeRegexChars(param);
        const usageRegex = new RegExp(`\\b${escapedParam}\\b`, 'g');
        if (!usageRegex.test(body)) {
          return match.replace(`(${param})`, `(_${param})`);
        }
        
        return match;
      }
    );
    
    // Pattern 3: Method parameters in object/class methods
    // Look for patterns like: methodName(param) { ... } where param is not used
    modified = modified.replace(/(\w+)\s*\(([a-zA-Z_][a-zA-Z0-9_]*)\)\s*\{([^}]*)\}/g,
      (match, methodName, param, body) => {
        // Skip if already prefixed with underscore
        if (param.startsWith('_')) return match;
        
        // Skip common method names that might be overrides or interfaces
        const skipMethods = ['constructor', 'toString', 'valueOf'];
        if (skipMethods.includes(methodName)) return match;
        
        // Check if parameter is used in the method body
        const escapedParam = this.escapeRegexChars(param);
        const usageRegex = new RegExp(`\\b${escapedParam}\\b`, 'g');
        if (!usageRegex.test(body)) {
          return match.replace(`(${param})`, `(_${param})`);
        }
        
        return match;
      }
    );
    
    // Pattern 4: Multiple parameters where some are unused
    modified = modified.replace(/\(([^)]+)\)\s*(?:=>|{)\s*\{([^}]*)\}/g,
      (match, paramsList, body) => {
        if (!paramsList.includes(',')) return match; // Single parameter already handled
        
        const params = paramsList.split(',').map(p => p.trim());
        const newParams = params.map(param => {
          const cleanParam = param.replace(/^\s*\w+:\s*/, '').replace(/\s*=.*$/, '').trim();
          
          // Skip if already prefixed with underscore
          if (cleanParam.startsWith('_')) return param;
          
          // Check if parameter is used in the function body
          const escapedParam = this.escapeRegexChars(cleanParam);
          const usageRegex = new RegExp(`\\b${escapedParam}\\b`, 'g');
          if (!usageRegex.test(body)) {
            return param.replace(cleanParam, `_${cleanParam}`);
          }
          
          return param;
        });
        
        return match.replace(paramsList, newParams.join(', '));
      }
    );
    
    return modified;
  }

  /**
   * Escape special regex characters in parameter names
   */
  private escapeRegexChars(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Analyze parameter usage in a source file
   */
  private analyzeParameterUsage(sourceFile: SourceFile): ParameterUsageInfo[] {
    const usageInfo: ParameterUsageInfo[] = [];
    
    // Analyze all function types
    const functions = [
      ...sourceFile.getDescendantsOfKind(SyntaxKind.FunctionDeclaration),
      ...sourceFile.getDescendantsOfKind(SyntaxKind.ArrowFunction),
      ...sourceFile.getDescendantsOfKind(SyntaxKind.MethodDeclaration)
    ];
    
    functions.forEach(func => {
      const functionName = this.getFunctionName(func);
      const parameters = func.getChildrenOfKind(SyntaxKind.Parameter);
      const functionBody = func.getDescendantsOfKind(SyntaxKind.Block)[0];
      
      if (!functionBody) return;
      
      parameters.forEach(param => {
        const paramName = param.getSymbol()?.getName();
        if (!paramName) return;
        
        const usages = this.findParameterUsages(functionBody, paramName);
        
        usageInfo.push({
          paramName,
          isUsed: usages.length > 0,
          usageCount: usages.length,
          locations: usages.map(usage => `Line ${sourceFile.getLineAndColumnAtPos(usage.getStart()).line}`),
          functionName
        });
      });
    });
    
    return usageInfo;
  }

  /**
   * Get function name for reporting
   */
  private getFunctionName(func: Node): string {
    if (Node.isFunctionDeclaration(func)) {
      return func.getName() || 'anonymous';
    } else if (Node.isMethodDeclaration(func)) {
      return func.getName() || 'method';
    } else {
      return 'arrow function';
    }
  }

  /**
   * Get all TypeScript files recursively
   */
  private getTsFiles(dir: string): string[] {
    const files: string[] = [];
    
    function walk(currentDir: string) {
      const entries = readdirSync(currentDir);
      
      for (const entry of entries) {
        const fullPath = join(currentDir, entry);
        const stat = statSync(fullPath);
        
        if (stat.isDirectory()) {
          if (!entry.startsWith('.') && 
              entry !== 'node_modules' &&
              entry !== 'codemods') {
            walk(fullPath);
          }
        } else if (stat.isFile() && extname(entry) === '.ts' && !entry.endsWith('.d.ts')) {
          files.push(fullPath);
        }
      }
    }
    
    walk(dir);
    return files;
  }

  /**
   * Test the codemod on a single file
   */
  async testOnSingleFile(filePath: string): Promise<void> {
    const absolutePath = resolve(this.sessionDir, filePath);
    console.log(`\nTesting unused function parameter prefixing on: ${filePath}`);
    
    try {
      const originalContent = readFileSync(absolutePath, 'utf-8');
      
      // Analyze parameter usage
      const sourceFile = this.project.addSourceFileAtPath(absolutePath);
      const usageInfo = this.analyzeParameterUsage(sourceFile);
      
      console.log('\n📊 Parameter Usage Analysis:');
      usageInfo.forEach(info => {
        if (!info.isUsed) {
          console.log(`  ❌ ${info.functionName}(${info.paramName}) - UNUSED`);
        } else {
          console.log(`  ✅ ${info.functionName}(${info.paramName}) - Used ${info.usageCount} times`);
        }
      });
      
      // Apply the prefixing
      const hasChanges = this.applyToFile(absolutePath);
      
      if (hasChanges) {
        console.log('\n🔄 Changes detected');
        const modifiedContent = sourceFile.getFullText();
        
        // Write to a test file to review
        const testPath = `${absolutePath}.function-params-output`;
        writeFileSync(testPath, modifiedContent);
        console.log(`Test output written to: ${testPath}`);
      } else {
        console.log('\n✅ No changes needed for this file.');
      }
    } catch (error) {
      console.error(`Error processing ${filePath}:`, error);
    }
  }

  /**
   * Apply the codemod to all TypeScript files
   */
  async applyToAllFiles(): Promise<void> {
    console.log('\n🚀 Prefixing unused function parameters in entire codebase...');
    
    const srcDir = resolve(this.sessionDir, 'src');
    const files = this.getTsFiles(srcDir);
    
    this.processedFiles = 0;
    this.modifiedFiles = 0;
    this.parametersModified = 0;
    
    for (const absolutePath of files) {
      const relativePath = absolutePath.replace(this.sessionDir + '/', '');
      this.processedFiles++;
      
      try {
        const hasChanges = this.applyToFile(absolutePath);
        
        if (hasChanges) {
          this.modifiedFiles++;
          console.log(`✅ Modified: ${relativePath}`);
        }
      } catch (error) {
        console.error(`❌ Error processing ${relativePath}:`, error);
      }
    }
    
    console.log(`\n📊 Completed: ${this.modifiedFiles}/${this.processedFiles} files modified`);
    console.log(`🏷️  Total parameters prefixed: ${this.parametersModified}`);
  }

  /**
   * Batch process files with patterns
   */
  async processFilePatterns(patterns: string[]): Promise<void> {
    console.log('🔄 Processing files with patterns...');
    
    const files = patterns.flatMap(pattern => globSync(pattern, { ignore: ['**/*.d.ts'] }));
    console.log(`📁 Found ${files.length} TypeScript files`);
    
    this.processedFiles = 0;
    this.modifiedFiles = 0;
    this.parametersModified = 0;
    
    for (const file of files) {
      this.processedFiles++;
      const hasChanges = this.applyToFile(file);
      
      if (hasChanges) {
        this.modifiedFiles++;
        console.log(`✅ Modified: ${file}`);
      }
    }
    
    console.log(`\n📊 Enhanced Parameter Prefixing Complete:`);
    console.log(`✅ Files processed: ${this.processedFiles}`);
    console.log(`✅ Files modified: ${this.modifiedFiles}`);
    console.log(`🏷️  Parameters prefixed: ${this.parametersModified}`);
  }

  /**
   * Generate prefixing report
   */
  generateReport(): void {
    console.log('\n📋 Unused Parameter Prefixing Report:');
    console.log('====================================');
    console.log(`📊 Total files processed: ${this.processedFiles}`);
    console.log(`🔧 Files modified: ${this.modifiedFiles}`);
    console.log(`🏷️  Parameters prefixed: ${this.parametersModified}`);
    console.log(`✅ Success rate: ${this.processedFiles > 0 ? ((this.modifiedFiles / this.processedFiles) * 100).toFixed(1) : 0}%`);
  }
}

// Main execution
async function main() {
  const args = process.argv.slice(2);
  const sessionDir = process.env.SESSION_DIR || process.cwd();
  const prefixer = new EnhancedUnusedParameterPrefixer(sessionDir);

  if (args.length === 0) {
    console.log('Usage:');
    console.log('  bun prefix-unused-function-params.ts test <file>     # Test on single file');
    console.log('  bun prefix-unused-function-params.ts apply          # Apply to all files');
    console.log('  bun prefix-unused-function-params.ts patterns <pattern...>  # Process file patterns');
    console.log('');
    console.log('Examples:');
    console.log('  bun prefix-unused-function-params.ts test src/utils/helpers.ts');
    console.log('  bun prefix-unused-function-params.ts patterns "src/**/*.ts"');
    process.exit(1);
  }

  const command = args[0];
  
  try {
    if (command === 'test' && args[1]) {
      await prefixer.testOnSingleFile(args[1]);
    } else if (command === 'apply') {
      await prefixer.applyToAllFiles();
      prefixer.generateReport();
    } else if (command === 'patterns') {
      const patterns = args.slice(1);
      if (patterns.length === 0) {
        console.log('Error: No patterns provided');
        process.exit(1);
      }
      await prefixer.processFilePatterns(patterns);
      prefixer.generateReport();
    } else {
      console.log('Invalid command. Use "test <file>", "apply", or "patterns <pattern...>"');
      process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}

export default EnhancedUnusedParameterPrefixer; 
