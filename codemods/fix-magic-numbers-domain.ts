import { readFileSync, writeFileSync } from "fs";
import { globSync } from "glob";

const files = globSync("src/**/*.ts", {
  ignore: ["**/*.test.ts", "**/*.spec.ts", "**/node_modules/**", "**/constants.ts"],
});

let totalChanges = 0;
const changedFiles = new Set<string>();

for (const file of files) {
  const content = readFileSync(file, "utf8") as string;
  let newContent = content;
  let fileChanges = 0;

  // Domain-specific magic number replacements
  const replacements = [
    // Port numbers (11 instances of 8080)
    {
      pattern: /\b8080\b/g,
      replacement: "DEFAULT_DEV_PORT",
      importName: "DEFAULT_DEV_PORT",
      description: "Replace port 8080 with DEFAULT_DEV_PORT"
    },
    
    // HTTP status codes (5 instances of 200)
    {
      pattern: /\b200\b/g,
      replacement: "HTTP_OK", 
      importName: "HTTP_OK",
      description: "Replace HTTP 200 with HTTP_OK"
    },
    
    // Timeouts (8 instances of 30000)
    {
      pattern: /\b30000\b/g,
      replacement: "DEFAULT_TIMEOUT_MS",
      importName: "DEFAULT_TIMEOUT_MS", 
      description: "Replace 30000ms with DEFAULT_TIMEOUT_MS"
    },
    
    // Retry counts (17 instances of 5)
    {
      pattern: /(?<![0-9])\b5\b(?![0-9])/g,
      replacement: "DEFAULT_RETRY_COUNT",
      importName: "DEFAULT_RETRY_COUNT",
      description: "Replace retry count 5 with DEFAULT_RETRY_COUNT"
    },
    
    // Memory sizes (12 instances of 1024)
    {
      pattern: /\b1024\b/g,
      replacement: "BYTES_PER_KB",
      importName: "BYTES_PER_KB",
      description: "Replace 1024 with BYTES_PER_KB"
    },
    
    // Time intervals (10 instances of 60)
    {
      pattern: /\b60\b(?=\s*[*]|$)/g,
      replacement: "MINUTE_IN_SECONDS",
      importName: "MINUTE_IN_SECONDS",
      description: "Replace 60 seconds with MINUTE_IN_SECONDS"
    }
  ];

  const importsNeeded = new Set<string>();
  
  for (const replacement of replacements) {
    const matches = newContent.match(replacement.pattern);
    if (matches) {
      newContent = newContent.replace(replacement.pattern, replacement.replacement);
      importsNeeded.add(replacement.importName);
      fileChanges += matches.length;
    }
  }

  // Add import statement if we made changes
  if (importsNeeded.size > 0) {
    const importList = Array.from(importsNeeded).join(", ");
    const importStatement = `import { ${importList} } from "../utils/constants";\n`;
    
    // Check if there's already an import section
    if (newContent.includes("import")) {
      // Add after last import
      newContent = newContent.replace(
        /(import[^;]+;[\s]*\n)/g,
        `$1`
      );
      newContent = newContent.replace(
        /(import[^;]+;\s*\n)([\s]*\n)*/,
        `$1${importStatement}$2`
      );
    } else {
      // Add at the beginning
      newContent = importStatement + "\n" + newContent;
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
