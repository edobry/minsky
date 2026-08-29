#!/usr/bin/env bun

import { readFileSync, readdirSync, statSync } from "fs";
import { join, extname } from "path";

interface VariableNamingIssue {
  file: string;
  line: number;
  type: "catch-block" | "function-param" | "destructuring";
  description: string;
  code: string;
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

/**
 * Remove the parts of a line that cannot contain a variable REFERENCE: string
 * and template literals, then comments.
 *
 * This scanner is line-based, so before mt#4719 a bare `\bname\b` test counted
 * English prose in a comment and values inside string literals as uses. All four
 * false positives on `main` came from that: `_text` was reported "referenced" by
 * the word "text" in the sentence `// Defaults to a text that EXTENDS ...`.
 *
 * Order matters — literals are stripped BEFORE comments, so a `//` inside a
 * string (`"http://x"`) does not truncate the line at the wrong place.
 *
 * Deliberately approximate: a block comment or template literal spanning several
 * lines is only stripped on the lines carrying its delimiters. That direction is
 * safe. An unstripped line can only ADD a false positive — the class this
 * reduces — and never removes a real reference.
 */
export function stripNonCode(line: string): string {
  return line
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``")
    .replace(/\/\*.*?\*\//g, " ")
    .replace(/\/\/.*$/, " ")
    .replace(/\/\*.*$/, " ");
}

/**
 * Whether `name` appears on `line` as an actual READ of the binding.
 *
 * Two shapes match `\bname\b` without reading anything, and both produced
 * false positives on `main` (mt#4719):
 *
 * - **`name:`** — an object-literal KEY or a TypeScript type annotation.
 *   `type: "depends" as const` was reported as a use of an unused `_type`
 *   parameter. Shorthand `{ name }` carries no colon and still counts, which is
 *   correct: that one IS a read.
 * - **`obj.name`** — a property access. `r.type` reads a property of `r`, not
 *   the enclosing `_type`.
 *
 * The colon test requires the colon to be ADJACENT, so a ternary's `a ? b : c`
 * (which prettier always spaces) is still treated as a reference.
 */
export function referencesIdentifier(line: string, name: string): boolean {
  const code = stripNonCode(line);
  const regex = new RegExp(`\\b${name}\\b(?!_)`, "g");
  let match: RegExpExecArray | null;

  while ((match = regex.exec(code)) !== null) {
    const after = code.slice(match.index + name.length);
    if (/^:/.test(after)) continue;
    const before = code.slice(0, match.index);
    if (/\.\s*$/.test(before)) continue;
    return true;
  }
  return false;
}

/**
 * Whether `line` declares `name` as a parameter of a NEW function, shadowing the
 * outer `_name` the scan is tracking.
 *
 * The forward scan is brace-counted, and a concise-body arrow opens no brace —
 * so before mt#4719 it ran past its own expression into a SIBLING lambda. In the
 * originating case the two lambdas were the branches of one ternary, and the
 * second declares its own, correctly-named `provider`:
 *
 * ```ts
 * addCredential: opts.addResult
 *   ? async (_provider: string, _token: string) => opts.addResult as ...
 *   : async (provider: string, _token: string) => ({ provider, ... })
 * ```
 *
 * Reaching such a line means the identifier is shadowed from here on, so the
 * scan must stop rather than attribute the sibling's uses to the outer binding.
 */
export function declaresParameter(line: string, name: string): boolean {
  const code = stripNonCode(line);
  const arrow = code.match(/\(([^)]*)\)\s*=>/);
  if (!arrow || arrow[1] === undefined) return false;
  return new RegExp(`\\b${name}\\b`).test(arrow[1]);
}

function checkFile(filePath: string): VariableNamingIssue[] {
  const issues: VariableNamingIssue[] = [];
  const content = readFileSync(filePath, "utf8");
  const lines = content.toString().split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;
    if (line === undefined) continue;

    // Check for catch blocks with underscore parameters
    const catchMatch = line.match(/catch\s*\(\s*(_\w+)\s*\)/);
    if (catchMatch && catchMatch[1] !== undefined) {
      const underscoreVar = catchMatch[1];
      const varWithoutUnderscore = underscoreVar.slice(1);

      // Look for usage of the variable without underscore in the next 20 lines
      for (let j = i + 1; j < Math.min(i + 21, lines.length); j++) {
        const nextLine = lines[j];
        if (nextLine === undefined) break;

        // Skip if we hit another catch or function
        if (nextLine.includes("catch") || nextLine.includes("function")) break;
        if (nextLine.includes("}") && nextLine.trim() === "}") break;

        if (declaresParameter(nextLine, varWithoutUnderscore)) break;
        if (
          referencesIdentifier(nextLine, varWithoutUnderscore) &&
          !nextLine.includes(underscoreVar)
        ) {
          issues.push({
            file: filePath,
            line: lineNumber,
            type: "catch-block",
            description: `Catch parameter '${underscoreVar}' referenced as '${varWithoutUnderscore}' on line ${j + 1}`,
            code: line.trim(),
          });
          break;
        }
      }
    }

    // Check for function parameters with underscores
    const funcMatch = line.match(/function\s+\w+\s*\([^)]*(_\w+)[^)]*/);
    if (funcMatch && funcMatch[1] !== undefined) {
      const underscoreParam = funcMatch[1];
      const paramWithoutUnderscore = underscoreParam.slice(1);

      // Look for usage without underscore in function body
      let braceCount = 0;
      let inFunction = false;

      for (let j = i; j < lines.length; j++) {
        const nextLine = lines[j];
        if (nextLine === undefined) break;

        if (nextLine.includes("{")) {
          braceCount += (nextLine.match(/\{/g) || []).length;
          inFunction = true;
        }
        if (nextLine.includes("}")) {
          braceCount -= (nextLine.match(/\}/g) || []).length;
        }

        if (inFunction && braceCount === 0) break;

        if (inFunction && j > i) {
          if (declaresParameter(nextLine, paramWithoutUnderscore)) break;
          if (
            referencesIdentifier(nextLine, paramWithoutUnderscore) &&
            !nextLine.includes(underscoreParam)
          ) {
            issues.push({
              file: filePath,
              line: lineNumber,
              type: "function-param",
              description: `Function parameter '${underscoreParam}' referenced as '${paramWithoutUnderscore}' on line ${j + 1}`,
              code: line.trim(),
            });
            break;
          }
        }
      }
    }

    // Check for arrow function parameters with underscores
    // This regex specifically looks for arrow functions at the start of expressions or after =, :, etc.
    const arrowMatch = line.match(/(?:^|[=:,\s])\s*\(\s*([^)]*_\w+[^)]*)\s*\)\s*=>/);
    if (arrowMatch && arrowMatch[1] !== undefined) {
      const params = arrowMatch[1];
      // Skip if the parameters contain string literals (like "child_process")
      const singleQuote = String.fromCharCode(39); // single quote
      const doubleQuote = String.fromCharCode(34); // double quote
      if (params.includes(doubleQuote) || params.includes(singleQuote)) {
        continue;
      }
      const underscoreParams = params.match(/_\w+/g) || [];

      for (const underscoreParam of underscoreParams) {
        const paramWithoutUnderscore = underscoreParam.slice(1);

        // Look for usage in the arrow function body
        let braceCount = 0;
        let inFunction = false;

        for (let j = i; j < lines.length; j++) {
          const nextLine = lines[j];
          if (nextLine === undefined) break;

          if (nextLine.includes("{")) {
            braceCount += (nextLine.match(/\{/g) || []).length;
            inFunction = true;
          }
          if (nextLine.includes("}")) {
            braceCount -= (nextLine.match(/\}/g) || []).length;
          }

          if (inFunction && braceCount === 0) break;

          if (j > i) {
            if (declaresParameter(nextLine, paramWithoutUnderscore)) break;
            if (
              referencesIdentifier(nextLine, paramWithoutUnderscore) &&
              !nextLine.includes(underscoreParam)
            ) {
              issues.push({
                file: filePath,
                line: lineNumber,
                type: "function-param",
                description: `Arrow function parameter '${underscoreParam}' referenced as '${paramWithoutUnderscore}' on line ${j + 1}`,
                code: line.trim(),
              });
              break;
            }
          }
        }
      }
    }
  }

  return issues;
}

function main() {
  const srcDir = "src";
  const files = getAllTsFiles(srcDir);

  console.log(`Checking ${files.length} TypeScript files for variable naming issues...\n`);

  let totalIssues = 0;
  const issuesByFile: Record<string, VariableNamingIssue[]> = {};

  for (const file of files) {
    const issues = checkFile(file);
    if (issues.length > 0) {
      issuesByFile[file] = issues;
      totalIssues += issues.length;
    }
  }

  if (totalIssues === 0) {
    console.log("✅ No variable naming issues found!");
    return;
  }

  console.log(`❌ Found ${totalIssues} potential variable naming issues:\n`);

  for (const [file, issues] of Object.entries(issuesByFile)) {
    console.log(`📁 ${file}`);
    for (const issue of issues) {
      console.log(`  Line ${issue.line}: ${issue.description}`);
      console.log(`    ${issue.code}`);
    }
    console.log();
  }

  console.log(`\nTotal issues: ${totalIssues}`);
  console.log("\nRecommendations:");
  console.log("1. Fix catch blocks: change catch(_error) to catch(error)");
  console.log("2. Fix function parameters: change _param to param if used in body");
  console.log("3. Keep underscores only for truly unused parameters");

  return;
}

if (import.meta.main) {
  main();
}
