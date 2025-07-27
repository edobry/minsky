#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "fs";

function fixMockingPaths(content: string): { content: string; changeCount: number } {
  let newContent = content;
  let totalChanges = 0;

  // Fix _path parameters in mock functions
  const patterns = [
    // readFileSync with _path parameter
    {
      pattern: /readFileSync: createMock\(\(_path: unknown\) => \{([^}]*?)path([^}]*?)\}/gs,
      replacement: "readFileSync: createMock((path: unknown) => {$1path$2}",
    },
    // writeFileSync with _path parameter
    {
      pattern: /writeFileSync: createMock\(\(_path: unknown\) => \{([^}]*?)path([^}]*?)\}/gs,
      replacement: "writeFileSync: createMock((path: unknown) => {$1path$2}",
    },
    // unlink with _path parameter
    {
      pattern: /unlink: createMock\(\(_path: unknown\) => \{([^}]*?)path([^}]*?)\}/gs,
      replacement: "unlink: createMock((path: unknown) => {$1path$2}",
    },
    // mkdirSync with _path parameter
    {
      pattern: /mkdirSync: createMock\(\(_path: unknown\) => \{([^}]*?)path([^}]*?)\}/gs,
      replacement: "mkdirSync: createMock((path: unknown) => {$1path$2}",
    },
    // rmSync with _path parameter
    {
      pattern: /rmSync: createMock\(\(_path: unknown\) => \{([^}]*?)path([^}]*?)\}/gs,
      replacement: "rmSync: createMock((path: unknown) => {$1path$2}",
    },
    // readFile async with _path parameter
    {
      pattern: /readFile: createMock\(async \(_path: unknown\) => \{([^}]*?)path([^}]*?)\}/gs,
      replacement: "readFile: createMock(async (path: unknown) => {$1path$2}",
    },
    // writeFile async with _path parameter
    {
      pattern: /writeFile: createMock\(async \(_path: unknown\) => \{([^}]*?)path([^}]*?)\}/gs,
      replacement: "writeFile: createMock(async (path: unknown) => {$1path$2}",
    },
    // mkdir async with _path parameter
    {
      pattern: /mkdir: createMock\(async \(_path: unknown\) => \{([^}]*?)path([^}]*?)\}/gs,
      replacement: "mkdir: createMock(async (path: unknown) => {$1path$2}",
    },
  ];

  patterns.forEach(({ pattern, replacement }) => {
    const before = newContent;
    newContent = newContent.replace(pattern, replacement);
    const beforeCount = (before.match(pattern) || []).length;
    const afterCount = (newContent.match(pattern) || []).length;
    const changes = beforeCount - afterCount;
    totalChanges += changes;
  });

  return {
    content: newContent,
    changeCount: totalChanges,
  };
}

async function main() {
  const file = "src/utils/test-utils/mocking.ts";

  try {
    const content = readFileSync(file, "utf8").toString();
    const { content: newContent, changeCount } = fixMockingPaths(content);

    if (changeCount > 0) {
      writeFileSync(file, newContent, "utf8");
      console.log(`✅ Fixed ${changeCount} _path parameters in ${file}`);
    } else {
      console.log(`No _path parameter issues found in ${file}`);
    }

    console.log(`\n📊 Summary: ${changeCount} fixes applied`);
  } catch (error) {
    console.error(`❌ Error processing ${file}:`, error);
  }
}

if (import.meta.main) {
  await main();
}
