#!/usr/bin/env bun

import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join, extname } from "path";

interface FixResult {
  file: string;
  fixesApplied: number;
  patterns: string[];
}

function getAllTsFiles(dir: string): string[] {
  const files: string[] = [];

  function traverse(currentDir: string) {
    const items = readdirSync(currentDir);

    for (const item of items) {
      const fullPath = join(currentDir, item);
      const stat = statSync(fullPath);

      if (stat.isDirectory() && !item.startsWith(".") && item !== "node_modules") {
        traverse(fullPath);
      } else if (stat.isFile() && extname(item) === ".ts") {
        files.push(fullPath);
      }
    }
  }

  traverse(dir);
  return files;
}

function fixCatchBlocks(content: string): { content: string; fixes: number } {
  let fixes = 0;

  // Pattern 1: catch (_error) { ... error.message ... }
  content = content.replace(/catch \(_error\) {([^}]*[^_])error([^_])/g, (match, middle, after) => {
    fixes++;
    return `catch (error) {${middle}error${after}`;
  });

  // Pattern 2: } catch (_error) \\n ... error instanceof ...
  const lines = content.split("\\n");
  const newLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes("} catch (_error) {") || line.includes("catch (_error) {")) {
      // Look ahead for error references without underscore
      let hasErrorReference = false;
      for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
        if (lines[j].includes("}") && !lines[j].includes("error")) break;
        if (lines[j].match(/[^_]error[^_]/)) {
          hasErrorReference = true;
          break;
        }
      }

      if (hasErrorReference) {
        newLines.push(line.replace("_error", "error"));
        fixes++;
      } else {
        newLines.push(line);
      }
    } else {
      newLines.push(line);
    }
  }

  return { content: newLines.join("\\n"), fixes };
}

function fixFunctionParameters(content: string): { content: string; fixes: number } {
  let fixes = 0;
  const lines = content.split("\\n");
  const newLines = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Simple parameter fixes for common patterns
    const parameterFixes = [
      { pattern: /_filePath: string/, replacement: "filePath: string", usage: /[^_]filePath[^_]/ },
      { pattern: /_content: string/, replacement: "content: string", usage: /[^_]content[^_]/ },
      { pattern: /_args: /, replacement: "args: ", usage: /[^_]args[^_]/ },
      { pattern: /_params: /, replacement: "params: ", usage: /[^_]params[^_]/ },
      { pattern: /_options: /, replacement: "options: ", usage: /[^_]options[^_]/ },
      { pattern: /_id: string/, replacement: "id: string", usage: /[^_]id[^_]/ },
      { pattern: /_path: string/, replacement: "path: string", usage: /[^_]path[^_]/ },
    ];

    for (const fix of parameterFixes) {
      if (line.match(fix.pattern)) {
        // Check if the function body uses the parameter without underscore
        const functionStart = i;
        let functionEnd = functionStart;
        let braceCount = 0;
        let foundOpenBrace = false;

        for (let j = functionStart; j < lines.length; j++) {
          const currentLine = lines[j];
          for (const char of currentLine) {
            if (char === "{") {
              braceCount++;
              foundOpenBrace = true;
            } else if (char === "}") {
              braceCount--;
              if (foundOpenBrace && braceCount === 0) {
                functionEnd = j;
                break;
              }
            }
          }
          if (foundOpenBrace && braceCount === 0) break;
        }

        // Check if the parameter is used without underscore in the function body
        const functionBody = lines.slice(functionStart, functionEnd + 1).join("\\n");
        if (functionBody.match(fix.usage)) {
          line = line.replace(fix.pattern, fix.replacement);
          fixes++;
        }
      }
    }

    newLines.push(line);
  }

  return { content: newLines.join("\\n"), fixes };
}

function fixFile(filePath: string): FixResult {
  try {
    const originalContent = readFileSync(filePath, "utf-8");
    let content = originalContent;
    let totalFixes = 0;
    const patterns: string[] = [];

    // Apply catch block fixes
    const catchResult = fixCatchBlocks(content);
    content = catchResult.content;
    totalFixes += catchResult.fixes;
    if (catchResult.fixes > 0) {
      patterns.push(`${catchResult.fixes} catch block fixes`);
    }

    // Apply parameter fixes
    const paramResult = fixFunctionParameters(content);
    content = paramResult.content;
    totalFixes += paramResult.fixes;
    if (paramResult.fixes > 0) {
      patterns.push(`${paramResult.fixes} parameter fixes`);
    }

    // Only write if changes were made
    if (content !== originalContent) {
      writeFileSync(filePath, content, "utf-8");
    }

    return {
      file: filePath,
      fixesApplied: totalFixes,
      patterns,
    };
  } catch (error) {
    console.error(`Error processing ${filePath}:`, error);
    return {
      file: filePath,
      fixesApplied: 0,
      patterns: [],
    };
  }
}

function main() {
  console.log("🔧 Running automated variable naming fixes...");

  const files = getAllTsFiles("src");
  const results: FixResult[] = [];

  for (const file of files) {
    const result = fixFile(file);
    if (result.fixesApplied > 0) {
      results.push(result);
      console.log(`✅ ${file}: ${result.fixesApplied} fixes (${result.patterns.join(", ")})`);
    }
  }

  console.log("\\n📊 Summary:");
  console.log(`Files processed: ${files.length}`);
  console.log(`Files modified: ${results.length}`);
  console.log(`Total fixes applied: ${results.reduce((sum, r) => sum + r.fixesApplied, 0)}`);

  if (results.length === 0) {
    console.log("✅ No variable naming issues found or no automatic fixes available.");
  } else {
    console.log("\\n🔍 Run the checker to see remaining issues:");
    console.log("bun run scripts/check-variable-naming.ts");
  }
}

if (import.meta.main) {
  main();
}
