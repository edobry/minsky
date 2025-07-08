#!/usr/bin/env bun

import { Project } from "ts-morph";
import { writeFile } from "fs/promises";

interface NameResolutionFix {
  file: string;
  line: number;
  column: number;
  from: string;
  to: string;
  fixed: boolean;
  error?: string;
}

// TS2552 error patterns we need to fix
const TS2552_FIXES = [
  { 
    file: "src/domain/tasks/taskFunctions.ts",
    replacements: [
      { from: "TaskState", to: "TaskStatus" }
    ]
  },
  { 
    file: "src/domain/workspace.ts",
    replacements: [
      { from: "SessionDB", to: "sessionDb" },
      { from: "currentSessionName", to: "getCurrentSessionFn" }
    ]
  },
  { 
    file: "src/utils/test-utils.ts",
    replacements: [
      { from: "_console", to: "console" },
      { from: "_process", to: "process" }
    ]
  },
  { 
    file: "src/utils/test-utils/test-git-service.ts",
    replacements: [
      { from: "command", to: "__command" }
    ]
  }
];

async function fixNameResolutionErrors(): Promise<void> {
  const project = new Project({
    tsConfigFilePath: "./tsconfig.json",
  });

  const fixes: NameResolutionFix[] = [];
  let totalChanges = 0;

  console.log("🔧 Starting TS2552 name resolution fixes...");

  for (const fileConfig of TS2552_FIXES) {
    const filePath = fileConfig.file;
    console.log(`Processing ${filePath}...`);

    try {
      const sourceFile = project.getSourceFileOrThrow(filePath);
      const fileText = sourceFile.getFullText();

      for (const replacement of fileConfig.replacements) {
        const regex = new RegExp(`\\b${replacement.from}\\b`, 'g');
        const matches = [...fileText.matchAll(regex)];
        
        if (matches.length > 0) {
          console.log(`  Found ${matches.length} occurrences of '${replacement.from}'`);
          
          // Replace all occurrences
          const newText = fileText.replace(regex, replacement.to);
          sourceFile.replaceWithText(newText);
          
          // Record fixes
          for (const match of matches) {
            const position = sourceFile.getLineAndColumnAtPos(match.index || 0);
            fixes.push({
              file: filePath,
              line: position.line,
              column: position.column,
              from: replacement.from,
              to: replacement.to,
              fixed: true,
            });
            totalChanges++;
          }
          
          console.log(`    ✅ Replaced ${matches.length} occurrences of '${replacement.from}' → '${replacement.to}'`);
        }
      }

      // Save the changes
      await sourceFile.save();
      
    } catch (error) {
      console.error(`❌ Error processing ${filePath}:`, error);
      fixes.push({
        file: filePath,
        line: 0,
        column: 0,
        from: "unknown",
        to: "unknown",
        fixed: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Generate report
  const reportPath = "./ts2552-fixes-report.json";
  const report = {
    timestamp: new Date().toISOString(),
    totalChanges,
    totalFiles: TS2552_FIXES.length,
    fixes: fixes.sort((a, b) => a.file.localeCompare(b.file)),
    summary: {
      successful: fixes.filter(f => f.fixed).length,
      failed: fixes.filter(f => !f.fixed).length,
      filesProcessed: TS2552_FIXES.length,
    },
  };

  await writeFile(reportPath, JSON.stringify(report, null, 2));

  console.log(`\n📊 TS2552 Name Resolution Fix Summary:`);
  console.log(`   Total changes: ${totalChanges}`);
  console.log(`   Files processed: ${TS2552_FIXES.length}`);
  console.log(`   Successful fixes: ${report.summary.successful}`);
  console.log(`   Failed fixes: ${report.summary.failed}`);
  console.log(`   Report saved to: ${reportPath}`);
}

// Run the fix
fixNameResolutionErrors().catch(console.error); 
