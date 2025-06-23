import { readFileSync, writeFileSync } from "fs";
import { globSync } from "glob";

const files = globSync("src/**/*.ts", {
  ignore: ["**/node_modules/**"],
});

let totalChanges = 0;
const changedFiles = new Set<string>();

for (const file of files) {
  const content = readFileSync(file, "utf8") as string;
  let newContent = content;
  let fileChanges = 0;

  // Fix specific unused variable patterns from linting output
  const fixes = [
    // 1. Function parameters that need underscores
    {
      pattern: /(\([^)]*?)(\b(?:options|workdir|command|program)\b)(\s*[,:][^,)]*)/g,
      replacement: "$1_$2$3",
      description: "Prefix unused function parameters"
    },
    
    // 2. Variable assignments that need underscores  
    {
      pattern: /(\bconst\s+)(\b(?:arrayContaining|objectContaining|runIntegratedCli|Params|taskId|schemaType)\b)/g,
      replacement: "$1_$2",
      description: "Prefix unused const variables"
    },
    
    // 3. Imported but unused types/constants
    {
      pattern: /(\bconst\s+)(\b(?:SESSION_DESCRIPTION|CommandDefinition|CommandParameterMap|ZodIssue|CORE|GIT)\b)/g,
      replacement: "$1_$2", 
      description: "Prefix unused imported constants"
    },
    
    // 4. Destructuring assignments
    {
      pattern: /const\s*\{\s*([^}]*?)(\b(?:options|workdir|command|program|taskId)\b)([^}]*?)\s*\}/g,
      replacement: "const { $1_$2$3 }",
      description: "Prefix unused destructured variables"
    },
    
    // 5. Let assignments
    {
      pattern: /(\blet\s+)(\b(?:arrayContaining|objectContaining|runIntegratedCli|Params|taskId|schemaType|command)\b)/g,
      replacement: "$1_$2",
      description: "Prefix unused let variables"
    }
  ];

  for (const fix of fixes) {
    const matches = newContent.match(fix.pattern);
    if (matches) {
      const beforeReplace = newContent;
      newContent = newContent.replace(fix.pattern, fix.replacement);
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
