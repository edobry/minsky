#!/usr/bin/env bun

/**
 * Simple Pattern-Based Fixer for Task #280
 * 
 * Uses regex-based string replacement for simple, safe patterns
 * that don't require complex AST manipulation.
 */

import { readFileSync, writeFileSync } from "fs";
import { glob } from "glob";

interface Fix {
  pattern: RegExp;
  replacement: string;
  description: string;
  safetyCheck?: (match: string, file: string) => boolean;
}

interface TransformationResult {
  file: string;
  fixes: number;
  patterns: string[];
}

class PatternBasedFixer {
  private transformations: TransformationResult[] = [];

  private fixes: Fix[] = [
    // Simple variable casts
    {
      pattern: /\(params as unknown\)/g,
      replacement: "params",
      description: "Remove unnecessary params cast"
    },
    {
      pattern: /\(result as unknown\)/g,
      replacement: "result",
      description: "Remove unnecessary result cast"
    },
    {
      pattern: /\(provider as unknown\)/g,
      replacement: "provider",
      description: "Remove unnecessary provider cast"
    },
    {
      pattern: /\(current as unknown\)/g,
      replacement: "current",
      description: "Remove unnecessary current cast"
    },
    {
      pattern: /\(task as unknown\)/g,
      replacement: "task",
      description: "Remove unnecessary task cast"
    },
    // Promise patterns
    {
      pattern: /Promise\.resolve\(([^)]+)\) as unknown/g,
      replacement: "Promise.resolve($1)",
      description: "Remove unnecessary Promise.resolve cast"
    },
    {
      pattern: /Promise\.reject\(([^)]+)\) as unknown/g,
      replacement: "Promise.reject($1)",
      description: "Remove unnecessary Promise.reject cast"
    },
    // Simple property access
    {
      pattern: /\(([a-zA-Z_$][a-zA-Z0-9_$]*\.[a-zA-Z_$][a-zA-Z0-9_$]*) as unknown\)/g,
      replacement: "$1",
      description: "Remove unnecessary property access cast",
      safetyCheck: (match, file) => {
        // Only apply if it's a simple property access (no method calls)
        return !match.includes("(") || match.split("(").length <= 2;
      }
    }
  ];

  public async fixAllFiles(): Promise<void> {
    console.log("🔧 Starting pattern-based fixes...");
    
    const files = await glob("src/**/*.ts", { 
      ignore: ["**/*.test.ts", "**/*.spec.ts", "**/node_modules/**", "**/*.d.ts"] 
    });
    
    for (const file of files) {
      this.fixFile(file);
    }
    
    this.generateReport();
  }

  private fixFile(filePath: string): void {
    let content = readFileSync(filePath, "utf-8");
    let totalFixes = 0;
    const appliedPatterns: string[] = [];
    
    for (const fix of this.fixes) {
      const originalContent = content;
      
      if (fix.safetyCheck) {
        // Apply safety check for each match
        content = content.replace(fix.pattern, (match, ...args) => {
          if (fix.safetyCheck!(match, filePath)) {
            return fix.replacement.replace(/\$(\d+)/g, (_, num) => args[parseInt(num) - 1] || "");
          }
          return match;
        });
      } else {
        content = content.replace(fix.pattern, fix.replacement);
      }
      
      if (content !== originalContent) {
        const fixCount = (originalContent.match(fix.pattern) || []).length;
        totalFixes += fixCount;
        appliedPatterns.push(`${fix.description} (${fixCount}x)`);
      }
    }
    
    if (totalFixes > 0) {
      writeFileSync(filePath, content);
      this.transformations.push({
        file: filePath,
        fixes: totalFixes,
        patterns: appliedPatterns
      });
    }
  }

  private generateReport(): void {
    const reportPath = "pattern-based-transformation-report.json";
    const totalFixes = this.transformations.reduce((sum, t) => sum + t.fixes, 0);
    
    const report = {
      timestamp: new Date().toISOString(),
      totalTransformations: totalFixes,
      filesModified: this.transformations.length,
      transformations: this.transformations
    };
    
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    
    console.log(`\n✅ Pattern-based fixes completed!`);
    console.log(`📊 Total transformations: ${totalFixes}`);
    console.log(`📁 Files modified: ${this.transformations.length}`);
    console.log(`📄 Full report: ${reportPath}`);
    
    if (this.transformations.length > 0) {
      console.log(`\n🔍 Modified files:`);
      this.transformations.forEach(t => {
        console.log(`   ${t.file}: ${t.fixes} fixes`);
        t.patterns.forEach(p => console.log(`     - ${p}`));
      });
    }
  }
}

// Run the pattern fixer
async function main() {
  const fixer = new PatternBasedFixer();
  await fixer.fixAllFiles();
}

if (import.meta.main) {
  main().catch(console.error);
} 
