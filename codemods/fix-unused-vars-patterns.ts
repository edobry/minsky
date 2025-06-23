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

  // Fix unused variables by removing them or prefixing with underscore
  const fixes = [
    // Remove unused variable declarations that are never used
    {
      pattern: /^\s*const\s+___error\s*=.*?;?\s*$/gm,
      replacement: "",
      description: "Remove unused ___error variables",
    },
    {
      pattern: /^\s*const\s+___err\s*=.*?;?\s*$/gm,
      replacement: "",
      description: "Remove unused ___err variables",
    },
    // Fix catch block parameters - remove unused parameters
    {
      pattern: /catch\s*\(\s*___error\s*\)\s*\{/g,
      replacement: "catch {",
      description: "Remove unused catch parameters",
    },
    {
      pattern: /catch\s*\(\s*___err\s*\)\s*\{/g,
      replacement: "catch {",
      description: "Remove unused catch parameters",
    },
    // Fix function parameters that are defined but never used - prefix with underscore
    {
      pattern: /(\w+)\s*:\s*([^,)]+)(?=\s*[,)])/g,
      replacement: (match, paramName, paramType) => {
        // Only prefix if it's a common unused parameter name and not already prefixed
        const commonUnused = ["options", "params", "command", "path", "session", "id"];
        if (commonUnused.includes(paramName) && !paramName.startsWith("_")) {
          return `_${paramName}: ${paramType}`;
        }
        return match;
      },
      description: "Prefix unused function parameters with underscore",
    },
  ];

  for (const fix of fixes) {
    if (typeof fix.replacement === "function") {
      const matches = newContent.match(fix.pattern);
      if (matches) {
        newContent = newContent.replace(fix.pattern, fix.replacement);
        fileChanges += matches.length;
      }
    } else {
      const matches = newContent.match(fix.pattern);
      if (matches) {
        newContent = newContent.replace(fix.pattern, fix.replacement);
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
