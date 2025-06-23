#!/usr/bin/env bun

import { readFileSync, readdirSync, statSync } from "fs";
import { join, extname } from "path";

interface VariableNamingIssue {
  file: string;
  line: number;
  type: "catch-block" | "function-param" | "destructuring";
  description: string;
  code: string;
}

function getAllTsFiles(dir: string): string[] {
  const files: string[] = [];

  function traverse(currentDir: string) {
    const items = readdirSync(currentDir);

    for (const item of items) {
      const fullPath = join(currentDir, item);
      const stat = statSync(fullPath);

      if (stat.isDirectory() && !item.startsWith(".") && item !== "node_modules") {
        traverse(fullPath);
      } else if (stat.isFile() && extname(item) === ".ts") {
        files.push(fullPath);
      }
    }
  }

  traverse(dir);
  return files;
}

function checkFile(filePath: string): VariableNamingIssue[] {
  const issues: VariableNamingIssue[] = [];
  const content = readFileSync(filePath, "utf8");
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;

    // Check for catch blocks with underscore parameters
    const catchMatch = line.match(/catch\s*\(\s*(_\w+)\s*\)/);
    if (catchMatch) {
      const underscoreVar = catchMatch[1];
      const varWithoutUnderscore = underscoreVar.slice(1);

      // Look for usage of the variable without underscore in the next 20 lines
      for (let j = i + 1; j < Math.min(i + 21, lines.length); j++) {
        const nextLine = lines[j];

        // Skip if we hit another catch or function
        if (nextLine.includes("catch") || nextLine.includes("function")) break;
        if (nextLine.includes("}") && nextLine.trim() === "}") break;

        // Check for usage without underscore
        const regex = new RegExp(`\\b${varWithoutUnderscore}\\b(?!_)`);
        if (regex.test(nextLine) && !nextLine.includes(underscoreVar)) {
          issues.push({
            file: filePath,
            line: lineNumber,
            type: "catch-block",
            description: `Catch parameter '${underscoreVar}' referenced as '${varWithoutUnderscore}' on line ${j + 1}`,
            code: line.trim(),
          });
          break;
        }
      }
    }

    // Check for function parameters with underscores
    const funcMatch = line.match(/function\s+\w+\s*\([^)]*(_\w+)[^)]*/);
    if (funcMatch) {
      const underscoreParam = funcMatch[1];
      const paramWithoutUnderscore = underscoreParam.slice(1);

      // Look for usage without underscore in function body
      let braceCount = 0;
      let inFunction = false;

      for (let j = i; j < lines.length; j++) {
        const nextLine = lines[j];

        if (nextLine.includes("{")) {
          braceCount += (nextLine.match(/\{/g) || []).length;
          inFunction = true;
        }
        if (nextLine.includes("}")) {
          braceCount -= (nextLine.match(/\}/g) || []).length;
        }

        if (inFunction && braceCount === 0) break;

        if (inFunction && j > i) {
          const regex = new RegExp(`\\b${paramWithoutUnderscore}\\b(?!_)`);
          if (regex.test(nextLine) && !nextLine.includes(underscoreParam)) {
            issues.push({
              file: filePath,
              line: lineNumber,
              type: "function-param",
              description: `Function parameter '${underscoreParam}' referenced as '${paramWithoutUnderscore}' on line ${j + 1}`,
              code: line.trim(),
            });
            break;
          }
        }
      }
    }

    // Check for arrow function parameters with underscores
    const arrowMatch = line.match(/\(\s*([^)]*_\w+[^)]*)\s*\)\s*=>/);
    if (arrowMatch) {
      const params = arrowMatch[1];
      const underscoreParams = params.match(/_\w+/g) || [];

      for (const underscoreParam of underscoreParams) {
        const paramWithoutUnderscore = underscoreParam.slice(1);

        // Look for usage in the arrow function body
        let braceCount = 0;
        let inFunction = false;

        for (let j = i; j < lines.length; j++) {
          const nextLine = lines[j];

          if (nextLine.includes("{")) {
            braceCount += (nextLine.match(/\{/g) || []).length;
            inFunction = true;
          }
          if (nextLine.includes("}")) {
            braceCount -= (nextLine.match(/\}/g) || []).length;
          }

          if (inFunction && braceCount === 0) break;

          if (j > i) {
            const regex = new RegExp(`\\b${paramWithoutUnderscore}\\b(?!_)`);
            if (regex.test(nextLine) && !nextLine.includes(underscoreParam)) {
              issues.push({
                file: filePath,
                line: lineNumber,
                type: "function-param",
                description: `Arrow function parameter '${underscoreParam}' referenced as '${paramWithoutUnderscore}' on line ${j + 1}`,
                code: line.trim(),
              });
              break;
            }
          }
        }
      }
    }
  }

  return issues;
}

function main() {
  const srcDir = "src";
  const files = getAllTsFiles(srcDir);

  console.log(`Checking ${files.length} TypeScript files for variable naming issues...\n`);

  let totalIssues = 0;
  const issuesByFile: Record<string, VariableNamingIssue[]> = {};

  for (const file of files) {
    const issues = checkFile(file);
    if (issues.length > 0) {
      issuesByFile[file] = issues;
      totalIssues += issues.length;
    }
  }

  if (totalIssues === 0) {
    console.log("✅ No variable naming issues found!");
    return;
  }

  console.log(`❌ Found ${totalIssues} potential variable naming issues:\n`);

  for (const [file, issues] of Object.entries(issuesByFile)) {
    console.log(`📁 ${file}`);
    for (const issue of issues) {
      console.log(`  Line ${issue.line}: ${issue.description}`);
      console.log(`    ${issue.code}`);
    }
    console.log();
  }

  console.log(`\nTotal issues: ${totalIssues}`);
  console.log("\nRecommendations:");
  console.log("1. Fix catch blocks: change catch(_error) to catch(error)");
  console.log("2. Fix function parameters: change _param to param if used in body");
  console.log("3. Keep underscores only for truly unused parameters");

  return;
}

if (import.meta.main) {
  main();
}
