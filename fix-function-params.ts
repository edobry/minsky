#!/usr/bin/env bun

import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

// Get all function parameter issues
const eslintOutput = execSync("bun eslint . 2>&1", { encoding: "utf-8" });
const parameterIssues = eslintOutput
  .split("\n")
  .filter((line) => line.includes("Allowed unused args must match"))
  .map((line) => {
    const match = line.match(/^(.+?):(\d+):(\d+)\s+warning\s+'([^']+)' is defined but never used/);
    if (match) {
      return {
        file: match[1].trim(),
        line: parseInt(match[2]),
        column: parseInt(match[3]),
        paramName: match[4],
      };
    }
    return null;
  })
  .filter(Boolean);

console.log(`Found ${parameterIssues.length} function parameter issues`);

let fixedCount = 0;

for (const issue of parameterIssues) {
  try {
    const content = readFileSync(issue.file, "utf-8");
    const lines = content.split("\n");

    // Get the problematic line
    const lineIndex = issue.line - 1;
    const line = lines[lineIndex];

    // Simple replacement: paramName -> _paramName for function parameters
    // Use word boundaries to avoid replacing parts of other identifiers
    const regex = new RegExp(`\\b${issue.paramName}\\b(?=\\s*[,:])`);

    if (regex.test(line)) {
      const newLine = line.replace(regex, `_${issue.paramName}`);
      lines[lineIndex] = newLine;

      const newContent = lines.join("\n");
      writeFileSync(issue.file, newContent);

      fixedCount++;
      console.log(
        `✓ Fixed ${issue.paramName} -> _${issue.paramName} in ${issue.file}:${issue.line}`
      );
    }
  } catch (error) {
    console.error(`✗ Error fixing ${issue.file}:${issue.line}:`, error.message);
  }
}

console.log(`\nFixed ${fixedCount}/${parameterIssues.length} function parameter issues`);
