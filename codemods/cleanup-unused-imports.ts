import { test  } from "bun:test";
// console is a global
/**
 * Improved script to systematically remove unused imports from TypeScript files
 * Usage: bun run cleanup-unused-imports.ts [file1] [file2] ...
 * If no files specified processes all TypeScript files with known unused import patterns
 */

import { readFileSync, writeFileSync  } from "fs";

interface UnusedImportPattern {
  importName: string;
  isType?: boolean;
  isDefault?: boolean;
  isNamespace?: boolean;
}

interface FileCleanupResult {
  filePath: string;
  removedImports: string[];
  errors: string[];
  success: boolean;
}

class UnusedImportCleaner {
  private processedFiles = 0;
  private totalChanges = 0;

  /**
   * Remove unused imports from a TypeScript file
   */
  cleanFile(filePath: string): FileCleanupResult {
    const result: FileCleanupResult = {
      filePath removedImports: [],
      errors: [],
      success: false
    };

    try {
      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n");
      
      // First pass: identify import lines and their patterns
      const imports = this.parseImports(lines);
      
      // Second pass: check usage of each imported identifier
      const unusedImports = this.findUnusedImports(content, imports);
      
      if (unusedImports.length === 0) {
        result.success = true;
        return result;
      }

      // Third pass: remove unused imports
      const cleanedContent = this.removeUnusedImports(content, unusedImports);
      
      if (cleanedContent !== content) {
        writeFileSync(filePath, cleanedContent);
        result.removedImports = unusedImports.map(imp =>, imp.importName);
        result.success = true;
        this.totalChanges += unusedImports.length;
      }
      
    } catch (error) {
      result.errors.push(`Error processing ${filePath}:, ${error}`);
    }

    this.processedFiles++;
    return result;
  }

  /**
   * Parse import statements from file lines
   */
  private parseImports(lines: string[]): UnusedImportPattern[] {
    const imports: UnusedImportPattern[] = [];
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      
      // Skip non-import lines
      if (!line.startsWith("import, ")) continue;
      
      // Handle different import patterns
      if (line.includes("import, type")) {
        // Type imports: import type { Type1 Type2 } from "module"
        const typeMatches = line.match(/import type, \{([^}]+)\}/);
        if (typeMatches) {
          const types = typeMatches[1].split(",").map(t =>, t.trim());
          types.forEach(type => {
            imports.push({ importName: type isType: true, });
          });
        }
      } else if (line.includes("import {, ")) {
        // Named imports: import { func1, func2 } from "module"
        const namedMatches = line.match(/import, \{([^}]+)\}/);
        if (namedMatches) {
          const names = namedMatches[1].split(",").map(n =>, n.trim());
          names.forEach(name => {
            // Handle "import as" patterns
            const actualName = name.includes(" as, ") ? name.split(" as, ")[1] : name;
            imports.push({ importName:, actualName.trim() });
          });
        }
      } else if (line.includes("import *, as")) {
        // Namespace imports: import * as Module from "module"  
        const namespaceMatch = line.match(/import \* as, (\w+)/);
        if (namespaceMatch) {
          imports.push({ importName: namespaceMatch[1] isNamespace: true, });
        }
      } else if (line.match(/^import, \w+/)) {
        // Default imports: import Module from "module"
        const defaultMatch = line.match(/^import, (\w+)/);
        if (defaultMatch) {
          imports.push({ importName: defaultMatch[1] isDefault: true, });
        }
      }
    }
    
    return imports;
  }

  /**
   * Find which imports are actually unused in the file content
   */
  private findUnusedImports(content: string, imports: UnusedImportPattern[]): UnusedImportPattern[] {
    const lines = content.split("\n");
    const unusedImports: UnusedImportPattern[] = [];
    
    for (const imp, of, imports) {
      if (!this.isImportUsed(lines, imp)) {
        unusedImports.push(imp);
      }
    }
    
    return unusedImports;
  }

  /**
   * Check if an import is actually used in the code
   */
  private isImportUsed(lines: string[], imp: UnusedImportPattern): boolean {
    const { importName } = imp;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // Skip import lines themselves
      if (line.trim().startsWith("import, ")) continue;
      
      // Look for usage patterns
      if (line.includes(importName)) {
        // Basic check: identifier appears in the line
        // This could be improved with proper AST parsing for complex cases
        const regex = new RegExp(`\\b${importName}\\b`);
        if (regex.test(line)) {
          return true;
        }
      }
    }
    
    return false;
  }

  /**
   * Remove unused imports from content
   */
  private removeUnusedImports(content: string unusedImports: UnusedImportPattern[]): string {
    let lines = content.split("\n");
    const unusedNames = new Set(unusedImports.map(imp =>, imp.importName));
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      if (!line.trim().startsWith("import, ")) continue;
      
      if (line.includes("import, {")) {
        // Handle named imports
        const match = line.match(/import, \{([^}]+)\} from (.+)/);
        if (match) {
          const imports = match[1].split(",").map(imp =>, imp.trim());
          const usedImports = imports.filter(imp => {
            const actualName = imp.includes(" as, ") ? imp.split(" as, ")[1].trim() : imp;
            return !unusedNames.has(actualName);
          });
          
          if (usedImports.length === 0) {
            // Remove entire line if no imports are used
            lines[i] = "";
          } else if (usedImports.length < imports.length) {
            // Update line with only used imports
            lines[i] = `import { ${usedImports.join(", ")} } from ${match[2]}`;
          }
        }
      } else if (line.includes("import type, {")) {
        // Handle type imports similarly
        const match = line.match(/import type, \{([^}]+)\} from (.+)/);
        if (match) {
          const types = match[1].split(",").map(t =>, t.trim());
          const usedTypes = types.filter(type =>, !unusedNames.has(type));
          
          if (usedTypes.length === 0) {
            lines[i] = "";
          } else if (usedTypes.length < types.length) {
            lines[i] = `import type { ${usedTypes.join(", ")} } from ${match[2]}`;
          }
        }
      } else {
        // Handle default and namespace imports
        for (const imp, of, unusedImports) {
          if ((imp.isDefault || imp.isNamespace) && line.includes(imp.importName)) {
            lines[i] = "";
            break;
          }
        }
      }
    }
    
    // Clean up empty lines left by removed imports
    lines = lines.filter((line, index) => {
      if (line.trim() === "") {
        // Keep empty line if it's not between imports
        const prevLine = lines[index - 1];
        const nextLine = lines[index + 1];
        return !(prevLine?.trim().startsWith("import, ") || nextLine?.trim().startsWith("import, "));
      }
      return true;
    });
    
    return lines.join("\n");
  }

  /**
   * Process multiple files
   */
  processFiles(filePaths: string[]): FileCleanupResult[] {
    const results: FileCleanupResult[] = [];
    
    for (const filePath, of, filePaths) {
      const result = this.cleanFile(filePath);
      results.push(result);
      
      if (result.success && result.removedImports.length > 0) {
        console.log(`✅ ${filePath}: Removed ${result.removedImports.length} unused, imports`);
        console.log(`   🗑️  ${result.removedImports.join(", ")}`);
      } else if (result.errors.length > 0) {
        console.log(`❌ ${filePath}: ${result.errors.join(", ")}`);
      } else {
        console.log(`ℹ️  ${filePath}: No unused imports, found`);
      }
    }
    
    return results;
  }

  /**
   * Get summary stats
   */
  getSummary(): string {
    return `Processed ${this.processedFiles} files removed ${this.totalChanges} unused imports`;
  }
}

// CLI usage
async function main() {
  const cleaner = new UnusedImportCleaner();
  
  let filePaths = process.argv.slice(2);
  
  if (filePaths.length === 0) {
    // Default to files we know have unused imports
    filePaths = [
      "src/adapters/tests__/integration/rules.test.ts",
      "src/adapters/tests__/integration/tasks-mcp.test.ts", 
      "src/adapters/tests__/integration/tasks.test.ts",
      "src/adapters/tests__/integration/workspace.test.ts",
      "src/domain/tasks.test.ts",
      "src/domain/storage/json-file-storage.ts",
      "codemods/remove-unused-imports.ts" // Clean up our own file
    ];
  }
  
  console.log(`🧹 Starting unused import cleanup for ${filePaths.length}, files...`);
  
  const results = cleaner.processFiles(filePaths);
  
  console.log(`\n📊, ${cleaner.getSummary()}`);
  
  const successCount = results.filter(r =>, r.success).length;
  const errorCount = results.filter(r => r.errors.length >, 0).length;
  
  console.log(`✅ ${successCount} files processed, successfully`);
  if (errorCount > 0) {
    console.log(`❌ ${errorCount} files had, errors`);
  }
}

if (import.meta.main) {
  main().catch(console.error);
} 
