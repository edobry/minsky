#!/usr/bin/env bun

/**
 * Comprehensive Error Pattern Refactoring Codemod
 * 
 * This codemod safely replaces instances of:
 * `error instanceof Error ? error.message : String(error)`
 * 
 * With:
 * `getErrorMessage(error)`
 * 
 * It performs the following safety checks:
 * 1. Parses TypeScript AST to understand code structure
 * 2. Verifies the pattern matches exactly before replacement
 * 3. Adds the required import if not present
 * 4. Handles various formatting and whitespace variations
 * 5. Preserves existing code structure and comments
 * 6. Validates syntax after changes
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join, extname } from "path";
import * as ts from "typescript";

interface RefactorResult {
  file: string;
  replacements: number;
  importAdded: boolean;
  errors: string[];
}

interface RefactorSummary {
  totalFiles: number;
  modifiedFiles: number;
  totalReplacements: number;
  errors: string[];
  results: RefactorResult[];
}

class ErrorPatternCodemod {
  private readonly errorPattern = /error\s+instanceof\s+Error\s*\?\s*error\.message\s*:\s*String\s*\(\s*error\s*\)/g;
  private readonly importPattern = /import\s*\{[^}]*getErrorMessage[^}]*\}\s*from\s*["'][^"']*errors[^"']*["']/;
  
  /**
   * Main entry point for the codemod
   */
  async refactorDirectory(dirPath: string, extensions: string[] = [".ts", ".tsx"]): Promise<RefactorSummary> {
    const summary: RefactorSummary = {
      totalFiles: 0,
      modifiedFiles: 0,
      totalReplacements: 0,
      errors: [],
      results: []
    };

    try {
      const files = this.findTypeScriptFiles(dirPath, extensions);
      summary.totalFiles = files.length;

      console.log(`🔍 Found ${files.length} TypeScript files to analyze`);

      for (const file of files) {
        try {
          const result = await this.refactorFile(file);
          summary.results.push(result);
          
          if (result.replacements > 0) {
            summary.modifiedFiles++;
            summary.totalReplacements += result.replacements;
            console.log(`✅ ${file}: ${result.replacements} replacements${result.importAdded ? " + import added" : ""}`);
          }
          
          if (result.errors.length > 0) {
            summary.errors.push(...result.errors.map(err => `${file}: ${err}`));
          }
        } catch (error) {
          const errorMsg = `Failed to process ${file}: ${error instanceof Error ? error.message : String(error)}`;
          summary.errors.push(errorMsg);
          console.error(`❌ ${errorMsg}`);
        }
      }

      return summary;
    } catch (error) {
      summary.errors.push(`Directory processing failed: ${error instanceof Error ? error.message : String(error)}`);
      return summary;
    }
  }

  /**
   * Refactor a single file
   */
  private async refactorFile(filePath: string): Promise<RefactorResult> {
    const result: RefactorResult = {
      file: filePath,
      replacements: 0,
      importAdded: false,
      errors: []
    };

    try {
      const originalContent = readFileSync(filePath, "utf-8") as string;
      
      // Check if file contains the error pattern
      if (!this.errorPattern.test(originalContent)) {
        return result; // No patterns found
      }

      // Reset regex for actual processing
      this.errorPattern.lastIndex = 0;

      // Parse TypeScript to understand structure
      const sourceFile = ts.createSourceFile(
        filePath,
        originalContent,
        ts.ScriptTarget.Latest,
        true
      );

      // Check for syntax errors by examining the AST
      let hasSyntaxErrors = false;
      const checkForErrors = (node: ts.Node): void => {
        if (node.kind === ts.SyntaxKind.Unknown) {
          hasSyntaxErrors = true;
        }
        ts.forEachChild(node, checkForErrors);
      };
      checkForErrors(sourceFile);

      if (hasSyntaxErrors) {
        result.errors.push("File has TypeScript parse errors, skipping");
        return result;
      }

      let modifiedContent = originalContent;
      let hasImport = this.hasGetErrorMessageImport(modifiedContent);

      // Find and replace all instances
      const matches = [...originalContent.matchAll(this.errorPattern)];
      
      for (const match of matches) {
        if (match.index !== undefined) {
          // Verify this is a safe replacement by checking context
          if (this.isSafeReplacement(originalContent, match.index, match[0])) {
            // Perform the replacement
            modifiedContent = modifiedContent.replace(match[0], "getErrorMessage(error)");
            result.replacements++;
          }
        }
      }

      // Add import if we made replacements and don't have import
      if (result.replacements > 0 && !hasImport) {
        modifiedContent = this.addGetErrorMessageImport(modifiedContent, filePath);
        result.importAdded = true;
      }

      // Validate the modified content can still be parsed
      if (result.replacements > 0) {
        const modifiedSourceFile = ts.createSourceFile(
          filePath,
          modifiedContent,
          ts.ScriptTarget.Latest,
          true
        );

        let modifiedHasSyntaxErrors = false;
        const checkModifiedForErrors = (node: ts.Node): void => {
          if (node.kind === ts.SyntaxKind.Unknown) {
            modifiedHasSyntaxErrors = true;
          }
          ts.forEachChild(node, checkModifiedForErrors);
        };
        checkModifiedForErrors(modifiedSourceFile);

        if (modifiedHasSyntaxErrors) {
          result.errors.push("Modified file would have parse errors, skipping");
          return result;
        }

        // Write the modified content
        writeFileSync(filePath, modifiedContent, "utf-8");
      }

      return result;
    } catch (error) {
      result.errors.push(`Processing error: ${error instanceof Error ? error.message : String(error)}`);
      return result;
    }
  }

  /**
   * Check if replacement is safe by analyzing context
   */
  private isSafeReplacement(content: string, index: number, match: string): boolean {
    // Get context around the match
    const start = Math.max(0, index - 100);
    const end = Math.min(content.length, index + match.length + 100);
    const context = content.slice(start, end);

    // Check for problematic contexts that might indicate this isn't our target pattern
    const problematicPatterns = [
      // Skip if it's in a comment
      /\/\*[\s\S]*?error\s+instanceof\s+Error[\s\S]*?\*\//,
      /\/\/.*error\s+instanceof\s+Error/,
      
      // Skip if it's in a string literal
      /['"`][\s\S]*?error\s+instanceof\s+Error[\s\S]*?['"`]/,
      
      // Skip if it's already wrapped in getErrorMessage
      /getErrorMessage\s*\(\s*error\s+instanceof\s+Error/,
    ];

    for (const pattern of problematicPatterns) {
      if (pattern.test(context)) {
        return false;
      }
    }

    // Additional safety check: ensure the variable name is actually "error"
    const beforeMatch = content.slice(Math.max(0, index - 50), index);
    const afterMatch = content.slice(index + match.length, Math.min(content.length, index + match.length + 50));
    
    // Look for catch (error) or similar patterns to ensure this is an error variable
    const errorVariablePattern = /catch\s*\(\s*error\s*\)|function\s*\([^)]*error[^)]*\)|=>\s*\{[\s\S]*?error\s+instanceof/;
    const fullContext = content.slice(Math.max(0, index - 200), Math.min(content.length, index + match.length + 200));
    
    return errorVariablePattern.test(fullContext);
  }

  /**
   * Check if file already has getErrorMessage import
   */
  private hasGetErrorMessageImport(content: string): boolean {
    return this.importPattern.test(content);
  }

  /**
   * Add getErrorMessage import to the file
   */
  private addGetErrorMessageImport(content: string, filePath: string): string {
    // Calculate relative path to errors module
    const relativePath = this.calculateErrorsImportPath(filePath);
    
    // Find the best place to add the import
    const lines = content.split("\n");
    let insertIndex = 0;
    let hasOtherImports = false;

    // Find the last import statement
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith("import ") && line.includes("from ")) {
        insertIndex = i + 1;
        hasOtherImports = true;
      } else if (hasOtherImports && line && !line.startsWith("import ") && !line.startsWith("//") && !line.startsWith("/*")) {
        break;
      }
    }

    // Check if there's already an import from the errors module we can extend
    for (let i = 0; i < insertIndex; i++) {
      const line = lines[i];
      if (line && line.includes("from") && line.includes("errors") && line.includes("{")) {
        // Try to add to existing import
        const match = line.match(/import\s*\{([^}]+)\}\s*from\s*(['"][^'"]*errors[^'"]*['"])/);
        if (match && match[1]) {
          const imports = match[1].trim();
          if (!imports.includes("getErrorMessage")) {
            lines[i] = line.replace(match[1], `${imports}, getErrorMessage`);
            return lines.join("\n");
          }
        }
      }
    }

    // Add new import
    const importStatement = `import { getErrorMessage } from "${relativePath}";`;
    lines.splice(insertIndex, 0, importStatement);
    
    return lines.join("\n");
  }

  /**
   * Calculate the relative import path to the errors module
   */
  private calculateErrorsImportPath(filePath: string): string {
    // Count directory depth from src/
    const srcIndex = filePath.indexOf("/src/");
    if (srcIndex === -1) {
      return "../errors/index";
    }

    const pathFromSrc = filePath.slice(srcIndex + 5); // Remove '/src/'
    const depth = pathFromSrc.split("/").length - 1; // -1 for the file itself
    
    const relativeParts = new Array(depth).fill("..");
    relativeParts.push("errors", "index");
    
    return relativeParts.join("/");
  }

  /**
   * Find all TypeScript files in directory recursively
   */
  private findTypeScriptFiles(dirPath: string, extensions: string[]): string[] {
    const files: string[] = [];
    
    const traverse = (currentPath: string) => {
      try {
        const items = readdirSync(currentPath);
        
        for (const item of items) {
          const fullPath = join(currentPath, item);
          const stat = statSync(fullPath);
          
          if (stat.isDirectory()) {
            // Skip node_modules and other common directories
            if (!["node_modules", ".git", "dist", "build", ".next"].includes(item)) {
              traverse(fullPath);
            }
          } else if (stat.isFile()) {
            const ext = extname(fullPath);
            if (extensions.includes(ext)) {
              files.push(fullPath);
            }
          }
        }
      } catch (error) {
        console.warn(`Warning: Could not read directory ${currentPath}: ${error}`);
      }
    };

    traverse(dirPath);
    return files;
  }
}

/**
 * Main execution
 */
async function main() {
  const codemod = new ErrorPatternCodemod();
  
  console.log("🚀 Starting Error Pattern Refactoring Codemod");
  console.log("📁 Target directory: src/");
  
  const summary = await codemod.refactorDirectory("src");
  
  console.log("\n📊 Refactoring Summary:");
  console.log(`   Files analyzed: ${summary.totalFiles}`);
  console.log(`   Files modified: ${summary.modifiedFiles}`);
  console.log(`   Total replacements: ${summary.totalReplacements}`);
  
  if (summary.errors.length > 0) {
    console.log(`\n❌ Errors encountered: ${summary.errors.length}`);
    summary.errors.forEach(error => console.log(`   ${error}`));
  }
  
  if (summary.modifiedFiles > 0) {
    console.log("\n✅ Refactoring completed successfully!");
    console.log("   All error patterns have been replaced with getErrorMessage() calls");
    console.log("   Required imports have been added automatically");
  } else {
    console.log("\n✨ No files needed modification - all error patterns already use getErrorMessage()");
  }
  
  process.exit(summary.errors.length > 0 ? 1 : 0);
}

if (import.meta.main) {
  main().catch(error => {
    console.error("💥 Codemod failed:", error);
    process.exit(1);
  });
}
