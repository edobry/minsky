#!/usr/bin/env bun

/**
 * Directory-Aware Import Path Fixer
 *
 * Fixes incorrect relative import paths by calculating the correct paths
 * based on actual directory structure, not pattern matching.
 *
 * This prevents the issues we had with the previous codemod that incorrectly
 * changed paths in some directories.
 */

import { Project, SourceFile, ImportDeclaration, SyntaxKind } from "ts-morph";
import { CodemodBase, CodemodOptions, ASTUtils, CodemodIssue } from "./utils/codemod-framework";
import * as path from "path";

interface ImportPathFix {
  line: number;
  column: number;
  originalPath: string;
  correctPath: string;
  description: string;
}

export class DirectoryAwareImportPathFixer extends CodemodBase {
  private readonly targetDirectories = ['errors', 'schemas', 'utils'];

  constructor(options: CodemodOptions = {}) {
    super({
      includePatterns: [
        "src/**/*.ts"
      ],
      excludePatterns: ["**/*.test.ts", "**/*.d.ts"],
      ...options
    });
  }

  protected findIssues(): void {
    this.log("🔍 Analyzing import paths based on directory structure...");

    const sourceFiles = this.project.getSourceFiles();
    this.metrics.filesProcessed = sourceFiles.length;

    sourceFiles.forEach(sourceFile => {
      this.analyzeSourceFile(sourceFile);
    });

    this.log(`Found ${this.issues.length} import path issues to fix`);
  }

  private analyzeSourceFile(sourceFile: SourceFile): void {
    const filePath = sourceFile.getFilePath();

    // Convert to relative path from project root
    const relativePath = path.relative(process.cwd(), filePath);
    this.log(`  📄 Analyzing ${relativePath}`);

    const importDeclarations = ASTUtils.findImportDeclarations(sourceFile);

    importDeclarations.forEach((importDecl: ImportDeclaration) => {
      this.analyzeImportDeclaration(importDecl, relativePath, filePath);
    });
  }

  private analyzeImportDeclaration(importDecl: ImportDeclaration, relativePath: string, fullPath: string): void {
    const moduleSpecifier = importDecl.getModuleSpecifierValue();

    const fix = this.shouldFixImportPath(relativePath, moduleSpecifier);
    if (fix.shouldFix && fix.correctPath) {
      const { line, column } = this.getLineAndColumn(importDecl);

      this.addIssue({
        file: fullPath,
        line,
        column,
        description: `Fix import path: "${moduleSpecifier}" should be "${fix.correctPath}"`,
        context: this.getContext(importDecl),
        type: "incorrect-import-path",
        original: moduleSpecifier,
        suggested: fix.correctPath
      });
    }
  }

  private shouldFixImportPath(filePath: string, currentImport: string): { shouldFix: boolean; correctPath?: string } {
    // Check if this is an import we need to fix
    const importPattern = new RegExp('^(\\.\\./)+([a-zA-Z]+)(?:/.*)?$');
    const match = currentImport.match(importPattern);
    if (!match) return { shouldFix: false };

    const [, , targetDir] = match;
    if (!this.targetDirectories.includes(targetDir)) return { shouldFix: false };

    // Calculate correct path based on directory structure
    const fromDir = path.dirname(filePath);
    const toDir = path.join('src', targetDir);
    const correctRelativePath = path.relative(fromDir, toDir).replace(/\\/g, '/');

    // Preserve any subpath from the original import
    const subPathPattern = new RegExp('^(\\.\\./)+[a-zA-Z]+');
    const subPath = currentImport.replace(subPathPattern, '');
    const correctPath = correctRelativePath + subPath;

    return {
      shouldFix: currentImport !== correctPath,
      correctPath: correctPath
    };
  }

  protected fixIssues(): void {
    this.log("🔧 Applying directory-aware import path fixes...");

    this.issues.forEach(issue => {
      if (issue.type === "incorrect-import-path" && issue.suggested) {
        this.fixImportPath(issue);
      }
    });

    this.calculateSuccessRate();
    this.log(`✅ Fixed ${this.metrics.issuesFixed}/${this.metrics.issuesFound} import path issues`);
  }

  private fixImportPath(issue: CodemodIssue): void {
    try {
      const sourceFile = this.project.getSourceFile(issue.file);
      if (!sourceFile) {
        this.metrics.errors.push(`Source file not found: ${issue.file}`);
        return;
      }

      const importDeclarations = ASTUtils.findImportDeclarations(sourceFile);

      for (const importDecl of importDeclarations) {
        const moduleSpecifier = importDecl.getModuleSpecifierValue();

        if (moduleSpecifier === issue.original) {
          // Replace the module specifier
          importDecl.setModuleSpecifier(issue.suggested!);

          this.recordFix(issue.file);
          this.log(`    ✓ Fixed: ${issue.original} → ${issue.suggested}`);
          break;
        }
      }
    } catch (error) {
      this.metrics.errors.push(`Failed to fix ${issue.file}:${issue.line} - ${error}`);
    }
  }

  /**
   * Public method for testing: analyze import issues in a specific file
   */
  public analyzeImportIssues(filePath: string, sourceFile: SourceFile): ImportPathFix[] {
    const issues: ImportPathFix[] = [];
    const importDeclarations = ASTUtils.findImportDeclarations(sourceFile);

    importDeclarations.forEach((importDecl: ImportDeclaration) => {
      const moduleSpecifier = importDecl.getModuleSpecifierValue();

      const fix = this.shouldFixImportPath(filePath, moduleSpecifier);
      if (fix.shouldFix && fix.correctPath) {
        const { line, column } = this.getLineAndColumn(importDecl);

        issues.push({
          line,
          column,
          originalPath: moduleSpecifier,
          correctPath: fix.correctPath,
          description: `Fix import path based on directory structure`
        });
      }
    });

    return issues;
  }
}

/**
 * Main execution function
 */
async function main() {
  const options: CodemodOptions = {
    dryRun: process.argv.includes('--dry-run'),
    verbose: process.argv.includes('--verbose') || process.argv.includes('-v')
  };

  const fixer = new DirectoryAwareImportPathFixer(options);

  try {
    await fixer.execute();
  } catch (error) {
    console.error("❌ Codemod execution failed:", error);
    process.exit(1);
  }
}

// Execute if run directly
if (import.meta.main) {
  main();
}

export default DirectoryAwareImportPathFixer;
