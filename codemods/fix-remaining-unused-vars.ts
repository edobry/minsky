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

  // Enhanced unused variable cleanup
  const fixes = [
    // 1. Remove remaining ___error and ___e variable declarations
    {
      pattern: /^\s*const\s+___error\s*[=:][^;]*[;]?\s*$/gm,
      replacement: "",
      description: "Remove remaining ___error variable declarations"
    },
    {
      pattern: /^\s*const\s+___e\s*[=:][^;]*[;]?\s*$/gm,
      replacement: "",
      description: "Remove remaining ___e variable declarations"
    },
    
    // 2. Fix remaining catch blocks
    {
      pattern: /catch\s*\(\s*___error\s*\)\s*\{/g,
      replacement: "catch {",
      description: "Convert remaining catch blocks to parameterless"
    },
    {
      pattern: /catch\s*\(\s*___e\s*\)\s*\{/g,
      replacement: "catch {",
      description: "Convert remaining catch blocks to parameterless"
    },
    
    // 3. Prefix remaining unused function parameters
    {
      pattern: /(\([^)]*?)(\b(?:options|branch|content|command|args|ctx|workingDir|taskId)\b)(\s*[,:][^,)]+)/g,
      replacement: "$1_$2$3",
      description: "Prefix remaining unused function parameters"
    },
    
    // 4. Fix destructuring assignments with unused variables
    {
      pattern: /const\s*\{\s*([^}]*?)\b(options|branch|content|command|args|ctx|workingDir|taskId)\b([^}]*?)\s*\}/g,
      replacement: "const { $1_$2$3 }",
      description: "Prefix unused destructured variables"
    },
    
    // 5. Fix arrow function parameters
    {
      pattern: /(\([^)]*?)(\b(?:options|branch|content|command|args|ctx|workingDir|taskId)\b)(\s*(?::\s*[^,)]+)?)/g,
      replacement: "$1_$2$3",
      description: "Prefix unused arrow function parameters"
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
