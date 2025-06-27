#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "fs";

const filesToProcess = [
  "src/domain/__tests__/git-pr-workflow.test.ts",
  "src/domain/__tests__/session-approve.test.ts", 
  "src/domain/__tests__/prepared-merge-commit-workflow.test.ts"
];

function fixCommandParams(content: string): { content: string; changeCount: number } {
  let newContent = content;
  let totalChanges = 0;
  
  // Fix various _command parameter patterns
  const patterns = [
    // execInRepository with _command parameter
    {
      pattern: /execInRepository: createMock\(\(_workdir, _command\) => \{([^}]*?)command([^}]*?)\}/gs,
      replacement: "execInRepository: createMock((_workdir, command) => {$1command$2}"
    },
    // mockExecAsync with _command parameter
    {
      pattern: /mockExecAsync = createMock\(async \(_command: unknown\) => \{([^}]*?)command([^}]*?)\}/gs,
      replacement: "mockExecAsync = createMock(async (command: unknown) => {$1command$2}"
    },
    // conflictMockExecAsync pattern
    {
      pattern: /const conflictMockExecAsync = createMock\(async \(_command: unknown\) => \{([^}]*?)command([^}]*?)\}/gs,
      replacement: "const conflictMockExecAsync = createMock(async (command: unknown) => {$1command$2}"
    }
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
    changeCount: totalChanges
  };
}

async function main() {
  let totalFiles = 0;
  let totalChanges = 0;
  
  for (const file of filesToProcess) {
    try {
      const content = readFileSync(file, "utf8").toString();
      const { content: newContent, changeCount } = fixCommandParams(content);
      
      if (changeCount > 0) {
        writeFileSync(file, newContent, "utf8");
        console.log(`✅ Fixed ${changeCount} _command parameters in ${file}`);
        totalFiles++;
        totalChanges += changeCount;
      }
    } catch (error) {
      console.error(`❌ Error processing ${file}:`, error);
    }
  }
  
  console.log("\n📊 Summary:");
  console.log(`   Files modified: ${totalFiles}`);
  console.log(`   Total fixes: ${totalChanges}`);
}

if (import.meta.main) {
  await main();
}
