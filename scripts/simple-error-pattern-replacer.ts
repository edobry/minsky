#!/usr/bin/env bun

/**
 * Simple Error Pattern Replacer
 * 
 * This script finds and replaces all instances of:
 * `error instanceof Error ? error.message : String(error)`
 * 
 * With:
 * `getErrorMessage(error)`
 * 
 * It handles multi-line patterns and various formatting styles.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join, extname } from "path";

interface ReplaceResult {
  file: string;
  replacements: number;
  importAdded: boolean;
}

class SimpleErrorPatternReplacer {
  private readonly patterns = [
    // Standard pattern
    /error\s+instanceof\s+Error\s*\?\s*error\.message\s*:\s*String\s*\(\s*error\s*\)/g,
    
    // Patterns with different variable names
    /(\w+)\s+instanceof\s+Error\s*\?\s*\1\.message\s*:\s*String\s*\(\s*\1\s*\)/g,
  ];

  /**
   * Process all TypeScript files in a directory
   */
  async processDirectory(dirPath: string): Promise<ReplaceResult[]> {
    const results: ReplaceResult[] = [];
    const files = this.findTypeScriptFiles(dirPath);

    console.log(`🔍 Found ${files.length} TypeScript files to process`);

    for (const file of files) {
      const result = await this.processFile(file);
      if (result.replacements > 0) {
        results.push(result);
        console.log(`✅ ${file}: ${result.replacements} replacements${result.importAdded ? " + import added" : ""}`);
      }
    }

    return results;
  }

  /**
   * Process a single file
   */
  private async processFile(filePath: string): Promise<ReplaceResult> {
    const result: ReplaceResult = {
      file: filePath,
      replacements: 0,
      importAdded: false
    };

         try {
       let content = readFileSync(filePath, "utf-8") as string;
       const originalContent = content;

      // Apply all patterns
      for (const pattern of this.patterns) {
        const matches = [...content.matchAll(pattern)];
        for (const match of matches) {
          if (match[0]) {
            // For patterns with variable names, use the variable name
            const variableName = match[1] || "error";
            const replacement = `getErrorMessage(${variableName})`;
            content = content.replace(match[0], replacement);
            result.replacements++;
          }
        }
      }

      // If we made replacements, ensure import is present
      if (result.replacements > 0) {
        if (!this.hasGetErrorMessageImport(content)) {
          content = this.addGetErrorMessageImport(content, filePath);
          result.importAdded = true;
        }

        // Only write if content changed
        if (content !== originalContent) {
          writeFileSync(filePath, content, "utf-8");
        }
      }

      return result;
    } catch (error) {
      console.error(`❌ Error processing ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      return result;
    }
  }

  /**
   * Check if file already has getErrorMessage import
   */
  private hasGetErrorMessageImport(content: string): boolean {
    return /import\s*\{[^}]*getErrorMessage[^}]*\}\s*from\s*['"'][^'"]*errors[^'"]*['"]/.test(content);
  }

  /**
   * Add getErrorMessage import to file
   */
  private addGetErrorMessageImport(content: string, filePath: string): string {
    const importPath = this.calculateImportPath(filePath);
    const importStatement = `import { getErrorMessage } from "${importPath}";\n`;

    // Find the last import statement and add after it
    const lines = content.split("\n");
    let lastImportIndex = -1;

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().startsWith("import ")) {
        lastImportIndex = i;
      }
    }

    if (lastImportIndex >= 0) {
      lines.splice(lastImportIndex + 1, 0, importStatement.trim());
    } else {
      // No imports found, add at the top after any comments
      let insertIndex = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith("//") || line.startsWith("/*") || line === "" || line.startsWith("*")) {
          insertIndex = i + 1;
        } else {
          break;
        }
      }
      lines.splice(insertIndex, 0, importStatement.trim());
    }

    return lines.join("\n");
  }

  /**
   * Calculate relative import path to errors module
   */
  private calculateImportPath(filePath: string): string {
    // Count directory levels from src/
    const srcIndex = filePath.indexOf('/src/');
    if (srcIndex === -1) return "../../errors";

    const relativePath = filePath.substring(srcIndex + 5); // Remove '/src/'
    const levels = relativePath.split('/').length - 1; // -1 for the file itself
    
    return '../'.repeat(levels) + 'errors';
  }

  /**
   * Find all TypeScript files in directory
   */
  private findTypeScriptFiles(dirPath: string): string[] {
    const files: string[] = [];
    const extensions = ['.ts', '.tsx'];

    const traverse = (currentPath: string) => {
      const items = readdirSync(currentPath);
      
      for (const item of items) {
        const fullPath = join(currentPath, item);
        const stat = statSync(fullPath);
        
        if (stat.isDirectory()) {
          // Skip node_modules and other irrelevant directories
          if (!['node_modules', '.git', 'dist', 'build'].includes(item)) {
            traverse(fullPath);
          }
        } else if (extensions.includes(extname(item))) {
          files.push(fullPath);
        }
      }
    };

    traverse(dirPath);
    return files;
  }
}

async function main() {
  console.log("🚀 Starting Simple Error Pattern Replacer");
  
  const replacer = new SimpleErrorPatternReplacer();
  const results = await replacer.processDirectory("src/");
  
  const totalReplacements = results.reduce((sum, r) => sum + r.replacements, 0);
  const filesModified = results.length;
  
  console.log(`\n📊 Summary:`);
  console.log(`   Files modified: ${filesModified}`);
  console.log(`   Total replacements: ${totalReplacements}`);
  
  if (totalReplacements > 0) {
    console.log(`\n✅ Successfully replaced ${totalReplacements} error patterns!`);
  } else {
    console.log(`\n✨ No error patterns found to replace`);
  }
}

if (import.meta.main) {
  main().catch(console.error);
} 
