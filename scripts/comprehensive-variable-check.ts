#!/usr/bin/env bun

import { readFile } from "fs/promises";
import { glob } from "glob";
import * as ts from "typescript";

interface VariableIssue {
  file: string;
  line: number;
  column: number;
  variable: string;
  type: "undefined" | "parameter_mismatch" | "scope_issue";
  context: string;
}

async function analyzeFile(filePath: string): Promise<VariableIssue[]> {
  const issues: VariableIssue[] = [];

  try {
    const content = await readFile(filePath, "utf-8");
    const contentStr = typeof content === "string" ? content : content.toString();
    const sourceFile = ts.createSourceFile(filePath, contentStr, ts.ScriptTarget.Latest, true);

    // Create a program to get type checker
    const program = ts.createProgram([filePath], {
      allowJs: true,
      checkJs: false,
      noEmit: true,
      skipLibCheck: true,
    });

    const checker = program.getTypeChecker();
    const diagnostics = ts.getPreEmitDiagnostics(program, sourceFile);

    // Look for "Cannot find name" errors
    for (const diagnostic of diagnostics) {
      if (
        diagnostic.messageText &&
        typeof diagnostic.messageText === "string" &&
        diagnostic.messageText.includes("Cannot find name")
      ) {
        const match = diagnostic.messageText.match(/Cannot find name '([^']+)'/);
        if (match && match[1] && diagnostic.start !== undefined) {
          const position = sourceFile.getLineAndCharacterOfPosition(diagnostic.start);
          const lines = sourceFile.text.split("\n");
          const line = lines[position.line];

          if (line !== undefined) {
            issues.push({
              file: filePath,
              line: position.line + 1,
              column: position.character + 1,
              variable: match[1],
              type: "undefined",
              context: line.trim(),
            });
          }
        }
      }
    }

    return issues;
  } catch (error) {
    console.error(`Error analyzing ${filePath}:`, error);
    return [];
  }
}

async function main() {
  console.log("Running comprehensive variable naming check...");

  const files = await glob("src/**/*.ts", {
    ignore: ["src/**/*.test.ts", "src/**/*.d.ts", "src/__fixtures__/**/*"],
  });

  console.log(`Checking ${files.length} TypeScript files...`);

  const allIssues: VariableIssue[] = [];

  for (const file of files) {
    const issues = await analyzeFile(file);
    allIssues.push(...issues);
  }

  if (allIssues.length === 0) {
    console.log("✅ No variable naming issues found!");
    return;
  }

  console.log(`\n❌ Found ${allIssues.length} variable naming issues:\n`);

  // Group by file
  const issuesByFile = allIssues.reduce(
    (acc, issue) => {
      if (!acc[issue.file]) acc[issue.file] = [];
      acc[issue.file]!.push(issue);
      return acc;
    },
    {} as Record<string, VariableIssue[]>
  );

  for (const [file, issues] of Object.entries(issuesByFile)) {
    if (issues && issues.length > 0) {
      console.log(`📄 ${file} (${issues.length} issues):`);
      for (const issue of issues) {
        console.log(`  Line ${issue.line}: Cannot find name '${issue.variable}'`);
        console.log(`    Context: ${issue.context}`);
      }
      console.log();
    }
  }

  // Summary by variable name
  const variableCounts = allIssues.reduce(
    (acc, issue) => {
      acc[issue.variable] = (acc[issue.variable] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  console.log("📊 Most common undefined variables:");
  Object.entries(variableCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .forEach(([variable, count]) => {
      console.log(`  ${variable}: ${count} occurrences`);
    });
}

if (require.main === module) {
  main().catch(console.error);
}
