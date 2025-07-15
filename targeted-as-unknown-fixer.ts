#!/usr/bin/env bun

/**
 * Targeted AS-UNKNOWN Batch Fixer for Task #280
 *
 * A conservative approach to fixing 'as unknown' assertions in batches
 * by focusing on the safest and most common patterns.
 */

import { readFileSync, writeFileSync } from "fs";
import { glob } from "glob";
import { execSync } from "child_process";

interface SafePattern {
  name: string;
  description: string;
  pattern: RegExp;
  replacement: string;
  riskLevel: "low" | "medium" | "high";
}

class TargetedAsUnknownFixer {
  private safePatterns: SafePattern[] = [];
  private fixedCount = 0;
  private totalFound = 0;
  private errors: string[] = [];

  constructor() {
    this.initializeSafePatterns();
  }

  private initializeSafePatterns(): void {
    this.safePatterns = [
      // CRITICAL: Return statements with null/undefined
      {
        name: "Return null as unknown",
        description: "Remove 'as unknown' from return null statements",
        pattern: /return null as unknown;/g,
        replacement: "return null;",
        riskLevel: "low"
      },
      {
        name: "Return undefined as unknown",
        description: "Remove 'as unknown' from return undefined statements",
        pattern: /return undefined as unknown;/g,
        replacement: "return undefined;",
        riskLevel: "low"
      },

      // CRITICAL: Simple variable assignments
      {
        name: "Null assignment",
        description: "Remove 'as unknown' from null variable assignments",
        pattern: /= null as unknown;/g,
        replacement: "= null;",
        riskLevel: "low"
      },
      {
        name: "Undefined assignment",
        description: "Remove 'as unknown' from undefined variable assignments",
        pattern: /= undefined as unknown;/g,
        replacement: "= undefined;",
        riskLevel: "low"
      },

      // LOW: Object.keys/values/entries (very safe)
      {
        name: "Object.keys",
        description: "Remove 'as unknown' from Object.keys calls",
        pattern: /Object\.keys\(([^)]+) as unknown\)/g,
        replacement: "Object.keys($1)",
        riskLevel: "low"
      },
      {
        name: "Object.values",
        description: "Remove 'as unknown' from Object.values calls",
        pattern: /Object\.values\(([^)]+) as unknown\)/g,
        replacement: "Object.values($1)",
        riskLevel: "low"
      },
      {
        name: "Object.entries",
        description: "Remove 'as unknown' from Object.entries calls",
        pattern: /Object\.entries\(([^)]+) as unknown\)/g,
        replacement: "Object.entries($1)",
        riskLevel: "low"
      }
    ];
  }

  async execute(): Promise<void> {
    console.log("🚀 Starting targeted 'as unknown' batch fixer...");

    // Get all TypeScript files
    const files = await glob("src/**/*.ts", {
      ignore: ["**/*.d.ts", "**/*.test.ts", "**/node_modules/**"]
    });

    console.log(`📁 Found ${files.length} files to process`);

    // Process each file
    for (const file of files) {
      await this.processFile(file);
    }

    // Summary report
    this.printSummary();

    // Run a quick compilation check
    await this.validateCompilation();
  }

  private async processFile(filePath: string): Promise<void> {
    try {
      const content = readFileSync(filePath, "utf-8");
      let modifiedContent = content;
      let fileChanged = false;
      let fileFixCount = 0;

      // Apply each safe pattern
      for (const pattern of this.safePatterns) {
        const matches = content.match(pattern.pattern);
        if (matches) {
          console.log(`  📋 ${filePath}: Found ${matches.length} instances of "${pattern.name}"`);
          this.totalFound += matches.length;

          const newContent = modifiedContent.replace(pattern.pattern, pattern.replacement);
          if (newContent !== modifiedContent) {
            modifiedContent = newContent;
            fileChanged = true;
            fileFixCount += matches.length;
          }
        }
      }

      // Save changes if any were made
      if (fileChanged) {
        writeFileSync(filePath, modifiedContent);
        console.log(`  ✅ ${filePath}: Fixed ${fileFixCount} assertions`);
        this.fixedCount += fileFixCount;
      }

    } catch (error) {
      this.errors.push(`Error processing ${filePath}: ${error}`);
      console.error(`  ❌ Error processing ${filePath}:`, error);
    }
  }

  private printSummary(): void {
    console.log(`\n${"=".repeat(50)}`);
    console.log("📊 TARGETED AS-UNKNOWN BATCH FIXER SUMMARY");
    console.log(`${"=".repeat(50)}`);
    console.log(`🔍 Total assertions found: ${this.totalFound}`);
    console.log(`✅ Total assertions fixed: ${this.fixedCount}`);
    console.log(`📈 Success rate: ${((this.fixedCount / this.totalFound) * 100).toFixed(1)}%`);
    console.log(`❌ Errors encountered: ${this.errors.length}`);

    if (this.errors.length > 0) {
      console.log(`\n🚨 Errors:`);
      this.errors.forEach(error => console.log(`  - ${error}`));
    }

    console.log(`\n📋 Pattern breakdown:`);
    this.safePatterns.forEach(pattern => {
      console.log(`  - ${pattern.name}: ${pattern.riskLevel} risk`);
    });
  }

  private async validateCompilation(): Promise<void> {
    console.log("\n🔍 Validating TypeScript compilation...");

    try {
      // Run a quick TypeScript check
      execSync("npx tsc --noEmit", { stdio: "pipe" });
      console.log("✅ TypeScript compilation successful!");
    } catch (error) {
      console.log("⚠️  TypeScript compilation issues detected:");
      console.log("📋 Some fixes may need manual review");
    }
  }
}

// CLI execution
if (import.meta.main) {
  const fixer = new TargetedAsUnknownFixer();
  fixer.execute().catch(console.error);
}

export { TargetedAsUnknownFixer };
