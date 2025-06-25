#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "fs";

function fixGitTestCommands(content: string): { content: string; changeCount: number } {
  let newContent = content;
  let totalChanges = 0;

  // Fix all the execAsync createMock patterns
  const patterns = [
    // execAsync with _command parameter
    {
      pattern: /execAsync: createMock\(async \(_command: unknown\) => \{/g,
      replacement: "execAsync: createMock(async (command: unknown) => {",
    },
    // Different mock patterns that might exist
    {
      pattern: /createMock\(async \(_command: unknown\) => \{([^}]*?command[^}]*?)\}/gs,
      replacement: "createMock(async (command: unknown) => {$1}",
    },
    // Mock implementation patterns
    {
      pattern: /\.mockImplementation\(async \(_workdir, _command\) => \{([^}]*?command[^}]*?)\}/gs,
      replacement: ".mockImplementation(async (_workdir, command) => {$1}",
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
  const file = "src/domain/git.test.ts";

  try {
    const content = readFileSync(file, "utf8").toString();
    const { content: newContent, changeCount } = fixGitTestCommands(content);

    if (changeCount > 0) {
      writeFileSync(file, newContent, "utf8");
      console.log(`✅ Fixed ${changeCount} _command parameters in ${file}`);
    } else {
      console.log(`No _command parameter issues found in ${file}`);
    }

    console.log(`\n📊 Summary: ${changeCount} fixes applied`);
  } catch (error) {
    console.error(`❌ Error processing ${file}:`, error);
  }
}

if (import.meta.main) {
  await main();
}
