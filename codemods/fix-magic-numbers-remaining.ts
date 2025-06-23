import { readFileSync, writeFileSync } from "fs";
import { globSync } from "glob";

const files = globSync("src/**/*.ts", {
  ignore: ["**/*.test.ts", "**/*.spec.ts", "**/node_modules/**"],
});

let totalChanges = 0;
const changedFiles = new Set<string>();

// Check if constants file exists, if not create it
const constantsFile = "src/utils/constants.ts";
let constantsContent = "";

try {
  constantsContent = readFileSync(constantsFile, "utf8") as string;
} catch {
  // File doesn't exist, we'll create it
  constantsContent = `// Domain-specific constants
export const DEFAULT_TIMEOUT = 30000;
export const DEFAULT_RETRY_COUNT = 5;
export const DEFAULT_SERVER_PORT = 8080;
export const MAX_RETRIES = 9;
export const DEFAULT_WORKSPACE_PORT = 80;
export const TEST_PORT = 123;
`;
  writeFileSync(constantsFile, constantsContent);
  console.log("Created constants file: src/utils/constants.ts");
}

for (const file of files) {
  const content = readFileSync(file, "utf8") as string;
  let newContent = content;
  let fileChanges = 0;
  let needsImport = false;

  // Magic number replacements
  const magicNumbers = [
    { pattern: /\b30000\b/g, replacement: "DEFAULT_TIMEOUT", name: "DEFAULT_TIMEOUT" },
    { pattern: /\b5\b/g, replacement: "DEFAULT_RETRY_COUNT", name: "DEFAULT_RETRY_COUNT" },
    { pattern: /\b8080\b/g, replacement: "DEFAULT_SERVER_PORT", name: "DEFAULT_SERVER_PORT" },
    { pattern: /\b9\b/g, replacement: "MAX_RETRIES", name: "MAX_RETRIES" },
    { pattern: /\b80\b/g, replacement: "DEFAULT_WORKSPACE_PORT", name: "DEFAULT_WORKSPACE_PORT" },
    { pattern: /\b123\b/g, replacement: "TEST_PORT", name: "TEST_PORT" }
  ];

  for (const magicNumber of magicNumbers) {
    const matches = newContent.match(magicNumber.pattern);
    if (matches) {
      // Check if this is in a meaningful context (not just any occurrence of the number)
      const contextualPattern = new RegExp(
        `(?:timeout[^=]*=\\s*|setTimeout\\([^,]*,\\s*|port[^=]*=\\s*|retries?[^=]*=\\s*)${magicNumber.pattern.source}`,
        'gi'
      );
      
      const contextualMatches = newContent.match(contextualPattern);
      if (contextualMatches) {
        const beforeReplace = newContent;
        newContent = newContent.replace(contextualPattern, 
          (match) => match.replace(magicNumber.pattern, magicNumber.replacement)
        );
        
        if (newContent !== beforeReplace) {
          fileChanges += contextualMatches.length;
          needsImport = true;
        }
      }
    }
  }

  // Add import if we made changes and don't already have it
  if (needsImport && !newContent.includes('from "../utils/constants"') && !newContent.includes('from "./constants"')) {
    // Determine the correct import path based on file location
    const relativePath = file.includes('/utils/') ? './constants' : '../utils/constants';
    
    // Find existing imports and add after them
    const importPattern = /^import\s+[^;]+;$/gm;
    const imports = newContent.match(importPattern);
    
    if (imports && imports.length > 0) {
      const lastImport = imports[imports.length - 1];
      if (lastImport) {
        const importIndex = newContent.lastIndexOf(lastImport) + lastImport.length;
      const usedConstants = magicNumbers
        .filter(mn => newContent.includes(mn.replacement))
        .map(mn => mn.name);
      
      if (usedConstants.length > 0) {
        const importStatement = `\nimport { ${usedConstants.join(', ')} } from "${relativePath}";`;
        newContent = newContent.slice(0, importIndex) + importStatement + newContent.slice(importIndex);
        fileChanges += 1;
        }
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
