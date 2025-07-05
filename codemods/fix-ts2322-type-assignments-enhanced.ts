#!/usr/bin/env bun

import { Project, SourceFile } from "ts-morph";
import { writeFile } from "fs/promises";

interface TypeAssignmentFix {
  file: string;
  line: number;
  change: string;
  fixed: boolean;
  error?: string;
}

async function fixTypeAssignments(): Promise<void> {
  const project = new Project({
    tsConfigFilePath: "./tsconfig.json",
  });

  const fixes: TypeAssignmentFix[] = [];
  let totalChanges = 0;

  console.log("🔧 Starting enhanced TS2322 type assignment fixes...");

  // Process specific files with known issues
  const targetFiles = [
    "src/domain/tasks.ts",
    "src/domain/tasks/taskIO.ts", 
    "src/domain/workspace.ts",
    "src/utils/git-exec-enhanced.ts",
    "src/domain/tasks/githubIssuesTaskBackend.ts",
    "src/domain/tasks/taskFunctions.ts",
  ];

  for (const filePath of targetFiles) {
    try {
      const sourceFile = project.getSourceFile(filePath);
      if (!sourceFile) {
        console.log(`  ⚠️  File not found: ${filePath}`);
        continue;
      }

      console.log(`Processing ${filePath}...`);
      let fileText = sourceFile.getFullText();
      let hasChanges = false;

      // Fix 1: null → string | undefined conversions
      if (fileText.includes("null") && filePath.includes("tasks.ts")) {
        const nullFix = fileText.replace(
          /return\s+null\s*;/g,
          'return undefined;'
        );
        if (nullFix !== fileText) {
          fileText = nullFix;
          hasChanges = true;
          totalChanges++;
          console.log(`    ✅ Fixed null → undefined returns`);
        }
      }

             // Fix 2: Buffer → string conversions for taskIO.ts
       if (filePath.includes("taskIO.ts")) {
         const bufferFix = fileText.replace(
           /(\w+)\s*=\s*await\s+readFile\(([^)]+)\)/g,
           '$1 = (await readFile($2)).toString()'
         );
        if (bufferFix !== fileText) {
          fileText = bufferFix;
          hasChanges = true;
          totalChanges++;
          console.log(`    ✅ Fixed Buffer → string conversions`);
        }
      }

             // Fix 3: unknown[] → string[] type assertions
       if (filePath.includes("git-exec-enhanced.ts")) {
         const unknownArrayFix = fileText.replace(
           /(\w+)\s*=\s*([^;]+)\s*as\s+unknown\[\]/g,
           '$1 = $2 as string[]'
         );
        if (unknownArrayFix !== fileText) {
          fileText = unknownArrayFix;
          hasChanges = true;
          totalChanges++;
          console.log(`    ✅ Fixed unknown[] → string[] type assertion`);
        }
      }

      // Fix 4: String to TaskStatus enum fixes
      if (filePath.includes("githubIssuesTaskBackend.ts")) {
        const statusFix = fileText.replace(
          /status:\s*"(OPEN|CLOSED|IN_PROGRESS|COMPLETED)"/g,
          'status: TaskStatus.$1'
        );
        if (statusFix !== fileText) {
          fileText = statusFix;
          hasChanges = true;
          totalChanges++;
          console.log(`    ✅ Fixed string → TaskStatus enum`);
        }
      }

      // Fix 5: Wrong return type in taskFunctions.ts
      if (filePath.includes("taskFunctions.ts")) {
        const returnTypeFix = fileText.replace(
          /return\s*\{\s*tasks:\s*([^,]+),\s*lastUpdated:\s*([^}]+)\s*\}/g,
          '// Fixed return type - should return TaskData[] not TaskStatus\nreturn $1'
        );
        if (returnTypeFix !== fileText) {
          fileText = returnTypeFix;
          hasChanges = true;
          totalChanges++;
          console.log(`    ✅ Fixed wrong return type`);
        }
      }

      // Apply changes if any were made
      if (hasChanges) {
        sourceFile.replaceWithText(fileText);
        await sourceFile.save();
        
        fixes.push({
          file: filePath,
          line: 0,
          change: "Enhanced TS2322 type fixes",
          fixed: true,
        });
      }

    } catch (error) {
      console.error(`❌ Error processing ${filePath}:`, error);
      fixes.push({
        file: filePath,
        line: 0,
        change: "failed",
        fixed: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Additional targeted fixes for specific patterns
  console.log("\n🔧 Applying targeted null/undefined fixes...");
  
  try {
    // Fix workspace.ts line 264
    const workspaceFile = project.getSourceFile("src/domain/workspace.ts");
    if (workspaceFile) {
      let workspaceText = workspaceFile.getFullText();
      
      // Fix the specific line 264 null assignment
      const nullAssignmentFix = workspaceText.replace(
        /sessionInfo\s*=\s*null/g,
        'sessionInfo = undefined'
      );
      
      if (nullAssignmentFix !== workspaceText) {
        workspaceFile.replaceWithText(nullAssignmentFix);
        await workspaceFile.save();
        totalChanges++;
        console.log("    ✅ Fixed null assignment in workspace.ts");
      }
    }

    // Fix taskIO.ts Buffer issues specifically
    const taskIOFile = project.getSourceFile("src/domain/tasks/taskIO.ts");
    if (taskIOFile) {
      let taskIOText = taskIOFile.getFullText();
      
      // Fix specific Buffer to string conversions
      const bufferToStringFix = taskIOText
        .replace(/(data|content)\s*=\s*await\s+readFile\(([^)]+)\)/g, '$1 = (await readFile($2)).toString()')
        .replace(/(data|content)\s*=\s*readFileSync\(([^)]+)\)/g, '$1 = readFileSync($2).toString()');
      
      if (bufferToStringFix !== taskIOText) {
        taskIOFile.replaceWithText(bufferToStringFix);
        await taskIOFile.save();
        totalChanges++;
        console.log("    ✅ Fixed Buffer → string in taskIO.ts");
      }
    }

  } catch (error) {
    console.error("❌ Error in targeted fixes:", error);
  }

  // Generate report
  const reportPath = "./ts2322-enhanced-fixes-report.json";
  const report = {
    timestamp: new Date().toISOString(),
    totalChanges,
    fixes: fixes.sort((a, b) => a.file.localeCompare(b.file)),
    summary: {
      successful: fixes.filter(f => f.fixed).length,
      failed: fixes.filter(f => !f.fixed).length,
      filesProcessed: targetFiles.length,
    },
  };

  await writeFile(reportPath, JSON.stringify(report, null, 2));

  console.log(`\n📊 Enhanced TS2322 Type Assignment Fix Summary:`);
  console.log(`   Total changes: ${totalChanges}`);
  console.log(`   Target files: ${targetFiles.length}`);
  console.log(`   Successful fixes: ${report.summary.successful}`);
  console.log(`   Failed fixes: ${report.summary.failed}`);
  console.log(`   Report saved to: ${reportPath}`);
}

// Run the fix
fixTypeAssignments().catch(console.error); 
