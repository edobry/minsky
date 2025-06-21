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

  // Fix patterns in order of frequency
  const fixes = [
    // 1. Remove unused ___error and ___err variable declarations (252 total)
    {
      pattern: /^\s*const\s+___error\s*=.*?;?\s*$/gm,
      replacement: "",
      description: "Remove unused ___error variable declarations"
    },
    {
      pattern: /^\s*const\s+___err\s*=.*?;?\s*$/gm,
      replacement: "",
      description: "Remove unused ___err variable declarations"
    },
    {
      pattern: /^\s*const\s+___e\s*=.*?;?\s*$/gm,
      replacement: "",
      description: "Remove unused ___e variable declarations"
    },
    
    // 2. Fix catch blocks with unused parameters (convert to parameterless catch)
    {
      pattern: /catch\s*\(\s*___error\s*\)/g,
      replacement: "catch",
      description: "Remove unused catch parameters (___error)"
    },
    {
      pattern: /catch\s*\(\s*___err\s*\)/g,
      replacement: "catch",
      description: "Remove unused catch parameters (___err)"
    },
    {
      pattern: /catch\s*\(\s*___e\s*\)/g,
      replacement: "catch",
      description: "Remove unused catch parameters (___e)"
    },

    // 3. Prefix unused function parameters with underscore (73 issues)
    {
      pattern: /(\([^)]*?)(\b(?:options|path|session|id|branch|repoPath|data)\b)(\s*:\s*[^,)]+)/g,
      replacement: "$1_$2$3",
      description: "Prefix unused function parameters with underscore"
    },
  ];

  for (const fix of fixes) {
    const matches = newContent.match(fix.pattern);
    if (matches) {
      newContent = newContent.replace(fix.pattern, fix.replacement);
      fileChanges += matches.length;
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
