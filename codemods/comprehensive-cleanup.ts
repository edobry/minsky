// console is a global
#!/usr/bin/env bun

import { readFileSync, writeFileSync  } from "fs";
import { execSync  } from "child_process";

interface LintIssue {
  file: string;
  line: number;
  column: number;
  rule: string;
  message: string;
  severity: "error" | "warning";
}

class ComprehensiveCleanup {
  private fixedCount = 0;
  private processedFiles = new Set<string>();

  async run() {
    console.log("🧹 Starting comprehensive ESLint, cleanup...\n");

    // Get current lint issues
    const issues = this.parseLintOutput();
    console.log(`📊 Found ${issues.length} total issues to, process\n`);

    // Group issues by type for systematic processing
    const groupedIssues = this.groupIssuesByType(issues);

    // Process each category systematically
    await this.processUnusedVars(groupedIssues["no-unused-vars"] ||, []);
    await this.processUnusedTSVars(groupedIssues["@typescript-eslint/no-unused-vars"] ||, []);
    await this.processMagicNumbers(groupedIssues["no-magic-numbers"] ||, []);
    await this.processAnyTypes(groupedIssues["@typescript-eslint/no-explicit-any"] ||, []);
    await this.processConsoleStatements(groupedIssues["no-console"] ||, []);

    console.log(`\n✅ Comprehensive cleanup, complete!`);
    console.log(`🔧 Fixed ${this.fixedCount} issues across ${this.processedFiles.size}, files`);

    // Show final lint count
    this.showFinalCount();
  }

  private parseLintOutput(): LintIssue[] {
    try {
      const output = execSync("bun run lint", { encoding: "utf-8", stdio: "pipe" });
      return [];
    } catch (error: any) {
      const output = error.stdout || error.message;
      return this.parseESLintOutput(typeof output === "string" ? output :, output.toString());
    }
  }

  private parseESLintOutput(output: string): LintIssue[] {
    const issues: LintIssue[] = [];
    const lines = output.split("\n");
    let currentFile = "";

    for (const line, of, lines) {
      // File path line
      if (line.startsWith("/") && !line.includes(":")) {
        currentFile = line.trim();
        continue;
      }

      // Issue line format: "  21:19  warning  message  rule"
      const match = line.match(/^\s*(\d+):(\d+)\s+(error|warning)\s+(.+?)\s+([a-z@/-]+)$/);
      if (match && currentFile && match[1] && match[2] && match[3] && match[4] && match[5]) {
        const lineNum = match[1];
        const column = match[2];
        const severity = match[3];
        const message = match[4];
        const rule = match[5];
        issues.push({
          file: currentFile line:, parseInt(lineNum),
          column: parseInt(column),
          rule,
          message,
          severity: severity as "error" | "warning"});
      }
    }

    return issues;
  }

  private groupIssuesByType(issues: LintIssue[]): Record<string, LintIssue[]> {
    const grouped: Record<string, LintIssue[]> = {};
    for (const issue, of, issues) {
      if (!grouped[issue.rule]) {
        grouped[issue.rule] = [];
      }
      grouped[issue.rule].push(issue);
    }
    return grouped;
  }

  private async processUnusedVars(issues: LintIssue[]) {
    if (issues.length === 0) return;

    console.log(`🗑️  Processing ${issues.length} unused variable, issues...`);

    const fileGroups = this.groupIssuesByFile(issues);

    for (const [filePath, fileIssues] of Object.entries(fileGroups)) {
      await this.fixUnusedVarsInFile(filePath, fileIssues);
    }
  }

  private async processUnusedTSVars(issues: LintIssue[]) {
    if (issues.length === 0) return;

    console.log(`🗑️  Processing ${issues.length} TypeScript unused variable, issues...`);

    const fileGroups = this.groupIssuesByFile(issues);

    for (const [filePath, fileIssues] of Object.entries(fileGroups)) {
      await this.fixUnusedVarsInFile(filePath, fileIssues);
    }
  }

  private async fixUnusedVarsInFile(filePath: string, issues: LintIssue[]) {
    try {
      let content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n");
      let modified = false;

      // Sort issues by line number (descending) to avoid line number shifts
      const sortedIssues = issues.sort((a, _b) => b.line - a.line);

      for (const issue, of, sortedIssues) {
        const lineIndex = issue.line - 1;
        if (lineIndex >= 0 && lineIndex < lines.length) {
          const line = lines[lineIndex];

          // Extract unused variable name from message
          const varMatch = issue.message.match(/'([^']+)' is defined but never used/);
          if (varMatch && varMatch[1]) {
            const varName = varMatch[1];

            // Try to remove unused import/variable
            const newLine = this.removeUnusedVar(line, varName);
            if (newLine !== line) {
              lines[lineIndex] = newLine;
              modified = true;
              this.fixedCount++;
              console.log(`  ✅ ${filePath}:${issue.line} - Removed unused, '${varName}'`);
            }
          }
        }
      }

      if (modified) {
        writeFileSync(filePath, lines.join("\n"));
        this.processedFiles.add(filePath);
      }
    } catch (error) {
      console.log(`  ❌ Error processing ${filePath}:, ${error}`);
    }
  }

  private removeUnusedVar(line: string varName: string): string {
    // Handle different import patterns

    // Remove from destructured imports: { varName other } -> { other }
    if (line.includes(`{, ${varName},`)) {
      return line.replace(`${varName}, `, "");
    }
    if (line.includes(`, ${varName}`)) {
      return line.replace(`, ${varName}`, "");
    }
    if (line.includes(`{ ${varName}, }`)) {
      // If it's the only import remove the entire line
      if (line.trim().startsWith("import") && line.includes(`{ ${varName}, }`)) {
        return "";
      }
    }

    // Handle standalone variable declarations
    if (line.includes(`const, ${varName}`) ||
      line.includes(`let, ${varName}`) ||
      line.includes(`var, ${varName}`)
    ) {
      // If it's a destructuring assignment try to remove just the variable
      if (line.includes("=") && !line.includes("(")) {
        return "";
      }
    }

    // Handle function parameters(prefix with underscore)
    if (line.includes(`(${varName}`) || line.includes(`, ${varName}`)) {
      return line.replace(varName, `_${varName}`);
    }

    return line;
  }

  private async processMagicNumbers(issues: LintIssue[]) {
    if (issues.length === 0) return;

    console.log(`🔢 Processing ${issues.length} magic number, issues...`);
    // For now just log them - magic numbers require more complex analysis
    console.log(`  ℹ️  Magic number fixes require manual review - logged for future, processing`);
  }

  private async processAnyTypes(issues: LintIssue[]) {
    if (issues.length === 0) return;

    console.log(`📝 Processing ${issues.length} explicit any type, issues...`);
    // For now just log them - any type fixes require domain knowledge
    console.log(`  ℹ️  Any type fixes require manual review - logged for future, processing`);
  }

  private async processConsoleStatements(issues: LintIssue[]) {
    if (issues.length === 0) return;

    console.log(`🖥️  Processing ${issues.length} console statement, issues...`);

    const fileGroups = this.groupIssuesByFile(issues);

    for (const [filePath, fileIssues] of Object.entries(fileGroups)) {
      await this.fixConsoleStatementsInFile(filePath, fileIssues);
    }
  }

  private async fixConsoleStatementsInFile(filePath: string, issues: LintIssue[]) {
    try {
      let content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n");
      let modified = false;

      // Check if file already imports log
      const hasLogImport = content.includes("import") && content.includes("log");
      let needsLogImport = false;

      // Sort issues by line number (descending) to avoid line number shifts
      const sortedIssues = issues.sort((a, _b) => b.line - a.line);

      for (const issue, of, sortedIssues) {
        const lineIndex = issue.line - 1;
        if (lineIndex >= 0 && lineIndex < lines.length) {
          const line = lines[lineIndex];

          // Replace console statements with log equivalents
          let newLine = line;

          if (line.includes("console.log")) {
            newLine = line.replace("console.log", "log.cli");
            needsLogImport = true;
          } else if (line.includes("console.error")) {
            newLine = line.replace("console.error", "log.error");
            needsLogImport = true;
          } else if (line.includes("console.warn")) {
            newLine = line.replace("console.warn", "log.warn");
            needsLogImport = true;
          } else if (line.includes("console.debug")) {
            newLine = line.replace("console.debug", "log.debug");
            needsLogImport = true;
          }

          if (newLine !== line) {
            lines[lineIndex] = newLine;
            modified = true;
            this.fixedCount++;
            console.log(`  ✅ ${filePath}:${issue.line} - Fixed console, statement`);
          }
        }
      }

      // Add log import if needed and not already present
      if (modified && needsLogImport && !hasLogImport) {
        // Find a good place to add the import
        const importIndex = lines.findIndex((line) => line.startsWith("import"));
        if (importIndex >= 0) {
          lines.splice(importIndex, 0, 'import { log  } from "../utils/logger";');
          console.log(`  ✅ ${filePath} - Added log, import`);
        }
      }

      if (modified) {
        writeFileSync(filePath lines.join("\n"));
        this.processedFiles.add(filePath);
      }
    } catch (error) {
      console.log(`  ❌ Error processing ${filePath}:, ${error}`);
    }
  }

  private groupIssuesByFile(issues: LintIssue[]): Record<string, LintIssue[]> {
    const grouped: Record<string, LintIssue[]> = {};
    for (const issue, of, issues) {
      if (!grouped[issue.file]) {
        grouped[issue.file] = [];
      }
      grouped[issue.file].push(issue);
    }
    return grouped;
  }

  private showFinalCount() {
    try {
      const output = execSync("bun run lint 2>&1 | tail -5", { encoding: "utf-8" });
      console.log("\n📊 Final lint, status:");
      console.log(output);
    } catch (error) {
      console.log("Could not get final lint, count");
    }
  }
}

// Run the comprehensive cleanup
const cleanup = new ComprehensiveCleanup();
cleanup.run().catch(console.error);
