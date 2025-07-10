#!/usr/bin/env bun

import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

interface CodemodInfo {
  filename: string;
  size: number;
  lines: number;
  category: string;
  description: string;
  hasTests: boolean;
  dependencies: string[];
}

const CODEMOD_CATEGORIES = {
  "Variable Naming": [
    "fix-incorrect-underscore-prefixes",
    "fix-underscore-prefix",
    "fix-result-underscore-mismatch",
    "modern-variable-naming-fix",
    "simple-underscore-fix",
    "comprehensive-underscore-fix"
  ],
  "Type Assertions": [
    "fix-type-assertions",
    "fix-unknown-type-assertions",
    "fix-rules-type-assertions"
  ],
  "Syntax Errors": [
    "fix-syntax-errors",
    "fix-all-parsing-errors",
    "fix-targeted-parsing-errors",
    "fix-final-syntax-errors"
  ],
  "Bun Compatibility": [
    "fix-bun-compatibility-ast",
    "fix-bun-process-types",
    "fix-bun-types-simple-ast",
    "fix-buffer-string-issues"
  ],
  "Explicit Any Types": [
    "fix-explicit-any",
    "fix-explicit-any-simple",
    "fix-explicit-any-types-proven"
  ],
  "Property/Type Issues": [
    "fix-missing-required-properties",
    "fix-property-name-corrections",
    "fix-ts2564-property-initialization",
    "fix-postgres-storage-types"
  ],
  "Code Style": [
    "fix-quotes-to-double",
    "fix-indentation"
  ],
  "Bulk Fixers": [
    "surgical-bulk-fixer",
    "targeted-bulk-fixer",
    "main-source-fixer",
    "source-files-fixer"
  ],
  "Specific Issues": [
    "fix-command-registration-overloads",
    "fix-common-type-issues",
    "fix-current-globals",
    "fix-dependencies-mocks",
    "fix-session-ts-issues",
    "fix-undefined-issues"
  ],
  "Utilities": [
    "codemod-framework",
    "specialized-codemods"
  ]
};

function categorizeCodemod(filename: string): string {
  const baseName = filename.replace(/\.ts$/, "").replace(/\.test$/, "");
  
  for (const [category, patterns] of Object.entries(CODEMOD_CATEGORIES)) {
    for (const pattern of patterns) {
      if (baseName.includes(pattern)) {
        return category;
      }
    }
  }
  
  return "Uncategorized";
}

function analyzeCodemod(filepath: string): CodemodInfo {
  const content = readFileSync(filepath, "utf-8");
  const lines = content.split("\n").length;
  const size = content.length;
  const filename = filepath.split("/").pop()!;
  
  // Extract description from comments
  const descriptionMatch = content.match(/\/\*\*?\s*\n?\s*\*?\s*(.+?)(?:\n|\*\/)/);
  const description = descriptionMatch ? descriptionMatch[1].trim() : "No description found";
  
  // Check for test files
  const hasTests = filename.includes(".test.") || 
                  content.includes("describe(") || 
                  content.includes("it(") ||
                  content.includes("test(");
  
  // Extract dependencies (imports)
  const importMatches = content.match(/import\s+.+?\s+from\s+["'](.+?)["']/g) || [];
  const dependencies = importMatches.map(imp => {
    const match = imp.match(/from\s+["'](.+?)["']/);
    return match ? match[1] : "";
  }).filter(dep => dep && !dep.startsWith("."));
  
  return {
    filename,
    size,
    lines,
    category: categorizeCodemod(filename),
    description,
    hasTests,
    dependencies: [...new Set(dependencies)]
  };
}

function main() {
  const codemodDir = "codemods";
  const files = readdirSync(codemodDir)
    .filter(file => file.endsWith(".ts") && !file.includes("consolidated"))
    .map(file => join(codemodDir, file))
    .filter(file => statSync(file).isFile());
  
  const codemods = files.map(analyzeCodemod);
  
  console.log("=== REMAINING CODEMODS ANALYSIS ===\n");
  
  // Group by category
  const categories = Object.keys(CODEMOD_CATEGORIES).concat(["Uncategorized"]);
  
  for (const category of categories) {
    const categoryCodemods = codemods.filter(c => c.category === category);
    if (categoryCodemods.length === 0) continue;
    
    console.log(`## ${category} (${categoryCodemods.length} files)`);
    console.log("-".repeat(50));
    
    for (const codemod of categoryCodemods) {
      const testStatus = codemod.hasTests ? "✅ HAS TESTS" : "❌ NO TESTS";
      console.log(`📄 ${codemod.filename}`);
      console.log(`   Size: ${codemod.size} bytes, ${codemod.lines} lines`);
      console.log(`   ${testStatus}`);
      console.log(`   Description: ${codemod.description}`);
      if (codemod.dependencies.length > 0) {
        console.log(`   Dependencies: ${codemod.dependencies.join(", ")}`);
      }
      console.log("");
    }
  }
  
  // Summary statistics
  console.log("\n=== CONSOLIDATION RECOMMENDATIONS ===\n");
  
  const totalFiles = codemods.length;
  const totalSize = codemods.reduce((sum, c) => sum + c.size, 0);
  const filesWithTests = codemods.filter(c => c.hasTests).length;
  
  console.log(`📊 Total files: ${totalFiles}`);
  console.log(`📊 Total size: ${(totalSize / 1024).toFixed(1)} KB`);
  console.log(`📊 Files with tests: ${filesWithTests}/${totalFiles} (${((filesWithTests/totalFiles)*100).toFixed(1)}%)`);
  console.log("");
  
  // Consolidation recommendations
  console.log("🔄 CONSOLIDATION OPPORTUNITIES:");
  console.log("");
  
  for (const [category, categoryCodemods] of Object.entries(
    codemods.reduce((acc, c) => {
      acc[c.category] = acc[c.category] || [];
      acc[c.category].push(c);
      return acc;
    }, {} as Record<string, CodemodInfo[]>)
  )) {
    if (categoryCodemods.length <= 1) continue;
    
    const totalLines = categoryCodemods.reduce((sum, c) => sum + c.lines, 0);
    const avgLines = Math.round(totalLines / categoryCodemods.length);
    
    console.log(`🎯 ${category}:`);
    console.log(`   - ${categoryCodemods.length} files, ${totalLines} total lines (avg: ${avgLines})`);
    console.log(`   - Recommendation: ${categoryCodemods.length > 3 ? "CONSOLIDATE" : "REVIEW"}`);
    console.log("");
  }
  
  // Files that can be removed
  console.log("🗑️  POTENTIAL REMOVALS:");
  console.log("");
  
  const smallFiles = codemods.filter(c => c.lines < 10);
  const testFiles = codemods.filter(c => c.hasTests && c.filename.includes(".test."));
  
  if (smallFiles.length > 0) {
    console.log(`📝 Small files (< 10 lines): ${smallFiles.length}`);
    smallFiles.forEach(f => console.log(`   - ${f.filename} (${f.lines} lines)`));
    console.log("");
  }
  
  if (testFiles.length > 0) {
    console.log(`🧪 Test files: ${testFiles.length}`);
    testFiles.forEach(f => console.log(`   - ${f.filename}`));
    console.log("");
  }
}

main(); 
