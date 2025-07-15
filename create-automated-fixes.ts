#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "fs";
import { glob } from "glob";
import path from "path";

interface FixResult {
  file: string;
  originalCount: number;
  newCount: number;
  fixesApplied: string[];
  warnings: string[];
}

class AsUnknownFixer {
  private results: FixResult[] = [];

  async fixCodebase(): Promise<void> {
    console.log("🔧 Starting automated as unknown fixes...");
    
    // Find all TypeScript files
    const files = await glob("src/**/*.ts", { 
      ignore: ["**/node_modules/**", "**/*.test.ts", "**/*.spec.ts"],
      absolute: true 
    });
    
    console.log(`📁 Found ${files.length} TypeScript files to process`);
    
    for (const file of files) {
      await this.fixFile(file);
    }
    
    this.generateReport();
  }

  private async fixFile(filepath: string): Promise<void> {
    try {
      const originalContent = readFileSync(filepath, "utf-8");
      const originalCount = this.countAsUnknown(originalContent);
      
      if (originalCount === 0) {
        return; // No work needed
      }
      
      console.log(`🔍 Processing ${path.relative(process.cwd(), filepath)} (${originalCount} assertions)`);
      
      let content = originalContent;
      const fixesApplied: string[] = [];
      const warnings: string[] = [];
      
      // Apply fixes in order of safety (safest first)
      content = this.fixPropertyAccess(content, fixesApplied);
      content = this.fixArrayAccess(content, fixesApplied);
      content = this.fixServiceCalls(content, fixesApplied);
      content = this.fixReturnStatements(content, fixesApplied);
      content = this.fixThisContext(content, fixesApplied);
      content = this.fixNullUndefined(content, fixesApplied, warnings);
      
      const newCount = this.countAsUnknown(content);
      
      if (newCount < originalCount) {
        writeFileSync(filepath, content);
        console.log(`✅ Fixed ${originalCount - newCount} assertions in ${path.basename(filepath)}`);
      }
      
      this.results.push({
        file: path.relative(process.cwd(), filepath),
        originalCount,
        newCount,
        fixesApplied,
        warnings
      });
      
    } catch (error) {
      console.error(`❌ Error processing ${filepath}:`, error);
    }
  }

  private countAsUnknown(content: string): number {
    return (content.match(/as unknown/g) || []).length;
  }

  private fixPropertyAccess(content: string, fixesApplied: string[]): string {
    const patterns = [
      // State and session object access
      {
        pattern: /\(state as unknown\)\.sessions/g,
        replacement: "state.sessions",
        description: "Fixed state.sessions access"
      },
      {
        pattern: /\(state\.sessions as unknown\)/g,
        replacement: "state.sessions",
        description: "Fixed state.sessions wrapper"
      },
      {
        pattern: /\(s as unknown\)\.session/g,
        replacement: "s.session",
        description: "Fixed session record access"
      },
      {
        pattern: /\(s as unknown\)\.taskId/g,
        replacement: "s.taskId",
        description: "Fixed taskId access"
      },
      {
        pattern: /\(session as unknown\)\.session/g,
        replacement: "session.session",
        description: "Fixed session property access"
      },
      {
        pattern: /\(session as unknown\)\.taskId/g,
        replacement: "session.taskId",
        description: "Fixed session taskId access"
      },
      {
        pattern: /\(workspace as unknown\)\.workspaceDir/g,
        replacement: "workspace.workspaceDir",
        description: "Fixed workspace directory access"
      },
      {
        pattern: /\(workspace as unknown\)\.sessionName/g,
        replacement: "workspace.sessionName",
        description: "Fixed workspace session name access"
      },
      // Config and environment access
      {
        pattern: /\(this\.config as unknown\)\.path/g,
        replacement: "this.config.path",
        description: "Fixed config path access"
      },
      {
        pattern: /\(process\.env as unknown\)\.([A-Z_]+)/g,
        replacement: "process.env.$1",
        description: "Fixed environment variable access"
      },
      // Array and object method access
      {
        pattern: /\(([a-zA-Z_][a-zA-Z0-9_]*) as unknown\)\.length/g,
        replacement: "$1.length",
        description: "Fixed array length access"
      },
      {
        pattern: /\(([a-zA-Z_][a-zA-Z0-9_]*) as unknown\)\.push/g,
        replacement: "$1.push",
        description: "Fixed array push access"
      },
      {
        pattern: /\(([a-zA-Z_][a-zA-Z0-9_]*) as unknown\)\.find/g,
        replacement: "$1.find",
        description: "Fixed array find access"
      },
      {
        pattern: /\(([a-zA-Z_][a-zA-Z0-9_]*) as unknown\)\.findIndex/g,
        replacement: "$1.findIndex",
        description: "Fixed array findIndex access"
      },
      {
        pattern: /\(([a-zA-Z_][a-zA-Z0-9_]*) as unknown\)\.splice/g,
        replacement: "$1.splice",
        description: "Fixed array splice access"
      },
      {
        pattern: /\(([a-zA-Z_][a-zA-Z0-9_]*) as unknown\)\.filter/g,
        replacement: "$1.filter",
        description: "Fixed array filter access"
      },
      {
        pattern: /\(([a-zA-Z_][a-zA-Z0-9_]*) as unknown\)\.map/g,
        replacement: "$1.map",
        description: "Fixed array map access"
      },
      {
        pattern: /\(([a-zA-Z_][a-zA-Z0-9_]*) as unknown\)\.split/g,
        replacement: "$1.split",
        description: "Fixed string split access"
      },
      {
        pattern: /\(([a-zA-Z_][a-zA-Z0-9_]*) as unknown\)\.trim/g,
        replacement: "$1.trim",
        description: "Fixed string trim access"
      },
      {
        pattern: /\(([a-zA-Z_][a-zA-Z0-9_]*) as unknown\)\.replace/g,
        replacement: "$1.replace",
        description: "Fixed string replace access"
      }
    ];

    for (const pattern of patterns) {
      const matches = content.match(pattern.pattern);
      if (matches) {
        content = content.replace(pattern.pattern, pattern.replacement);
        fixesApplied.push(`${pattern.description} (${matches.length} occurrences)`);
      }
    }

    return content;
  }

  private fixArrayAccess(content: string, fixesApplied: string[]): string {
    // Fix array destructuring and spread operations
    const patterns = [
      {
        pattern: /\[\.\.\.\(([a-zA-Z_][a-zA-Z0-9_]*) as unknown\)\.([a-zA-Z_][a-zA-Z0-9_]*)\]/g,
        replacement: "[...$1.$2]",
        description: "Fixed array spread with property access"
      },
      {
        pattern: /\[\.\.\.\(([a-zA-Z_][a-zA-Z0-9_]*) as unknown\)\]/g,
        replacement: "[...$1]",
        description: "Fixed array spread"
      }
    ];

    for (const pattern of patterns) {
      const matches = content.match(pattern.pattern);
      if (matches) {
        content = content.replace(pattern.pattern, pattern.replacement);
        fixesApplied.push(`${pattern.description} (${matches.length} occurrences)`);
      }
    }

    return content;
  }

  private fixServiceCalls(content: string, fixesApplied: string[]): string {
    // Fix service method calls that are commonly typed
    const patterns = [
      {
        pattern: /\(this\.sessionProvider as unknown\)\.getSession/g,
        replacement: "this.sessionProvider.getSession",
        description: "Fixed sessionProvider.getSession call"
      },
      {
        pattern: /\(this\.sessionProvider as unknown\)\.getSessionByTaskId/g,
        replacement: "this.sessionProvider.getSessionByTaskId",
        description: "Fixed sessionProvider.getSessionByTaskId call"
      },
      {
        pattern: /\(this\.sessionProvider as unknown\)\.listSessions/g,
        replacement: "this.sessionProvider.listSessions",
        description: "Fixed sessionProvider.listSessions call"
      },
      {
        pattern: /\(this\.sessionProvider as unknown\)\.getSessionWorkdir/g,
        replacement: "this.sessionProvider.getSessionWorkdir",
        description: "Fixed sessionProvider.getSessionWorkdir call"
      },
      {
        pattern: /\(this\.pathResolver as unknown\)\.getRelativePathFromSession/g,
        replacement: "this.pathResolver.getRelativePathFromSession",
        description: "Fixed pathResolver.getRelativePathFromSession call"
      },
      {
        pattern: /\(this\.pathResolver as unknown\)\.validateAndResolvePath/g,
        replacement: "this.pathResolver.validateAndResolvePath",
        description: "Fixed pathResolver.validateAndResolvePath call"
      },
      {
        pattern: /\(this\.workspaceBackend as unknown\)\.readFile/g,
        replacement: "this.workspaceBackend.readFile",
        description: "Fixed workspaceBackend.readFile call"
      },
      {
        pattern: /\(this\.workspaceBackend as unknown\)\.writeFile/g,
        replacement: "this.workspaceBackend.writeFile",
        description: "Fixed workspaceBackend.writeFile call"
      },
      {
        pattern: /\(this\.workspaceBackend as unknown\)\.deleteFile/g,
        replacement: "this.workspaceBackend.deleteFile",
        description: "Fixed workspaceBackend.deleteFile call"
      },
      {
        pattern: /\(this\.workspaceBackend as unknown\)\.listDirectory/g,
        replacement: "this.workspaceBackend.listDirectory",
        description: "Fixed workspaceBackend.listDirectory call"
      },
      {
        pattern: /\(this\.workspaceBackend as unknown\)\.exists/g,
        replacement: "this.workspaceBackend.exists",
        description: "Fixed workspaceBackend.exists call"
      },
      {
        pattern: /\(this\.workspaceBackend as unknown\)\.createDirectory/g,
        replacement: "this.workspaceBackend.createDirectory",
        description: "Fixed workspaceBackend.createDirectory call"
      }
    ];

    for (const pattern of patterns) {
      const matches = content.match(pattern.pattern);
      if (matches) {
        content = content.replace(pattern.pattern, pattern.replacement);
        fixesApplied.push(`${pattern.description} (${matches.length} occurrences)`);
      }
    }

    return content;
  }

  private fixReturnStatements(content: string, fixesApplied: string[]): string {
    // Fix return statements - these are often the most dangerous
    const patterns = [
      {
        pattern: /return null as unknown;/g,
        replacement: "return null;",
        description: "Fixed return null statement"
      },
      {
        pattern: /return undefined as unknown;/g,
        replacement: "return undefined;",
        description: "Fixed return undefined statement"
      }
    ];

    for (const pattern of patterns) {
      const matches = content.match(pattern.pattern);
      if (matches) {
        content = content.replace(pattern.pattern, pattern.replacement);
        fixesApplied.push(`${pattern.description} (${matches.length} occurrences)`);
      }
    }

    return content;
  }

  private fixThisContext(content: string, fixesApplied: string[]): string {
    // Fix this context issues - these usually indicate class definition problems
    const patterns = [
      {
        pattern: /\(this as unknown\)\.name = "([^"]+)";/g,
        replacement: "this.name = \"$1\";",
        description: "Fixed this.name assignment"
      }
    ];

    for (const pattern of patterns) {
      const matches = content.match(pattern.pattern);
      if (matches) {
        content = content.replace(pattern.pattern, pattern.replacement);
        fixesApplied.push(`${pattern.description} (${matches.length} occurrences)`);
      }
    }

    return content;
  }

  private fixNullUndefined(content: string, fixesApplied: string[], warnings: string[]): string {
    // Fix null/undefined casting - these are dangerous and need careful handling
    const patterns = [
      {
        pattern: /: undefined as unknown/g,
        replacement: ": undefined",
        description: "Fixed undefined type annotation"
      },
      {
        pattern: /\? undefined as unknown/g,
        replacement: "? undefined",
        description: "Fixed ternary undefined"
      },
      {
        pattern: /undefined as unknown,/g,
        replacement: "undefined,",
        description: "Fixed undefined in parameter list"
      }
    ];

    for (const pattern of patterns) {
      const matches = content.match(pattern.pattern);
      if (matches) {
        content = content.replace(pattern.pattern, pattern.replacement);
        fixesApplied.push(`${pattern.description} (${matches.length} occurrences)`);
      }
    }

    // Track remaining dangerous patterns
    const dangerousPatterns = [
      /null as unknown/g,
      /undefined as unknown/g
    ];

    for (const pattern of dangerousPatterns) {
      const matches = content.match(pattern);
      if (matches) {
        warnings.push(`${matches.length} dangerous ${pattern.source} patterns still remain`);
      }
    }

    return content;
  }

  private generateReport(): void {
    const totalFiles = this.results.length;
    const filesWithFixes = this.results.filter(r => r.fixesApplied.length > 0).length;
    const totalOriginal = this.results.reduce((sum, r) => sum + r.originalCount, 0);
    const totalNew = this.results.reduce((sum, r) => sum + r.newCount, 0);
    const totalFixed = totalOriginal - totalNew;

    console.log("\n📊 AUTOMATED FIXES REPORT");
    console.log("=========================");
    console.log(`Files processed: ${totalFiles}`);
    console.log(`Files with fixes: ${filesWithFixes}`);
    console.log(`Total assertions before: ${totalOriginal}`);
    console.log(`Total assertions after: ${totalNew}`);
    console.log(`Total fixed: ${totalFixed} (${((totalFixed / totalOriginal) * 100).toFixed(1)}%)`);

    console.log("\n🔧 Fixes Applied:");
    const allFixes = this.results.flatMap(r => r.fixesApplied);
    const fixCounts = allFixes.reduce((counts, fix) => {
      counts[fix] = (counts[fix] || 0) + 1;
      return counts;
    }, {} as Record<string, number>);

    Object.entries(fixCounts)
      .sort(([, a], [, b]) => b - a)
      .forEach(([fix, count]) => {
        console.log(`  ${fix}`);
      });

    console.log("\n⚠️  Warnings:");
    const allWarnings = this.results.flatMap(r => r.warnings);
    if (allWarnings.length > 0) {
      allWarnings.forEach(warning => console.log(`  ${warning}`));
    } else {
      console.log("  None");
    }

    console.log("\n📄 Detailed results saved to: automated-fixes-report.json");
    writeFileSync("./automated-fixes-report.json", JSON.stringify(this.results, null, 2));
  }
}

async function main() {
  const fixer = new AsUnknownFixer();
  await fixer.fixCodebase();
}

if (import.meta.main) {
  main().catch(console.error);
} 
