#!/usr/bin/env bun

/**
 * Enhanced Pattern Fixer for Task #280 - Targeting Specific Identified Patterns
 * 
 * Based on analysis of remaining 518 assertions, targets:
 * - Session object property access patterns: (sessionProvider as unknown)!.method
 * - Dynamic import patterns: ((await import("module")) as unknown).Class
 * - SessionInfo property patterns: (sessionInfo as unknown)!.property
 * - Config object patterns: (config as unknown).property
 */

import { readFileSync, writeFileSync } from "fs";
import { glob } from "glob";

interface Fix {
  pattern: RegExp;
  replacement: string | ((match: string, ...groups: string[]) => string);
  description: string;
  safetyCheck?: (match: string, file: string) => boolean;
}

interface TransformationResult {
  file: string;
  fixes: number;
  patterns: string[];
}

class EnhancedPatternFixer {
  private transformations: TransformationResult[] = [];

  private fixes: Fix[] = [
    // Session object property access patterns
    {
      pattern: /\(sessionProvider as unknown\)!/g,
      replacement: "sessionProvider",
      description: "Remove sessionProvider cast with non-null assertion"
    },
    {
      pattern: /\(sessionRecord as unknown\)!/g,
      replacement: "sessionRecord",
      description: "Remove sessionRecord cast with non-null assertion"
    },
    {
      pattern: /\(sessionInfo as unknown\)!/g,
      replacement: "sessionInfo",
      description: "Remove sessionInfo cast with non-null assertion"
    },
    {
      pattern: /\(sessionDb as unknown\)!/g,
      replacement: "sessionDb",
      description: "Remove sessionDb cast with non-null assertion"
    },
    
    // Config object patterns
    {
      pattern: /\(config as unknown\)\.([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
      replacement: "config.$1",
      description: "Remove config object cast"
    },
    {
      pattern: /\(options as unknown\)\.([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
      replacement: "options.$1",
      description: "Remove options object cast"
    },
    
    // Dynamic import patterns - more conservative approach
    {
      pattern: /\(\(await import\("([^"]+)"\)\) as unknown\)\.([A-Z][a-zA-Z0-9_$]*)/g,
      replacement: (match, modulePath, className) => {
        // Only fix for relative imports and common patterns
        if (modulePath.startsWith("./") || modulePath.startsWith("../")) {
          return `(await import("${modulePath}")).${className}`;
        }
        return match; // Keep original for absolute imports
      },
      description: "Remove dynamic import cast for relative modules"
    },
    
    // Error object patterns
    {
      pattern: /\(error as unknown\)\.([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
      replacement: "error.$1",
      description: "Remove error object cast"
    },
    {
      pattern: /\(err as unknown\)\.([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
      replacement: "err.$1",
      description: "Remove err object cast"
    },
    {
      pattern: /\(e as unknown\)\.([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
      replacement: "e.$1",
      description: "Remove e object cast"
    },
    
    // Provider/service patterns
    {
      pattern: /\(([a-zA-Z_$][a-zA-Z0-9_$]*Provider) as unknown\)/g,
      replacement: "$1",
      description: "Remove provider object cast"
    },
    {
      pattern: /\(([a-zA-Z_$][a-zA-Z0-9_$]*Service) as unknown\)/g,
      replacement: "$1",
      description: "Remove service object cast"
    },
    {
      pattern: /\(([a-zA-Z_$][a-zA-Z0-9_$]*Backend) as unknown\)/g,
      replacement: "$1",
      description: "Remove backend object cast"
    },
    
    // Simple context/data patterns
    {
      pattern: /\(context as unknown\)\.([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
      replacement: "context.$1",
      description: "Remove context object cast"
    },
    {
      pattern: /\(data as unknown\)\.([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
      replacement: "data.$1",
      description: "Remove data object cast"
    },
    
    // Output/result patterns from CLI
    {
      pattern: /\(output as unknown\) as/g,
      replacement: "output as",
      description: "Remove redundant output cast"
    },
    {
      pattern: /\(result as unknown\) as/g,
      replacement: "result as",
      description: "Remove redundant result cast"
    },
    
    // Simple object property patterns without non-null assertion
    {
      pattern: /\(([a-zA-Z_$][a-zA-Z0-9_$]*) as unknown\)\.([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
      replacement: "$1.$2",
      description: "Remove simple object property cast",
      safetyCheck: (match, file) => {
        // Only apply to simple property access, not method calls
        return !match.includes("(") || match.split("(").length <= 3;
      }
    }
  ];

  public async fixAllFiles(): Promise<void> {
    console.log("🔧 Starting enhanced pattern fixes...");
    
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
      
      if (typeof fix.replacement === "function") {
        content = content.replace(fix.pattern, fix.replacement);
      } else if (fix.safetyCheck) {
        // Apply safety check for each match
        content = content.replace(fix.pattern, (match, ...args) => {
          if (fix.safetyCheck!(match, filePath)) {
            return (fix.replacement as string).replace(/\$(\d+)/g, (_, num) => args[parseInt(num) - 1] || "");
          }
          return match;
        });
      } else {
        content = content.replace(fix.pattern, fix.replacement as string);
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
    const reportPath = "enhanced-pattern-transformation-report.json";
    const totalFixes = this.transformations.reduce((sum, t) => sum + t.fixes, 0);
    
    const report = {
      timestamp: new Date().toISOString(),
      totalTransformations: totalFixes,
      filesModified: this.transformations.length,
      transformations: this.transformations
    };
    
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    
    console.log(`\n✅ Enhanced pattern fixes completed!`);
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

// Run the enhanced pattern fixer
async function main() {
  const fixer = new EnhancedPatternFixer();
  await fixer.fixAllFiles();
}

if (import.meta.main) {
  main().catch(console.error);
} 
