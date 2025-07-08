#!/usr/bin/env bun

import { UnusedImportCodemod } from './utils/specialized-codemods';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { resolve, join, extname } from 'path';
import { SourceFile, SyntaxKind, Node } from 'ts-morph';
import { globSync } from 'glob';

/**
 * Enhanced Unused Import Cleanup
 * 
 * Combines utility class functionality with custom logic for:
 * - Simple regex-based unused import detection
 * - AST-based verification
 * - Batch processing capabilities
 * - Test mode for validation
 * 
 * Refactored to use UnusedImportCodemod utility class
 */

interface ImportUsageInfo {
  importName: string;
  usageCount: number;
  locations: string[];
}

class EnhancedUnusedImportsCleaner extends UnusedImportCodemod {
  private sessionDir: string;
  private processedFiles: number = 0;
  private modifiedFiles: number = 0;

  constructor(sessionDir: string = process.cwd()) {
    super();
    this.sessionDir = sessionDir;
  }

  /**
   * Override applyToFile to add custom logic
   */
  applyToFile(filePath: string): boolean {
    console.log(`🔄 Processing ${filePath}...`);
    
    return this.safeApplyChanges(filePath, (sourceFile) => {
      let hasChanges = false;
      
      // First apply the base class logic (AST-based)
      const astChanges = this.applyASTBasedCleanup(sourceFile);
      
      // Then apply our custom regex-based logic for additional cleanup
      const regexChanges = this.applyRegexBasedCleanup(sourceFile);
      
      return astChanges || regexChanges;
    });
  }

  /**
   * Apply AST-based cleanup using the base class
   */
  private applyASTBasedCleanup(sourceFile: SourceFile): boolean {
    // Use the base class implementation
    return super.applyToFile(sourceFile.getFilePath());
  }

  /**
   * Apply additional regex-based cleanup for edge cases
   */
  private applyRegexBasedCleanup(sourceFile: SourceFile): boolean {
    let hasChanges = false;
    const originalText = sourceFile.getFullText();
    const modifiedText = this.removeUnusedImportsRegex(originalText);
    
    if (originalText !== modifiedText) {
      // Replace the source file content
      sourceFile.replaceWithText(modifiedText);
      hasChanges = true;
    }
    
    return hasChanges;
  }

  /**
   * Regex-based unused import removal (enhanced from original)
   */
  private removeUnusedImportsRegex(content: string): string {
    const lines = content.split('\n');
    const newLines: string[] = [];
    
    for (const line of lines) {
      if (!line.trim().startsWith('import')) {
        newLines.push(line);
        continue;
      }
      
      // Handle simple named imports: import { a, b } from "module";
      const namedImportMatch = line.match(/^(\s*)import\s*\{\s*([^}]+)\s*\}\s*from\s*(['"][^'"]+['"])\s*;?\s*$/);
      
      if (namedImportMatch) {
        const [, indent, importsList, modulePath] = namedImportMatch;
        
        // Check for undefined values from regex match
        if (!importsList || !modulePath) {
          newLines.push(line);
          continue;
        }
        
        const imports = importsList.split(',').map(imp => imp.trim());
        const usedImports: string[] = [];
        
        // Check each import to see if it's used
        for (const imp of imports) {
          const importName = imp.includes(' as ') ? imp.split(' as ')[1]?.trim() : imp.trim();
          
          // Skip if importName is undefined
          if (!importName) {
            usedImports.push(imp);
            continue;
          }
          
          // Remove the import line from content to avoid false positives
          const contentWithoutImportLine = content.replace(line, '');
          
          // Check if the import is used elsewhere in the file
          const usageRegex = new RegExp(`\\b${importName}\\b`);
          if (usageRegex.test(contentWithoutImportLine)) {
            usedImports.push(imp);
          }
        }
        
        // Reconstruct the import line with only used imports
        if (usedImports.length === 0) {
          // Remove the entire import line if nothing is used
          continue;
        } else if (usedImports.length < imports.length) {
          // Reconstruct with only used imports
          const newLine = `${indent}import { ${usedImports.join(', ')} } from ${modulePath};`;
          newLines.push(newLine);
        } else {
          // Keep the original line if all imports are used
          newLines.push(line);
        }
      } else {
        // For non-named imports or complex imports keep as-is for safety
        newLines.push(line);
      }
    }
    
    return newLines.join('\n');
  }

  /**
   * Analyze import usage in a file
   */
  private analyzeImportUsage(sourceFile: SourceFile): ImportUsageInfo[] {
    const usageInfo: ImportUsageInfo[] = [];
    
    sourceFile.getImportDeclarations().forEach(importDecl => {
      const importClause = importDecl.getImportClause();
      if (!importClause) return;

      // Analyze named imports
      const namedBindings = importClause.getNamedBindings();
      if (namedBindings && Node.isNamedImports(namedBindings)) {
                 namedBindings.getElements().forEach(element => {
           const importName = element.getName();
           const usages = this.findUsagesInFileEnhanced(sourceFile, importName);
           
           usageInfo.push({
             importName,
             usageCount: usages.length,
             locations: usages.map(usage => `Line ${sourceFile.getLineAndColumnAtPos(usage.getStart()).line}`)
           });
         });
      }

             // Analyze default import
       const defaultImport = importClause.getDefaultImport();
       if (defaultImport) {
         const importName = defaultImport.getText();
         const usages = this.findUsagesInFileEnhanced(sourceFile, importName);
         
         usageInfo.push({
           importName,
           usageCount: usages.length,
           locations: usages.map(usage => `Line ${sourceFile.getLineAndColumnAtPos(usage.getStart()).line}`)
         });
       }
    });
    
    return usageInfo;
  }

  /**
   * Find usages of a name in the file (enhanced version)
   */
  private findUsagesInFileEnhanced(sourceFile: SourceFile, name: string): Node[] {
    const usages: Node[] = [];
    
    sourceFile.getDescendantsOfKind(SyntaxKind.Identifier).forEach(identifier => {
      if (identifier.getText() === name) {
        // Check if this is a usage (not a declaration)
        const parent = identifier.getParent();
        if (!Node.isImportSpecifier(parent) && !Node.isImportClause(parent)) {
          usages.push(identifier);
        }
      }
    });
    
    return usages;
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
    console.log(`\nTesting unused import removal on: ${filePath}`);
    
    try {
      const originalContent = readFileSync(absolutePath, 'utf-8');
      
      // Analyze import usage
      const sourceFile = this.project.addSourceFileAtPath(absolutePath);
      const usageInfo = this.analyzeImportUsage(sourceFile);
      
      console.log('\n📊 Import Usage Analysis:');
      usageInfo.forEach(info => {
        if (info.usageCount === 0) {
          console.log(`  ❌ ${info.importName} - UNUSED`);
        } else {
          console.log(`  ✅ ${info.importName} - Used ${info.usageCount} times`);
        }
      });
      
      // Apply the cleanup
      const hasChanges = this.applyToFile(absolutePath);
      
      if (hasChanges) {
        console.log('\n🔄 Changes detected');
        const modifiedContent = sourceFile.getFullText();
        
        // Write to a test file to review
        const testPath = `${absolutePath}.import-cleanup-output`;
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
    console.log('\n🚀 Applying unused import cleanup to entire codebase...');
    
    const srcDir = resolve(this.sessionDir, 'src');
    const files = this.getTsFiles(srcDir);
    
    this.processedFiles = 0;
    this.modifiedFiles = 0;
    
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
    
    for (const file of files) {
      this.processedFiles++;
      const hasChanges = this.applyToFile(file);
      
      if (hasChanges) {
        this.modifiedFiles++;
        console.log(`✅ Modified: ${file}`);
      }
    }
    
    console.log(`\n📊 Enhanced Unused Imports Cleanup Complete:`);
    console.log(`✅ Files processed: ${this.processedFiles}`);
    console.log(`✅ Files modified: ${this.modifiedFiles}`);
  }

  /**
   * Generate cleanup report
   */
  generateReport(): void {
    console.log('\n📋 Unused Imports Cleanup Report:');
    console.log('=================================');
    console.log(`📊 Total files processed: ${this.processedFiles}`);
    console.log(`🔧 Files modified: ${this.modifiedFiles}`);
    console.log(`✅ Success rate: ${this.processedFiles > 0 ? ((this.modifiedFiles / this.processedFiles) * 100).toFixed(1) : 0}%`);
  }
}

// Main execution
async function main() {
  const args = process.argv.slice(2);
  const sessionDir = process.env.SESSION_DIR || process.cwd();
  const cleaner = new EnhancedUnusedImportsCleaner(sessionDir);

  if (args.length === 0) {
    console.log('Usage:');
    console.log('  bun unused-imports-cleanup.ts test <file>     # Test on single file');
    console.log('  bun unused-imports-cleanup.ts apply          # Apply to all files');
    console.log('  bun unused-imports-cleanup.ts patterns <pattern...>  # Process file patterns');
    console.log('');
    console.log('Examples:');
    console.log('  bun unused-imports-cleanup.ts test src/utils/helpers.ts');
    console.log('  bun unused-imports-cleanup.ts patterns "src/**/*.ts"');
    process.exit(1);
  }

  const command = args[0];
  
  try {
    if (command === 'test' && args[1]) {
      await cleaner.testOnSingleFile(args[1]);
    } else if (command === 'apply') {
      await cleaner.applyToAllFiles();
      cleaner.generateReport();
    } else if (command === 'patterns') {
      const patterns = args.slice(1);
      if (patterns.length === 0) {
        console.log('Error: No patterns provided');
        process.exit(1);
      }
      await cleaner.processFilePatterns(patterns);
      cleaner.generateReport();
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

export default EnhancedUnusedImportsCleaner; 
