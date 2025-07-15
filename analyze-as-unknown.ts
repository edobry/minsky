#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "fs";
import { glob } from "glob";
import { join } from "path";

interface AsUnknownMatch {
  file: string;
  line: number;
  content: string;
  context: string;
  category: "test-mocking" | "type-bridging" | "error-masking" | "legitimate" | "suspicious";
  priority: "high" | "medium" | "low";
  reason: string;
}

interface AnalysisReport {
  totalCount: number;
  byCategory: Record<string, number>;
  byPriority: Record<string, number>;
  matches: AsUnknownMatch[];
  recommendations: string[];
}

class AsUnknownAnalyzer {
  private matches: AsUnknownMatch[] = [];

  async analyzeCodebase(): Promise<AnalysisReport> {
    console.log("🔍 Scanning for \"as unknown\" assertions...");
    
    // Find all TypeScript files
    const files = await glob("**/*.ts", { 
      ignore: ["node_modules/**", "**/node_modules/**", "dist/**", "build/**"],
      absolute: true 
    });
    
    console.log(`📁 Found ${files.length} TypeScript files`);
    
    for (const file of files) {
      this.analyzeFile(file);
    }
    
    return this.generateReport();
  }

  private analyzeFile(filepath: string): void {
    try {
      const content = readFileSync(filepath, "utf-8");
      const lines = content.split("\n");
      
      lines.forEach((line, index) => {
        if (line.includes("as unknown")) {
          const match = this.categorizeAssertion(filepath, index + 1, line, lines);
          if (match) {
            this.matches.push(match);
          }
        }
      });
    } catch (error) {
      console.error(`❌ Error reading file ${filepath}:`, error);
    }
  }

  private categorizeAssertion(
    file: string, 
    line: number, 
    content: string, 
    allLines: string[]
  ): AsUnknownMatch | null {
    const trimmed = content.trim();
    
    // Get context (2 lines before and after)
    const contextStart = Math.max(0, line - 3);
    const contextEnd = Math.min(allLines.length, line + 2);
    const context = allLines.slice(contextStart, contextEnd).join("\n");
    
    // Categorization logic
    let category: AsUnknownMatch["category"] = "suspicious";
    let priority: AsUnknownMatch["priority"] = "medium";
    let reason = "";
    
    // Test file patterns
    if (file.includes(".test.ts") || file.includes(".spec.ts")) {
      if (trimmed.includes("mock") || trimmed.includes("Mock") || 
          trimmed.includes("jest") || trimmed.includes("vi.")) {
        category = "test-mocking";
        priority = "low";
        reason = "Test mocking - may be legitimate for test setup";
      } else if (trimmed.includes("undefined as unknown") || 
                 trimmed.includes("null as unknown")) {
        category = "test-mocking";
        priority = "medium";
        reason = "Test parameter passing - check if proper types can be used";
      } else {
        category = "error-masking";
        priority = "high";
        reason = "Test assertion masking type errors - should be fixed";
      }
    } else {
      // Production code patterns
      if (trimmed.includes("undefined as unknown") || 
          trimmed.includes("null as unknown")) {
        category = "error-masking";
        priority = "high";
        reason = "Masking null/undefined type errors - dangerous";
      } else if (trimmed.includes("JSON.parse") || 
                 trimmed.includes("JSON.stringify")) {
        category = "type-bridging";
        priority = "medium";
        reason = "JSON parsing - may need proper type guards";
      } else if (trimmed.includes("this as unknown")) {
        category = "error-masking";
        priority = "high";
        reason = "This context masking - likely type error";
      } else if (trimmed.includes("(") && trimmed.includes(")") && 
                 trimmed.includes("as unknown") && trimmed.includes(".")) {
        category = "error-masking";
        priority = "high";
        reason = "Property access masking - should use proper types";
      } else {
        category = "suspicious";
        priority = "medium";
        reason = "Needs manual review";
      }
    }
    
    return {
      file: file.replace(`${process.cwd()  }/`, ""),
      line,
      content: trimmed,
      context,
      category,
      priority,
      reason
    };
  }

  private generateReport(): AnalysisReport {
    const byCategory: Record<string, number> = {};
    const byPriority: Record<string, number> = {};
    
    this.matches.forEach(match => {
      byCategory[match.category] = (byCategory[match.category] || 0) + 1;
      byPriority[match.priority] = (byPriority[match.priority] || 0) + 1;
    });
    
    const recommendations = this.generateRecommendations(byCategory, byPriority);
    
    return {
      totalCount: this.matches.length,
      byCategory,
      byPriority,
      matches: this.matches,
      recommendations
    };
  }

  private generateRecommendations(
    byCategory: Record<string, number>, 
    byPriority: Record<string, number>
  ): string[] {
    const recommendations: string[] = [];
    
    if (byPriority.high > 0) {
      recommendations.push(`🚨 HIGH PRIORITY: ${byPriority.high} assertions are masking type errors and should be fixed immediately`);
    }
    
    if (byCategory["error-masking"] > 0) {
      recommendations.push(`⚠️  ${byCategory["error-masking"]} assertions are masking type errors - these reduce TypeScript effectiveness`);
    }
    
    if (byCategory["test-mocking"] > 0) {
      recommendations.push(`🧪 ${byCategory["test-mocking"]} assertions in tests - review for proper type alternatives`);
    }
    
    if (byCategory["type-bridging"] > 0) {
      recommendations.push(`🌉 ${byCategory["type-bridging"]} assertions for type bridging - consider proper type guards`);
    }
    
    recommendations.push("📋 Start with high priority items, then medium, then low");
    recommendations.push("🔍 Focus on production code before test code");
    recommendations.push("📚 Document any legitimate uses that must remain");
    
    return recommendations;
  }
}

async function main() {
  const analyzer = new AsUnknownAnalyzer();
  const report = await analyzer.analyzeCodebase();
  
  console.log("\n📊 ANALYSIS REPORT");
  console.log("==================");
  console.log(`Total "as unknown" assertions found: ${report.totalCount}`);
  
  console.log("\n📂 By Category:");
  Object.entries(report.byCategory).forEach(([category, count]) => {
    console.log(`  ${category}: ${count}`);
  });
  
  console.log("\n🎯 By Priority:");
  Object.entries(report.byPriority).forEach(([priority, count]) => {
    console.log(`  ${priority}: ${count}`);
  });
  
  console.log("\n💡 Recommendations:");
  report.recommendations.forEach(rec => console.log(`  ${rec}`));
  
  // Write detailed report to file
  const reportPath = "./as-unknown-analysis-report.json";
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n📄 Detailed report saved to: ${reportPath}`);
  
  // Write summary markdown
  const summaryPath = "./as-unknown-analysis-summary.md";
  const markdown = generateMarkdownSummary(report);
  writeFileSync(summaryPath, markdown);
  console.log(`📄 Summary report saved to: ${summaryPath}`);
}

function generateMarkdownSummary(report: AnalysisReport): string {
  return `# "as unknown" Analysis Report

## Summary
- **Total assertions found**: ${report.totalCount}
- **Analysis date**: ${new Date().toISOString()}

## Distribution by Category
${Object.entries(report.byCategory).map(([cat, count]) => `- **${cat}**: ${count}`).join("\n")}

## Distribution by Priority
${Object.entries(report.byPriority).map(([pri, count]) => `- **${pri}**: ${count}`).join("\n")}

## Recommendations
${report.recommendations.map(rec => `- ${rec}`).join("\n")}

## High Priority Items
${report.matches
    .filter(m => m.priority === "high")
    .map(m => `- **${m.file}:${m.line}** - ${m.reason}\n  \`\`\`typescript\n  ${m.content}\n  \`\`\``)
    .join("\n\n")}

## Next Steps
1. Start with high priority items (${report.byPriority.high || 0} items)
2. Review error-masking assertions first
3. Fix underlying type issues rather than masking them
4. Consider proper type guards for legitimate type bridging
5. Document any assertions that must remain
`;
}

if (import.meta.main) {
  main().catch(console.error);
} 
