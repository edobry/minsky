#!/usr/bin/env bun

import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

interface ErrorPattern {
  file: string;
  line: number;
  pattern: string;
  context: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM";
}

function findAllTsFiles(dir: string): string[] {
  const files: string[] = [];

  function traverse(currentDir: string) {
    const entries = readdirSync(currentDir);

    for (const entry of entries) {
      const fullPath = join(currentDir, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory() && !entry.startsWith(".") && entry !== "node_modules") {
        traverse(fullPath);
      } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
        files.push(fullPath);
      }
    }
  }

  traverse(dir);
  return files;
}

function analyzeFile(filePath: string): ErrorPattern[] {
  const patterns: ErrorPattern[] = [];

  try {
    const content = readFileSync(filePath, "utf8") as string;
    const lines = (content).toString().split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Pattern 1: const _error = err (where err is not defined)
      if (line.includes("const _error = err")) {
        patterns.push({
          file: filePath,
          line: lineNum,
          pattern: "const _error = err",
          context: lines.slice(Math.max(0, i - 2), i + 3).join("\n"),
          severity: "CRITICAL",
        });
      }

      // Pattern 2: catch (_error) followed by references to error (not _error)
      if (line.includes("} catch (_error)")) {
        // Look ahead for references to 'error' instead of '_error'
        for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
          if (lines[j].includes("error.") && !lines[j].includes("_error.")) {
            patterns.push({
              file: filePath,
              line: j + 1,
              pattern: "catch(_error) but uses error",
              context: lines.slice(Math.max(0, i - 1), j + 2).join("\n"),
              severity: "CRITICAL",
            });
            break;
          }
        }
      }

      // Pattern 3: References to undefined variables that could be _error
      const errorVarMatch = line.match(/\b(error|_error)\b/g);
      if (errorVarMatch) {
        // Check if this line references error/Error but might be in wrong scope
        if (line.includes("error.message") || line.includes("error instanceof")) {
          // Look back to see if there's a catch block
          let foundCatch = false;
          for (let j = Math.max(0, i - 20); j < i; j++) {
            if (lines[j].includes("} catch (") && !lines[j].includes("} catch (error)")) {
              patterns.push({
                file: filePath,
                line: lineNum,
                pattern: "error reference after non-error catch",
                context: lines.slice(Math.max(0, i - 3), i + 2).join("\n"),
                severity: "HIGH",
              });
              break;
            }
          }
        }
      }

      // Pattern 4: Variable name mismatches in function parameters
      if (line.includes("parse(_params)") || line.includes("parse(_options)")) {
        patterns.push({
          file: filePath,
          line: lineNum,
          pattern: "parse with underscore param",
          context: lines.slice(Math.max(0, i - 2), i + 3).join("\n"),
          severity: "HIGH",
        });
      }
    }
  } catch (error) {
    console.error(`Error analyzing ${filePath}:`, error);
  }

  return patterns;
}

function main() {
  console.log("🔍 Searching for critical error patterns...\n");

  const srcDir = "src";
  const files = findAllTsFiles(srcDir);

  let allPatterns: ErrorPattern[] = [];

  for (const file of files) {
    const patterns = analyzeFile(file);
    allPatterns = allPatterns.concat(patterns);
  }

  // Group by severity
  const critical = allPatterns.filter((p) => p.severity === "CRITICAL");
  const high = allPatterns.filter((p) => p.severity === "HIGH");
  const medium = allPatterns.filter((p) => p.severity === "MEDIUM");

  console.log(`🚨 CRITICAL ISSUES (${critical.length}):`);
  for (const pattern of critical) {
    console.log(`\n${pattern.file}:${pattern.line}`);
    console.log(`Pattern: ${pattern.pattern}`);
    console.log(`Context:\n${pattern.context}`);
    console.log("---");
  }

  console.log(`\n⚠️  HIGH PRIORITY ISSUES (${high.length}):`);
  for (const pattern of high) {
    console.log(`\n${pattern.file}:${pattern.line}`);
    console.log(`Pattern: ${pattern.pattern}`);
    console.log(`Context:\n${pattern.context}`);
    console.log("---");
  }

  console.log("\n📊 SUMMARY:");
  console.log(`Critical: ${critical.length}`);
  console.log(`High: ${high.length}`);
  console.log(`Medium: ${medium.length}`);
  console.log(`Total: ${allPatterns.length}`);

  if (critical.length > 0) {
    console.log(
      "\n🎯 FOCUS ON CRITICAL ISSUES FIRST - these are most likely causing the runtime error"
    );
    process.exit(1);
  }
}

main();
