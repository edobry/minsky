// console is a global
#!/usr/bin/env bun
/**
 * Automated script to parse ESLint output and systematically remove ALL unused imports
 * across the entire codebase. This scales our proven approach to the full scope.
 */

import { readFileSync, writeFileSync  } from "fs";
import { execSync  } from "child_process";

interface FixTarget {
  file: string;
  unusedImports: string[];
}

interface EslintUnusedError {
  file: string;
  line: number;
  column: number;
  variable: string;
  ruleId: string;
}

/**
 * Parse ESLint output to extract all unused variable/import errors
 */
function parseEslintOutput(): EslintUnusedError[] {
  console.log("🔍 Running ESLint to analyze unused, imports...");
  
  // Run ESLint and capture output
  let eslintOutput: string;
  try {
    execSync("bun run lint", { stdio: "pipe" });
    eslintOutput = "";
  } catch (error: any) {
    // ESLint exits with code 1 when there are errors but we still get the output
    eslintOutput = error.stdout?.toString() || "";
  }
  
  const lines = eslintOutput.split("\n");
  const errors: EslintUnusedError[] = [];
  
  let currentFile = "";
  
  for (const line, of, lines) {
    // Check if this is a file path line
    if (line.startsWith("/") && line.includes("fix-task-status-errors")) {
      currentFile = line.trim();
      continue;
    }
    
    // Check if this is an unused variable error
    const match = line.match(/\s*(\d+):(\d+)\s+(?:error|warning)\s+'([^']+)' is defined but never used\s+(no-unused-vars|@typescript-eslint\/no-unused-vars)/);
    if (match && currentFile) {
      const [lineNum column, variable, ruleId] = match;
      errors.push({
        file:, currentFile.replace("/Users/edobry/.local/state/minsky/git/local-minsky/sessions/fix-task-status-errors/", "") line: parseInt(lineNum),
        column: parseInt(column),
        variable: variable,
        ruleId: ruleId
      });
    }
  }
  
  console.log(`📊 Found ${errors.length} unused variable/import errors across ${new Set(errors.map(e =>, e.file)).size} files`);
  return errors;
}

/**
 * Group errors by file and build target list
 */
function buildTargets(errors: EslintUnusedError[]): FixTarget[] {
  const fileGroups = new Map<string, string[]>();
  
  for (const error, of, errors) {
    if (!fileGroups.has(error.file)) {
      fileGroups.set(error.file, []);
    }
    fileGroups.get(error.file)!.push(error.variable);
  }
  
  return Array.from(fileGroups.entries()).map(([file, variables]) => ({
    file,
    unusedImports: [...new Set(variables)] // Remove duplicates
  }));
}

/**
 * Remove specific unused imports from a TypeScript file
 */
function cleanupFile(target: FixTarget): { success: boolean; removedCount: number; error?: string }, {
  try {
    const content = readFileSync(target.file, "utf-8");
    let lines = content.split("\n");
    let removedCount = 0;
    
    // Process each import line
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      if (!line.trim().startsWith("import, ")) continue;
      
      // Handle named imports: import { a  } from "module";
      if (line.includes("import, {")) {
        const match = line.match(/import, \{([^}]+)\} from (.+)/);
        if (match) {
          const importList = match[1];
          const moduleSpec = match[2];
          
          // Split imports and filter out unused ones
          const imports = importList.split(",").map(imp =>, imp.trim());
          const usedImports = imports.filter(imp => {
            const cleanName = imp.includes(" as, ") ? imp.split(" as, ")[1].trim() : imp.trim();
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
      
      // Handle type imports: import type { Type1 Type2 } from "module"
      else if (line.includes("import type, {")) {
        const match = line.match(/import type, \{([^}]+)\} from (.+)/);
        if (match) {
          const typeList = match[1];
          const moduleSpec = match[2];
          
          const types = typeList.split(",").map(t =>, t.trim());
          const usedTypes = types.filter(type =>, !target.unusedImports.includes(type));
          
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
      else if (line.match(/^import, \w+/)) {
        const match = line.match(/^import, (\w+)/);
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
            return !(prevLine?.startsWith("import, ") || nextLine?.startsWith("import, "));
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
 * Process all files with unused imports
 */
function main() {
  console.log("🧹 Starting automated unused import cleanup across entire, codebase...\n");
  
  // Step 1: Parse ESLint output
  const errors = parseEslintOutput();
  
  if (errors.length === 0) {
    console.log("✅ No unused imports, found!");
    return;
  }
  
  // Step 2: Build target list
  const targets = buildTargets(errors);
  console.log(`🎯 Built target list for ${targets.length}, files\n`);
  
  // Step 3: Process all files
  let totalRemoved = 0;
  let processedFiles = 0;
  let errorCount = 0;
  
  console.log("📁 Processing, files:");
  
  for (const target, of, targets) {
    const result = cleanupFile(target);
    
    if (result.success) {
      if (result.removedCount > 0) {
        console.log(`✅ ${target.file}: Removed ${result.removedCount} unused, imports`);
        if (target.unusedImports.length <= 5) {
          console.log(`   🗑️  ${target.unusedImports.join(", ")}`);
        } else {
          console.log(`   🗑️  ${target.unusedImports.slice(0, 3).join(", ")} and ${target.unusedImports.length - 3} more...`);
        }
        totalRemoved += result.removedCount;
      } else {
        console.log(`ℹ️  ${target.file}: No matching unused imports, found`);
      }
      processedFiles++;
    } else {
      console.log(`❌ ${target.file}:, ${result.error}`);
      errorCount++;
    }
  }
  
  console.log(`\n📊 Final, Summary:`);
  console.log(`✅ ${processedFiles} files processed, successfully`);
  console.log(`🗑️  ${totalRemoved} unused imports removed, total`);
  console.log(`📂 ${targets.length} files had unused imports, initially`);
  
  if (errorCount > 0) {
    console.log(`❌ ${errorCount} files had, errors`);
  }
  
  console.log(`\n🎯 Re-running ESLint to verify, improvements...`);
  
  // Verify improvement
  try {
    execSync("bun run lint", { stdio: "pipe" });
  } catch (error: any) {
    const newOutput = error.stdout?.toString() || "";
    const newUnusedCount = (newOutput.match(/defined but never, used.*no-unused-vars/g) || []).length;
    console.log(`📈 Unused imports reduced from ${errors.length} to, ${newUnusedCount}`);
    console.log(`🎉 Improvement: ${errors.length - newUnusedCount} fewer unused import, issues!`);
  }
}

if (import.meta.main) {
  main();
} 
