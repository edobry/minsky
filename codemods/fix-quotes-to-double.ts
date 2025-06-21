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
