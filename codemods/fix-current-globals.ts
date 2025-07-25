import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

// Get all TypeScript files recursively
function getAllTsFiles(dir: string): string[] {
  const files: string[] = [];

  function traverse(currentDir: string) {
    const entries = readdirSync(currentDir);

    for (const entry of entries) {
      const fullPath = join(currentDir, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        // Skip node_modules and other unwanted directories
        if (!["node_modules", ".git", "dist", "build"].includes(entry)) {
          traverse(fullPath);
        }
      } else if (entry.endsWith(".ts") || entry.endsWith(".js")) {
        files.push(fullPath);
      }
    }
  }

  traverse(dir);
  return files;
}

const files = getAllTsFiles("src");
let totalChanges = 0;
const changedFiles = new Set<string>();

for (const file of files) {
  const content = readFileSync(file, "utf8") as string;
  let newContent = content;
  let fileChanges = 0;

  // Fix console statements - replace with proper logging
  const consoleReplacements = [
    { pattern: /console\.log\(/g, replacement: "log.debug(" },
    { pattern: /console\.error\(/g, replacement: "log.error(" },
    { pattern: /console\.warn\(/g, replacement: "log.warn(" },
    { pattern: /console\.info\(/g, replacement: "log.info(" },
  ];

  for (const fix of consoleReplacements) {
    const matches = newContent.match(fix.pattern);
    if (matches) {
      newContent = newContent.replace(fix.pattern, fix.replacement);
      fileChanges += matches.length;

      // Add log import if not present and we made console replacements
      if (
        !newContent.includes("import { log }") &&
        !newContent.includes('from "../utils/logger"')
      ) {
        const importMatch = newContent.match(/^(import.*?\n)+/m);
        if (importMatch) {
          const importSection = importMatch[0];
          const loggerImport = 'import { log } from "../utils/logger";\n';
          newContent = newContent.replace(importSection, importSection + loggerImport);
          fileChanges++;
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
