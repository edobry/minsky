/**
 * Single to Double Quotes Conversion Codemod
 *
 * PROBLEM SOLVED:
 * Converts single quotes to double quotes in string literals throughout the codebase
 * to maintain consistent quote usage according to project style standards.
 *
 * EXACT SITUATION:
 * - Single-quoted string literals: 'hello world'
 * - Mixed quote usage causing style inconsistency
 * - Need to standardize on double quotes for string literals
 * - Preserve template literals (backticks) and character literals unchanged
 *
 * TRANSFORMATION APPLIED:
 * - Converts 'single quoted strings' to "double quoted strings"
 * - Escapes existing double quotes within converted strings
 * - Avoids template literals and character literals
 * - Processes only TypeScript files, excluding test files
 *
 * CONFIGURATION:
 * - Processes all TypeScript files in src directory
 * - Ignores test files (*.test.ts, *.spec.ts)
 * - Ignores node_modules directory
 * - Uses regex pattern matching for string detection
 *
 * SAFETY CONSIDERATIONS:
 * - Uses complex regex to avoid template literals and character literals
 * - Properly escapes existing double quotes in converted strings
 * - Only processes TypeScript files to avoid unintended changes
 * - Preserves string content while changing quote style
 *
 * LIMITATIONS:
 * - **CRITICAL BUG**: The regex pattern is overly restrictive and fails to match basic string literals
 * - The negative lookbehind/lookahead for template literals prevents matching in most contexts
 * - Regex-based approach may miss complex edge cases
 * - Could potentially modify strings within comments or unusual contexts
 * - Does not perform AST analysis for guaranteed accuracy
 * - May not handle all possible string escape sequences correctly
 * 
 * **STATUS**: This codemod appears to be non-functional due to regex issues
 */

import { readFileSync, writeFileSync } from "fs";
import { globSync } from "glob";

const files = globSync("src/**/*.ts", {
  ignore: ["**/*.test.ts", "**/*.spec.ts", "**/node_modules/**"],
});

let totalChanges = 0;
const changedFiles = new Set<string>();

for (const file of files) {
  const content = readFileSync(file, "utf8") as string;
  let newContent = content;
  let fileChanges = 0;

  // Convert single quotes to double quotes
  const fixes = [
    // 1. Simple string literals - avoid template literals and character literals
    {
      pattern: /(?<!`[^`]*)'([^'\\]|\\.|\\\\)*'(?![^`]*`)/g,
      replacement: (match: string) => {
        // Remove outer single quotes and add double quotes
        const inner = match.slice(1, -1);
        // Escape any existing double quotes in the string
        const escaped = inner.replace(/"/g, '\\"');
        return `"${escaped}"`;
      },
      description: "Convert single quotes to double quotes"
    }
  ];

  for (const fix of fixes) {
    const matches = Array.from(newContent.matchAll(fix.pattern));
    if (matches.length > 0) {
      const beforeReplace = newContent;
      if (typeof fix.replacement === 'function') {
        for (const match of matches.reverse()) {
          const replacement = fix.replacement(match[0]);
          newContent = newContent.slice(0, match.index!) + replacement + newContent.slice(match.index! + match[0].length);
        }
      } else {
        newContent = newContent.replace(fix.pattern, fix.replacement);
      }
      // Only count if content actually changed
      if (newContent !== beforeReplace) {
        fileChanges += matches.length;
      }
    }
  }

  if (fileChanges > 0) {
    writeFileSync(file, newContent);
    changedFiles.add(file);
    totalChanges += fileChanges;
    console.log(`${file}: ${fileChanges} changes`);
  }
}

console.log(`\nTotal: ${totalChanges} changes across ${changedFiles.size} files`); 
