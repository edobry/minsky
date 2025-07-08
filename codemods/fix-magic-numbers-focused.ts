import { readFileSync, writeFileSync } from "fs";
import { globSync } from "glob";

const files = globSync("src/**/*.ts", {
  ignore: ["**/node_modules/**"],
});

let totalChanges = 0;
const changedFiles = new Set<string>();

// Check if constants file exists, create if not
const constantsFile = "src/utils/constants.ts";
let constantsContent = "";

try {
  constantsContent = readFileSync(constantsFile, "utf8") as string;
} catch {
  // Create the constants file with domain-specific constants
  constantsContent = `// Domain-specific constants for configuration and timeouts
export const DEFAULT_TIMEOUT_MS = 30000;
export const DEFAULT_RETRY_COUNT = 5;
export const SECONDS_PER_MINUTE = 60;
export const MAX_RETRIES = 9;
export const WAIT_DELAY_SECONDS = 7;
export const CONNECTION_RETRY_COUNT = 4;
`;
  writeFileSync(constantsFile, constantsContent);
  console.log("Created constants file: src/utils/constants.ts");
}

for (const file of files) {
  const content = readFileSync(file, "utf8") as string;
  let newContent = content;
  let fileChanges = 0;
  let needsImport = false;

  // Magic number replacements with contextual matching
  const magicNumbers = [
    { 
      pattern: /(\btimeout.*?[:=]\s*)30000\b/gi, 
      replacement: "$1DEFAULT_TIMEOUT_MS", 
      name: "DEFAULT_TIMEOUT_MS",
      description: "30000ms timeouts"
    },
    { 
      pattern: /(\bretry.*?[:=]\s*)5\b/gi, 
      replacement: "$1DEFAULT_RETRY_COUNT", 
      name: "DEFAULT_RETRY_COUNT",
      description: "5 retry attempts"
    },
    { 
      pattern: /(\bseconds.*?[:=]\s*)60\b/gi, 
      replacement: "$1SECONDS_PER_MINUTE", 
      name: "SECONDS_PER_MINUTE",
      description: "60 seconds"
    },
    { 
      pattern: /(\bmax.*?[:=]\s*)9\b/gi, 
      replacement: "$1MAX_RETRIES", 
      name: "MAX_RETRIES",
      description: "9 max retries"
    },
    { 
      pattern: /(\bwait.*?[:=]\s*)7\b/gi, 
      replacement: "$1WAIT_DELAY_SECONDS", 
      name: "WAIT_DELAY_SECONDS",
      description: "7 second delays"
    },
    { 
      pattern: /(\bconnect.*?[:=]\s*)4\b/gi, 
      replacement: "$1CONNECTION_RETRY_COUNT", 
      name: "CONNECTION_RETRY_COUNT",
      description: "4 connection retries"
    }
  ];

  for (const magicNumber of magicNumbers) {
    const matches = newContent.match(magicNumber.pattern);
    if (matches) {
      const beforeReplace = newContent;
      newContent = newContent.replace(magicNumber.pattern, magicNumber.replacement);
      
      if (newContent !== beforeReplace) {
        fileChanges += matches.length;
        needsImport = true;
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
