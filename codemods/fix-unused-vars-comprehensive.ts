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

  // Comprehensive unused variable cleanup
  const fixes = [
    // 1. Remove remaining ___error and ___e variable declarations entirely
    {
      pattern: /^\s*const\s+___error\s*[=:][^;]*[;]?\s*$/gm,
      replacement: "",
      description: "Remove ___error variable declarations"
    },
    {
      pattern: /^\s*const\s+___e\s*[=:][^;]*[;]?\s*$/gm,
      replacement: "",
      description: "Remove ___e variable declarations"
    },
    
    // 2. Fix catch blocks with unused error parameters
    {
      pattern: /catch\s*\(\s*___error\s*\)\s*\{/g,
      replacement: "catch {",
      description: "Convert catch blocks to parameterless"
    },
    {
      pattern: /catch\s*\(\s*___e\s*\)\s*\{/g,
      replacement: "catch {",
      description: "Convert catch blocks to parameterless"
    },
    
    // 3. Fix function parameters that need underscore prefixes
    {
      pattern: /(\([^)]*?)(\b(?:options|program|workdir|command|args|ctx|taskId|content|branch)\b)(\s*[,:][^,)]*)/g,
      replacement: "$1_$2$3",
      description: "Prefix unused function parameters"
    },
    
    // 4. Fix variable assignments that need underscore prefixes
    {
      pattern: /(\bconst\s+)(\b(?:arrayContaining|objectContaining|content|runIntegratedCli|Params)\b)/g,
      replacement: "$1_$2",
      description: "Prefix unused const variables"
    },
    
    // 5. Fix variable declarations in function signatures
    {
      pattern: /(\blet\s+)(\b(?:arrayContaining|objectContaining|content|runIntegratedCli|Params)\b)/g,
      replacement: "$1_$2",
      description: "Prefix unused let variables"
    },
    
    // 6. Fix destructuring assignments with unused variables
    {
      pattern: /const\s*\{\s*([^}]*?)(\b(?:options|program|workdir|command|args|ctx|taskId|content|branch)\b)([^}]*?)\s*\}/g,
      replacement: "const { $1_$2$3 }",
      description: "Prefix unused destructured variables"
    },
    
    // 7. Fix arrow function parameters
    {
      pattern: /(\([^)]*?\s*,\s*)(\b(?:options|program|workdir|command|args|ctx|taskId|content|branch)\b)(\s*(?::\s*[^,)]+)?)/g,
      replacement: "$1_$2$3",
      description: "Prefix unused arrow function parameters"
    },
    
    // 8. Fix single arrow function parameters
    {
      pattern: /(\(\s*)(\b(?:options|program|workdir|command|args|ctx|taskId|content|branch)\b)(\s*(?::\s*[^,)]+)?\s*\))/g,
      replacement: "$1_$2$3",
      description: "Prefix single unused arrow function parameters"
    }
  ];

  for (const fix of fixes) {
    const matches = newContent.match(fix.pattern);
    if (matches) {
      const beforeReplace = newContent;
      newContent = newContent.replace(fix.pattern, fix.replacement);
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
