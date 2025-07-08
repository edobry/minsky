#!/usr/bin/env bun

import { promises as fs } from "fs";
import path from "path";

interface ParsingFix {
  file: string;
  line: number;
  oldContent: RegExp | string;
  newContent: string;
  description: string;
}

const PARSING_FIXES: ParsingFix[] = [
  // Fix config-loader.ts missing imports
  {
    file: "src/domain/configuration/config-loader.ts",
    line: 0,
    oldContent: /import \{ homedir \} from "os";\nimport \{/,
    newContent: `import { homedir } from "os";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import { log } from "../../utils/logger";
import {`,
    description: "Fix missing imports and correct import path",
  },

  // Fix escaped quotes in repository-uri.ts
  {
    file: "src/domain/repository-uri.ts",
    line: 0,
    oldContent: `components.scheme = \\"https\\";`,
    newContent: `components.scheme = "https";`,
    description: "Fix escaped quotes for https scheme",
  },
  {
    file: "src/domain/repository-uri.ts",
    line: 0,
    oldContent: `components.scheme = \\"ssh\\";`,
    newContent: `components.scheme = "ssh";`,
    description: "Fix escaped quotes for ssh scheme",
  },
  {
    file: "src/domain/repository-uri.ts",
    line: 0,
    oldContent: `components.scheme = \\"file\\";`,
    newContent: `components.scheme = "file";`,
    description: "Fix escaped quotes for file scheme",
  },
  {
    file: "src/domain/repository-uri.ts",
    line: 0,
    oldContent: `.replace(/^file:\\/\\//, \\"\\"`,
    newContent: `.replace(/^file:\\/\\//, ""`,
    description: "Fix escaped quotes in replace function",
  },
  {
    file: "src/domain/repository-uri.ts",
    line: 0,
    oldContent: `ensureFullyQualified: false, // Don\\"t expand shorthand`,
    newContent: `ensureFullyQualified: false, // Don't expand shorthand`,
    description: "Fix escaped quotes in comment",
  },

  // Fix malformed function signature in json-file-storage.ts
  {
    file: "src/domain/storage/json-file-storage.ts",
    line: 0,
    oldContent: /static async withLock<T>\(_filePath: unknown\) => Promise<T>\): Promise<T>/,
    newContent: `static async withLock<T>(filePath: string, operation: () => Promise<T>): Promise<T>`,
    description: "Fix malformed function signature in withLock",
  },

  // Fix escaped quotes in workspace.ts
  {
    file: "src/domain/workspace.ts",
    line: 0,
    oldContent: /join\(_options\.workspace, \\"process\\"\)/g,
    newContent: `join(options.workspace, "process")`,
    description: "Fix escaped quotes and parameter name in workspace.ts",
  },

  // Fix malformed function signature in base-errors.ts
  {
    file: "src/errors/base-errors.ts",
    line: 0,
    oldContent: /captureStackTrace\(_error: unknown\) => any\): void;/,
    newContent: `captureStackTrace(error: Error, constructor: (...args: any[]) => any): void;`,
    description: "Fix malformed captureStackTrace function signature",
  },

  // Fix unescaped quotes in session.ts
  {
    file: "src/schemas/session.ts",
    line: 0,
    oldContent: /message: "Either "body" or "bodyPath" must be provided",/,
    newContent: `message: "Either 'body' or 'bodyPath' must be provided",`,
    description: "Fix unescaped quotes in session.ts error message",
  },

  // Fix unescaped quotes in tasks.ts
  {
    file: "src/schemas/tasks.ts",
    line: 0,
    oldContent:
      /\.describe\("Specific section of the specification to retrieve \(e\.g\., "requirements"\)"\),/,
    newContent: `.describe("Specific section of the specification to retrieve (e.g., 'requirements')"),`,
    description: "Fix unescaped quotes in tasks.ts description",
  },
];

async function applyParsingFix(fix: ParsingFix): Promise<boolean> {
  try {
    const filePath = path.join(process.cwd(), fix.file);
    const content = await fs.readFile(filePath, "utf8");

    let newContent: string;
    if (fix.oldContent instanceof RegExp) {
      if (!fix.oldContent.test(content)) {
        console.log(`⚠️  Pattern not found in ${fix.file}: ${fix.description}`);
        return false;
      }
      newContent = content.replace(fix.oldContent, fix.newContent);
    } else {
      if (!content.includes(fix.oldContent)) {
        console.log(`⚠️  String not found in ${fix.file}: ${fix.description}`);
        return false;
      }
      newContent = content.replaceAll(fix.oldContent, fix.newContent);
    }

    if (newContent === content) {
      console.log(`⚠️  No changes made to ${fix.file}: ${fix.description}`);
      return false;
    }

    await fs.writeFile(filePath, newContent, "utf8");
    console.log(`✅ Fixed ${fix.file}: ${fix.description}`);
    return true;
  } catch (error) {
    console.error(`❌ Error fixing ${fix.file}: ${error}`);
    return false;
  }
}

async function main() {
  console.log("🔧 Fixing all parsing errors...\n");

  let totalFixed = 0;

  for (const fix of PARSING_FIXES) {
    const success = await applyParsingFix(fix);
    if (success) {
      totalFixed++;
    }
  }

  console.log(
    `\n📊 Summary: Fixed ${totalFixed} parsing errors out of ${PARSING_FIXES.length} attempted`
  );
}

if (import.meta.main) {
  main().catch(console.error);
}
