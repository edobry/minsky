#!/usr/bin/env bun

/**
 * Global Import Path Fixer
 *
 * Fixes incorrect relative import paths throughout the entire codebase.
 *
 * Issues addressed across all src/domain/ subdirectories:
 * - "../../errors" should be "../../../errors"
 * - "../../schemas" should be "../../../schemas"
 * - "../../utils" should be "../../../utils"
 *
 * This codemod uses AST-based transformations for safe, precise modifications.
 */

import { Project, SourceFile, ImportDeclaration, SyntaxKind } from "ts-morph";
import { CodemodBase, CodemodOptions, ASTUtils, CodemodIssue } from "./utils/codemod-framework";

interface ImportPathMapping {
  oldPathPattern: string;
  newPathPattern: string;
  description: string;
}

interface ImportIssue {
  line: number;
  column: number;
  originalPath: string;
  suggestedPath: string;
  description: string;
}

export class GlobalImportPathFixer extends CodemodBase {
  private readonly pathMappings: ImportPathMapping[] = [
    {
      oldPathPattern: "../../errors",
      newPathPattern: "../../../errors",
      description: "Fix errors import path depth"
    },
    {
      oldPathPattern: "../../schemas",
      newPathPattern: "../../../schemas",
      description: "Fix schemas import path depth"
    },
    {
      oldPathPattern: "../../utils",
      newPathPattern: "../../../utils",
      description: "Fix utils import path depth"
    }
  ];

  constructor(options: CodemodOptions = {}) {
    super({
      includePatterns: [
        "src/domain/**/*.ts",
        "src/adapters/**/*.ts",
        "src/commands/**/*.ts",
        "src/mcp/**/*.ts"
      ],
      excludePatterns: ["**/*.test.ts", "**/*.d.ts"],
      ...options
    });
  }

  protected findIssues(): void {
    this.log("🔍 Analyzing import declarations throughout the codebase...");

    const sourceFiles = this.project.getSourceFiles();
    this.metrics.filesProcessed = sourceFiles.length;

    sourceFiles.forEach(sourceFile => {
      this.analyzeSourceFile(sourceFile);
    });

    this.log(`Found ${this.issues.length} import path issues to fix`);
  }

  private analyzeSourceFile(sourceFile: SourceFile): void {
    const filePath = sourceFile.getFilePath();
    this.log(`  📄 Analyzing ${filePath}`);

    const importDeclarations = ASTUtils.findImportDeclarations(sourceFile);

    importDeclarations.forEach((importDecl: ImportDeclaration) => {
      this.analyzeImportDeclaration(importDecl, filePath);
    });
  }

  private analyzeImportDeclaration(importDecl: ImportDeclaration, filePath: string): void {
    const moduleSpecifier = importDecl.getModuleSpecifierValue();

    const mapping = this.pathMappings.find(m =>
      moduleSpecifier === m.oldPathPattern ||
      moduleSpecifier.startsWith(m.oldPathPattern + "/") ||
      moduleSpecifier.startsWith(m.oldPathPattern + "/index")
    );

    if (mapping) {
      const { line, column } = this.getLineAndColumn(importDecl);

      this.addIssue({
        file: filePath,
        line,
        column,
        description: `${mapping.description}: "${moduleSpecifier}" should be updated`,
        context: this.getContext(importDecl),
        type: "incorrect-import-path",
        original: moduleSpecifier,
        suggested: this.buildNewPath(moduleSpecifier, mapping)
      });
    }
  }

  private buildNewPath(currentPath: string, mapping: ImportPathMapping): string {
    if (currentPath === mapping.oldPathPattern) {
      return mapping.newPathPattern;
    }

    // Handle cases like "../../errors/index" or "../../utils/logger"
    if (currentPath.startsWith(mapping.oldPathPattern + "/")) {
      const suffix = currentPath.substring(mapping.oldPathPattern.length);
      return mapping.newPathPattern + suffix;
    }

    return currentPath;
  }

  protected fixIssues(): void {
    this.log("🔧 Applying import path fixes...");

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
  public analyzeImportIssues(sourceFile: SourceFile): ImportIssue[] {
    const issues: ImportIssue[] = [];
    const importDeclarations = ASTUtils.findImportDeclarations(sourceFile);

    importDeclarations.forEach((importDecl: ImportDeclaration) => {
      const moduleSpecifier = importDecl.getModuleSpecifierValue();

      const mapping = this.pathMappings.find(m =>
        moduleSpecifier === m.oldPathPattern ||
        moduleSpecifier.startsWith(m.oldPathPattern + "/") ||
        moduleSpecifier.startsWith(m.oldPathPattern + "/index")
      );

      if (mapping) {
        const { line, column } = this.getLineAndColumn(importDecl);

        issues.push({
          line,
          column,
          originalPath: moduleSpecifier,
          suggestedPath: this.buildNewPath(moduleSpecifier, mapping),
          description: mapping.description
        });
      }
    });

    return issues;
  }

  /**
   * Public method for testing: fix import paths in a specific file
   */
  public fixImportPathsInFile(sourceFile: SourceFile): void {
    const importDeclarations = ASTUtils.findImportDeclarations(sourceFile);

    importDeclarations.forEach((importDecl: ImportDeclaration) => {
      const moduleSpecifier = importDecl.getModuleSpecifierValue();

      const mapping = this.pathMappings.find(m =>
        moduleSpecifier === m.oldPathPattern ||
        moduleSpecifier.startsWith(m.oldPathPattern + "/") ||
        moduleSpecifier.startsWith(m.oldPathPattern + "/index")
      );

      if (mapping) {
        const newPath = this.buildNewPath(moduleSpecifier, mapping);
        importDecl.setModuleSpecifier(newPath);
      }
    });
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

  const fixer = new GlobalImportPathFixer(options);

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

export default GlobalImportPathFixer;
