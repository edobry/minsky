#!/usr/bin/env bun
/**
 * Build-time validation script to catch missing imports and undefined references
 * This prevents issues like the ValidationError hang from reaching production
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join, extname } from "path";

interface ValidationIssue {
  file: string;
  line: number;
  issue: string;
  severity: "error" | "warning";
}

const issues: ValidationIssue[] = [];

// Common patterns that indicate missing imports
const UNDEFINED_PATTERNS = [
  // Class instantiation without import
  /new\s+([A-Z][a-zA-Z0-9]+)\s*\(/g,
  // Function calls that might be missing imports
  /throw\s+new\s+([A-Z][a-zA-Z0-9]+)\s*\(/g,
  // Static method calls
  /([A-Z][a-zA-Z0-9]+)\.([a-zA-Z0-9]+)\s*\(/g,
];

const KNOWN_GLOBALS = new Set([
  "Error",
  "TypeError",
  "ReferenceError",
  "SyntaxError",
  "RegExp",
  "Array",
  "Object",
  "String",
  "Number",
  "Boolean",
  "Date",
  "Math",
  "JSON",
  "Promise",
  "Set",
  "Map",
  "WeakSet",
  "WeakMap",
  "Buffer",
  "console",
  "process",
  "setTimeout",
  "setInterval",
  "clearTimeout",
  "clearInterval",
  "fetch",
  "URL",
  "URLSearchParams",
  // Add more as needed
]);

function scanFile(filePath: string): void {
  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n");

    // Get all imports to check against
    const imports = new Set<string>();
    const importRegex =
      /import\s+(?:.*?from\s+)?['"`]([^'"`]+)['"`]|import\s+(?:\{([^}]+)\}|\*\s+as\s+(\w+)|(\w+))/g;
    let importMatch;
    while ((importMatch = importRegex.exec(content)) !== null) {
      if (importMatch[2]) {
        // Named imports: { ValidationError, OtherError }
        const namedImports = importMatch[2].split(",").map((i) => i.trim().split(" as ")[0]);
        namedImports.forEach((imp) => imports.add(imp));
      }
      if (importMatch[3]) {
        // Namespace import: * as something
        imports.add(importMatch[3]);
      }
      if (importMatch[4]) {
        // Default import
        imports.add(importMatch[4]);
      }
    }

    // Check for undefined references
    lines.forEach((line, index) => {
      UNDEFINED_PATTERNS.forEach((pattern) => {
        let match;
        while ((match = pattern.exec(line)) !== null) {
          const identifier = match[1];
          if (identifier && !imports.has(identifier) && !KNOWN_GLOBALS.has(identifier)) {
            issues.push({
              file: filePath,
              line: index + 1,
              issue: `Potential missing import: '${identifier}' is used but not imported`,
              severity: "error",
            });
          }
        }
        pattern.lastIndex = 0; // Reset regex
      });

      // Check for explicit undefined usage
      if (
        line.includes("undefined") &&
        !line.includes("=== undefined") &&
        !line.includes("!== undefined")
      ) {
        if (line.includes("new undefined") || line.includes("throw undefined")) {
          issues.push({
            file: filePath,
            line: index + 1,
            issue: "Suspicious undefined usage - possible missing import",
            severity: "warning",
          });
        }
      }
    });
  } catch (error) {
    console.warn(`Could not scan ${filePath}: ${error}`);
  }
}

function scanDirectory(dir: string): void {
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        // Skip node_modules and other excluded dirs
        if (!["node_modules", ".git", "dist", "build", "codemods"].includes(entry)) {
          scanDirectory(fullPath);
        }
      } else if (stat.isFile() && [".ts", ".js"].includes(extname(entry))) {
        scanFile(fullPath);
      }
    }
  } catch (error) {
    console.warn(`Could not scan directory ${dir}: ${error}`);
  }
}

function main(): void {
  console.log("🔍 Validating imports and checking for undefined references...");

  // Scan source directories
  ["src", "tests"].forEach((dir) => {
    if (statSync(dir).isDirectory()) {
      scanDirectory(dir);
    }
  });

  // Report issues
  if (issues.length === 0) {
    console.log("✅ No import validation issues found!");
    process.exit(0);
  }

  console.log(`\n❌ Found ${issues.length} potential import issue(s):\n`);

  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");

  errors.forEach((issue) => {
    console.log(`🚨 ERROR: ${issue.file}:${issue.line} - ${issue.issue}`);
  });

  warnings.forEach((issue) => {
    console.log(`⚠️  WARNING: ${issue.file}:${issue.line} - ${issue.issue}`);
  });

  console.log(`\n💡 These issues could lead to "silent failures" like the ValidationError hang.`);
  console.log(`   Review each file and ensure all used identifiers are properly imported.\n`);

  if (errors.length > 0) {
    console.log("❌ Build failed due to import validation errors.");
    process.exit(1);
  } else {
    console.log("⚠️  Build completed with warnings.");
    process.exit(0);
  }
}

if (import.meta.main) {
  main();
}
