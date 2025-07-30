#!/usr/bin/env bun

/**
 * TASK ID FORMAT NORMALIZER CODEMOD
 *
 * PURPOSE: Fix systematic task ID format mismatches in test files
 *
 * PROBLEM IDENTIFIED:
 * - Tests use display format ("#123") in mock data
 * - Business logic normalizes to storage format ("123") for lookups
 * - Results in "not found" errors despite data existing
 *
 * SOLUTION:
 * - Systematically convert task IDs in mock data to storage format
 * - Ensure test expectations match normalized format
 * - Use existing task ID utilities for consistency
 *
 * SCOPE: Test files only - never modifies production code
 */

import {
  Project,
  Node,
  SyntaxKind,
  PropertyAssignment,
  StringLiteral,
  ObjectLiteralExpression,
} from "ts-morph";
import { CodemodBase, CodemodIssue } from "./utils/codemod-framework";

interface TaskIdFormatIssue extends CodemodIssue {
  taskIdValue: string;
  normalizedValue: string;
  propertyName: string;
}

export class TaskIdFormatNormalizer extends CodemodBase {
  name = "task-id-format-normalizer";
  description =
    "Normalize task ID formats in test mock data from display (#123) to storage (123) format";

  private taskIdIssues: TaskIdFormatIssue[] = [];

  // Task ID normalization utility (matching domain logic)
  private normalizeTaskIdForStorage(taskId: string): string {
    if (!taskId) return taskId;

    // Remove # prefix and any task# prefix
    let normalized = taskId.replace(/^#/, "").replace(/^task#/, "");

    // Ensure it's a valid number-like string
    if (!/^\d+$/.test(normalized)) {
      return taskId; // Return original if not a valid number
    }

    return normalized;
  }

  private isDisplayFormat(taskId: string): boolean {
    return taskId.startsWith("#") || taskId.startsWith("task#");
  }

  private isTestFile(filePath: string): boolean {
    return filePath.includes(".test.ts") || filePath.includes(".spec.ts");
  }

  // Required abstract method implementations
  protected findIssues(): void {
    this.log("🔍 Analyzing test files for task ID format issues...");

    const sourceFiles = this.project.getSourceFiles();
    for (const sourceFile of sourceFiles) {
      const issues = this.processSourceFile(sourceFile);
      this.taskIdIssues.push(...issues);
      this.issues.push(...issues);
    }

    this.metrics.issuesFound = this.taskIdIssues.length;
    this.log(
      `Found ${this.taskIdIssues.length} task ID format issues across ${sourceFiles.length} files`
    );
  }

  protected fixIssues(): void {
    this.log("🔧 Fixing task ID format issues...");

    for (const issue of this.taskIdIssues) {
      const sourceFile = this.project.getSourceFile(issue.file);
      if (sourceFile && this.fixIssue(sourceFile, issue)) {
        this.metrics.issuesFixed++;
      }
    }

    this.log(`Fixed ${this.metrics.issuesFixed} out of ${this.taskIdIssues.length} issues`);
  }

  protected processSourceFile(sourceFile: any): TaskIdFormatIssue[] {
    const issues: TaskIdFormatIssue[] = [];

    if (!this.isTestFile(sourceFile.getFilePath())) {
      return issues; // Skip non-test files
    }

    // Find all object literal expressions (potential mock data)
    sourceFile
      .getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)
      .forEach((objLiteral: ObjectLiteralExpression) => {
        objLiteral.getProperties().forEach((property) => {
          if (Node.isPropertyAssignment(property)) {
            const propAssignment = property as PropertyAssignment;
            const propertyName = propAssignment.getName();

            // Look for taskId properties in mock data
            if (propertyName === "taskId") {
              const initializer = propAssignment.getInitializer();

              if (Node.isStringLiteral(initializer)) {
                const stringLiteral = initializer as StringLiteral;
                const taskIdValue = stringLiteral.getLiteralValue();

                if (this.isDisplayFormat(taskIdValue)) {
                  const normalizedValue = this.normalizeTaskIdForStorage(taskIdValue);

                  // Only create issue if normalization actually changes the value
                  if (normalizedValue !== taskIdValue) {
                    issues.push({
                      file: sourceFile.getFilePath(),
                      line: stringLiteral.getStartLineNumber(),
                      column: stringLiteral.getStart(),
                      description: `Task ID in display format should use storage format`,
                      context: propAssignment.getText(),
                      severity: "warning",
                      type: "task-id-format",
                      original: taskIdValue,
                      suggested: normalizedValue,
                      taskIdValue,
                      normalizedValue,
                      propertyName,
                    });
                  }
                }
              }
            }
          }
        });
      });

    return issues;
  }

  protected fixIssue(sourceFile: any, issue: TaskIdFormatIssue): boolean {
    try {
      // Find the specific string literal and replace it
      const stringLiterals = sourceFile.getDescendantsOfKind(SyntaxKind.StringLiteral);

      for (const stringLiteral of stringLiterals) {
        if (
          stringLiteral.getLiteralValue() === issue.taskIdValue &&
          stringLiteral.getStartLineNumber() === issue.line
        ) {
          // Replace with normalized format
          stringLiteral.replaceWithText(`"${issue.normalizedValue}"`);

          this.log(
            `  Fixed task ID format: ${issue.original} → ${issue.suggested} in ${issue.file}`
          );
          return true;
        }
      }

      return false;
    } catch (error) {
      this.log(`❌ Failed to fix task ID format in ${issue.file}: ${error}`);
      return false;
    }
  }

  // Additional method to find and fix session name patterns that include display format
  private fixSessionNamePatterns(sourceFile: any): number {
    let fixCount = 0;

    // Look for session property values that include display format task IDs
    sourceFile
      .getDescendantsOfKind(SyntaxKind.PropertyAssignment)
      .forEach((propAssignment: PropertyAssignment) => {
        const propertyName = propAssignment.getName();

        if (propertyName === "session") {
          const initializer = propAssignment.getInitializer();

          if (Node.isStringLiteral(initializer)) {
            const stringLiteral = initializer as StringLiteral;
            const sessionValue = stringLiteral.getLiteralValue();

            // Look for patterns like "task#456" in session names
            const taskIdMatch = sessionValue.match(/^task#(\d+)$/);
            if (taskIdMatch) {
              const taskNumber = taskIdMatch[1];
              // Keep the session name as "task#456" since that's how sessions are actually named
              // This is correct - we only want to normalize the taskId field, not session names
              this.log(`  Session name "${sessionValue}" correctly uses display format`);
            }
          }
        }
      });

    return fixCount;
  }

  public async run(): Promise<void> {
    console.log("🔧 Starting Task ID Format Normalizer...");
    console.log(`📁 Target: Test files with task ID format mismatches`);
    console.log(`🎯 Goal: Normalize display format (#123) to storage format (123) in mock data`);

    const startTime = Date.now();
    const project = new Project({
      tsConfigFilePath: "tsconfig.json",
    });

    // Focus on test files that are most likely to have the issue
    const testFilePatterns = ["src/**/*.test.ts", "tests/**/*.test.ts", "src/**/*.spec.ts"];

    const sourceFiles = project.getSourceFiles(testFilePatterns);
    console.log(`📋 Found ${sourceFiles.length} test files to process`);

    let totalIssues = 0;
    let totalFixed = 0;
    let filesChanged = 0;

    for (const sourceFile of sourceFiles) {
      const issues = this.processSourceFile(sourceFile);
      totalIssues += issues.length;

      if (issues.length > 0) {
        console.log(`\n📄 Processing ${sourceFile.getFilePath()}`);
        console.log(`   Found ${issues.length} task ID format issues`);

        let fileFixed = 0;
        for (const issue of issues) {
          if (this.fixIssue(sourceFile, issue)) {
            fileFixed++;
            totalFixed++;
          }
        }

        // Also check for session name patterns
        const sessionFixes = this.fixSessionNamePatterns(sourceFile);

        if (fileFixed > 0) {
          filesChanged++;
          console.log(`   ✅ Fixed ${fileFixed} task ID format issues`);
        }
      }
    }

    // Save all changes
    if (totalFixed > 0) {
      await project.save();
      console.log(`\n💾 Saved changes to ${filesChanged} files`);
    }

    const endTime = Date.now();
    const duration = endTime - startTime;

    console.log(`\n📊 TASK ID FORMAT NORMALIZATION COMPLETE`);
    console.log(`   Files processed: ${sourceFiles.length}`);
    console.log(`   Issues found: ${totalIssues}`);
    console.log(`   Issues fixed: ${totalFixed}`);
    console.log(`   Files changed: ${filesChanged}`);
    console.log(
      `   Success rate: ${totalIssues > 0 ? Math.round((totalFixed / totalIssues) * 100) : 100}%`
    );
    console.log(`   Duration: ${duration}ms`);

    if (totalFixed > 0) {
      console.log(`\n🎉 Successfully normalized task ID formats in test mock data!`);
      console.log(`   This should resolve session lookup failures caused by format mismatches.`);
    } else {
      console.log(
        `\n✨ No task ID format issues found - all test data already uses correct storage format!`
      );
    }
  }
}

// Execute the codemod if run directly
if (import.meta.main) {
  const normalizer = new TaskIdFormatNormalizer({
    includePatterns: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    excludePatterns: ["node_modules/**"],
    verbose: true,
  });

  normalizer.run().catch(console.error);
}
