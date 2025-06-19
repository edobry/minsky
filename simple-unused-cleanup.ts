#!/usr/bin/env bun
/**
 * Simple script to remove specific unused imports based on ESLint output
 * This targets the exact patterns ESLint reports as unused
 */

import { readFileSync, writeFileSync } from "fs";

interface FixTarget {
  file: string;
  unusedImports: string[];
}

// Known unused imports from ESLint output analysis
const TARGETS: FixTarget[] = [
  {
    file: "src/adapters/__tests__/integration/rules.test.ts",
    unusedImports: ["RuleService", "createMockObject"]
  },
  {
    file: "src/adapters/__tests__/integration/tasks-mcp.test.ts", 
    unusedImports: ["test"]
  },
  {
    file: "src/domain/tasks.test.ts",
    unusedImports: ["resolveRepoPath", "RepoResolutionOptions"]
  },
  {
    file: "src/domain/storage/json-file-storage.ts",
    unusedImports: ["join"]
  },
  {
    file: "codemods/remove-unused-imports.ts",
    unusedImports: ["SourceFile", "ImportDeclaration", "VariableDeclaration", "readFileSync", "writeFileSync", "join"]
  }
];

/**
 * Remove specific unused imports from a TypeScript file
 */
function cleanupFile(target: FixTarget): { success: boolean; removedCount: number; error?: string } {
  try {
    const content = readFileSync(target.file, "utf-8");
    let lines = content.split("\n");
    let removedCount = 0;
    
    // Process each import line
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      if (!line.trim().startsWith("import ")) continue;
      
      // Handle named imports: import { a, b, c } from "module"
      if (line.includes("import {")) {
        const match = line.match(/import \{([^}]+)\} from (.+)/);
        if (match) {
          const importList = match[1];
          const moduleSpec = match[2];
          
          // Split imports and filter out unused ones
          const imports = importList.split(",").map(imp => imp.trim());
          const usedImports = imports.filter(imp => {
            const cleanName = imp.includes(" as ") ? imp.split(" as ")[1].trim() : imp.trim();
            return !target.unusedImports.includes(cleanName);
          });
          
          if (usedImports.length === 0) {
            // Remove entire import line
            lines[i] = "";
            removedCount += imports.length;
          } else if (usedImports.length < imports.length) {
            // Update line with only used imports
            lines[i] = `import { ${usedImports.join(", ")} } from ${moduleSpec}`;
            removedCount += (imports.length - usedImports.length);
          }
        }
      }
      
      // Handle type imports: import type { Type1, Type2 } from "module"
      else if (line.includes("import type {")) {
        const match = line.match(/import type \{([^}]+)\} from (.+)/);
        if (match) {
          const typeList = match[1];
          const moduleSpec = match[2];
          
          const types = typeList.split(",").map(t => t.trim());
          const usedTypes = types.filter(type => !target.unusedImports.includes(type));
          
          if (usedTypes.length === 0) {
            lines[i] = "";
            removedCount += types.length;
          } else if (usedTypes.length < types.length) {
            lines[i] = `import type { ${usedTypes.join(", ")} } from ${moduleSpec}`;
            removedCount += (types.length - usedTypes.length);
          }
        }
      }
      
      // Handle default imports that are unused
      else if (line.match(/^import \w+/)) {
        const match = line.match(/^import (\w+)/);
        if (match && target.unusedImports.includes(match[1])) {
          lines[i] = "";
          removedCount++;
        }
      }
    }
    
    if (removedCount > 0) {
      // Clean up empty lines and write back
      const cleanedContent = lines
        .filter((line, index) => {
          // Remove empty lines that were import statements
          if (line.trim() === "") {
            const prevLine = lines[index - 1]?.trim();
            const nextLine = lines[index + 1]?.trim();
            // Keep empty line if it's not from removed imports
            return !(prevLine?.startsWith("import ") || nextLine?.startsWith("import "));
          }
          return true;
        })
        .join("\n");
      
      writeFileSync(target.file, cleanedContent);
    }
    
    return { success: true, removedCount };
    
  } catch (error) {
    return { success: false, removedCount: 0, error: String(error) };
  }
}

/**
 * Process all target files
 */
function main() {
  console.log("🧹 Starting targeted unused import cleanup...\n");
  
  let totalRemoved = 0;
  let processedFiles = 0;
  let errorCount = 0;
  
  for (const target of TARGETS) {
    const result = cleanupFile(target);
    
    if (result.success) {
      if (result.removedCount > 0) {
        console.log(`✅ ${target.file}: Removed ${result.removedCount} unused imports`);
        console.log(`   🗑️  ${target.unusedImports.join(", ")}`);
        totalRemoved += result.removedCount;
      } else {
        console.log(`ℹ️  ${target.file}: No matching unused imports found`);
      }
      processedFiles++;
    } else {
      console.log(`❌ ${target.file}: ${result.error}`);
      errorCount++;
    }
  }
  
  console.log(`\n📊 Summary:`);
  console.log(`✅ ${processedFiles} files processed successfully`);
  console.log(`🗑️  ${totalRemoved} unused imports removed total`);
  
  if (errorCount > 0) {
    console.log(`❌ ${errorCount} files had errors`);
  }
}

if (import.meta.main) {
  main();
} 
