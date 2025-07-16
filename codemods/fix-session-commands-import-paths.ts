#!/usr/bin/env bun

/**
 * Session Commands Import Path Fixer
 *
 * Fixes incorrect relative import paths in src/domain/session/commands/ directory.
 *
 * Issues addressed:
 * - "../../errors" should be "../../../errors"
 * - "../../schemas" should be "../../../schemas"
 * - "../../utils" should be "../../../utils"
 *
 * This codemod uses AST-based transformations for safe, precise modifications.
 */

import { Project, SourceFile, ImportDeclaration, SyntaxKind } from "ts-morph";
import { CodemodBase, CodemodOptions, ASTUtils, CodemodIssue } from "./utils/codemod-framework";

interface ImportPathMapping {
  oldPath: string;
  newPath: string;
  description: string;
}

export class SessionCommandsImportPathFixer extends CodemodBase {
  private readonly pathMappings: ImportPathMapping[] = [
    {
      oldPath: "../../errors",
      newPath: "../../../errors",
      description: "Fix errors import path depth"
    },
    {
      oldPath: "../../errors/index",
      newPath: "../../../errors",
      description: "Fix errors/index import path depth"
    },
    {
      oldPath: "../../schemas",
      newPath: "../../../schemas",
      description: "Fix schemas import path depth"
    },
    {
      oldPath: "../../utils",
      newPath: "../../../utils",
      description: "Fix utils import path depth"
    }
  ];

  constructor(options: CodemodOptions = {}) {
    super({
      includePatterns: ["src/domain/session/commands/**/*.ts"],
      excludePatterns: ["**/*.test.ts", "**/*.d.ts"],
      ...options
    });
  }

  protected findIssues(): void {
    this.log("🔍 Analyzing import declarations in session commands...");

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
      moduleSpecifier === m.oldPath || moduleSpecifier.startsWith(m.oldPath + "/")
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
    if (currentPath === mapping.oldPath) {
      return mapping.newPath;
    }

    // Handle cases like "../../errors/index" or "../../utils/logger"
    if (currentPath.startsWith(mapping.oldPath + "/")) {
      const suffix = currentPath.substring(mapping.oldPath.length);
      return mapping.newPath + suffix;
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
}

/**
 * Main execution function
 */
async function main() {
  const options: CodemodOptions = {
    dryRun: process.argv.includes('--dry-run'),
    verbose: process.argv.includes('--verbose') || process.argv.includes('-v')
  };

  const fixer = new SessionCommandsImportPathFixer(options);

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

export default SessionCommandsImportPathFixer;
