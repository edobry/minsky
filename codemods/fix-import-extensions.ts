#!/usr/bin/env bun

/**
 * AST-Based Import Extension Fixer
 *
 * This codemod removes .js and .ts extensions from local import and export statements
 * following Bun-native style guidelines. Uses AST-based approach for safe, precise
 * transformations without breaking existing functionality.
 *
 * Follows the codemod framework patterns established in Task #178.
 */

import { Project, SourceFile, Node, SyntaxKind, ImportDeclaration, ExportDeclaration } from "ts-morph";
import { globSync } from "glob";

interface ImportFixResult {
  file: string;
  importsFixed: number;
  exportsFixed: number;
  errors: string[];
}

class ImportExtensionFixer {
  private project: Project;
  private results: ImportFixResult[] = [];
  private totalImportsFixed = 0;
  private totalExportsFixed = 0;
  private totalErrors = 0;

  constructor() {
    this.project = new Project({
      tsConfigFilePath: "./tsconfig.json",
      skipAddingFilesFromTsConfig: true,
    });
  }

  /**
   * Main execution method
   */
  async execute(): Promise<void> {
    console.log("🚀 Starting import extension fixer...");

    // Add source files
    const patterns = [
      "src/**/*.ts",
      "src/**/*.tsx",
      "src/**/*.js"
    ];

    const exclude = [
      "**/*.d.ts",
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**"
    ];

    const files = patterns.flatMap(pattern =>
      globSync(pattern, { ignore: exclude })
    );

    console.log(`📁 Found ${files.length} files to process`);

    this.project.addSourceFilesAtPaths(files);

    // Process each file
    for (const sourceFile of this.project.getSourceFiles()) {
      this.processFile(sourceFile);
    }

    // Save changes
    await this.saveChanges();

    // Generate report
    this.generateReport();
  }

  /**
   * Process a single source file
   */
  private processFile(sourceFile: SourceFile): void {
    const filePath = sourceFile.getFilePath();
    const result: ImportFixResult = {
      file: filePath,
      importsFixed: 0,
      exportsFixed: 0,
      errors: []
    };

    try {
      // Fix import declarations
      const importDeclarations = sourceFile.getImportDeclarations();
      for (const importDecl of importDeclarations) {
        if (this.fixImportDeclaration(importDecl)) {
          result.importsFixed++;
        }
      }

      // Fix export declarations
      const exportDeclarations = sourceFile.getExportDeclarations();
      for (const exportDecl of exportDeclarations) {
        if (this.fixExportDeclaration(exportDecl)) {
          result.exportsFixed++;
        }
      }

      this.results.push(result);
      this.totalImportsFixed += result.importsFixed;
      this.totalExportsFixed += result.exportsFixed;

    } catch (error) {
      result.errors.push(`Error processing file: ${error}`);
      this.totalErrors++;
    }
  }

  /**
   * Fix import declaration by removing .js/.ts extensions from local paths
   */
  private fixImportDeclaration(importDecl: ImportDeclaration): boolean {
    const moduleSpecifier = importDecl.getModuleSpecifierValue();

    // Only process local imports (starting with ./ or ../)
    if (!moduleSpecifier.startsWith('./') && !moduleSpecifier.startsWith('../')) {
      return false;
    }

    // Check if it has .js or .ts extension
    const hasJsExtension = moduleSpecifier.endsWith('.js');
    const hasTsExtension = moduleSpecifier.endsWith('.ts');

    if (hasJsExtension || hasTsExtension) {
      // Remove the extension
      const newModuleSpecifier = moduleSpecifier.replace(/\.(js|ts)$/, '');
      importDecl.setModuleSpecifier(newModuleSpecifier);
      return true;
    }

    return false;
  }

  /**
   * Fix export declaration by removing .js/.ts extensions from local paths
   */
  private fixExportDeclaration(exportDecl: ExportDeclaration): boolean {
    const moduleSpecifier = exportDecl.getModuleSpecifierValue();

    // Skip exports without module specifier
    if (!moduleSpecifier) {
      return false;
    }

    // Only process local exports (starting with ./ or ../)
    if (!moduleSpecifier.startsWith('./') && !moduleSpecifier.startsWith('../')) {
      return false;
    }

    // Check if it has .js or .ts extension
    const hasJsExtension = moduleSpecifier.endsWith('.js');
    const hasTsExtension = moduleSpecifier.endsWith('.ts');

    if (hasJsExtension || hasTsExtension) {
      // Remove the extension
      const newModuleSpecifier = moduleSpecifier.replace(/\.(js|ts)$/, '');
      exportDecl.setModuleSpecifier(newModuleSpecifier);
      return true;
    }

    return false;
  }

    /**
   * Save changes to disk
   */
  private async saveChanges(): Promise<void> {
    console.log("💾 Saving changes...");

    const sourceFiles = this.project.getSourceFiles();
    let savedCount = 0;

    for (const sourceFile of sourceFiles) {
      if (sourceFile.wasForgotten()) {
        continue;
      }

      try {
        await sourceFile.save();
        savedCount++;
      } catch (error) {
        console.error(`❌ Failed to save ${sourceFile.getFilePath()}: ${error}`);
        this.totalErrors++;
      }
    }

    console.log(`✅ Saved ${savedCount} files`);
  }

  /**
   * Generate execution report
   */
  private generateReport(): void {
    console.log("\n📊 Import Extension Fixer Report");
    console.log("================================");

    const totalFiles = this.results.length;
    const filesWithChanges = this.results.filter(r => r.importsFixed > 0 || r.exportsFixed > 0).length;

    console.log(`Files processed: ${totalFiles}`);
    console.log(`Files modified: ${filesWithChanges}`);
    console.log(`Import statements fixed: ${this.totalImportsFixed}`);
    console.log(`Export statements fixed: ${this.totalExportsFixed}`);
    console.log(`Total changes: ${this.totalImportsFixed + this.totalExportsFixed}`);

    if (this.totalErrors > 0) {
      console.log(`❌ Errors encountered: ${this.totalErrors}`);
    }

    // Show files with changes
    if (filesWithChanges > 0) {
      console.log("\n🔧 Files with changes:");
      for (const result of this.results) {
        if (result.importsFixed > 0 || result.exportsFixed > 0) {
          const changes = [];
          if (result.importsFixed > 0) changes.push(`${result.importsFixed} imports`);
          if (result.exportsFixed > 0) changes.push(`${result.exportsFixed} exports`);
          console.log(`  ${result.file}: ${changes.join(', ')}`);
        }
      }
    }

    console.log("\n✅ Import extension fixing completed!");
  }
}

// Execute if run directly
if (import.meta.main) {
  const fixer = new ImportExtensionFixer();
  fixer.execute().catch(console.error);
}

export { ImportExtensionFixer };
