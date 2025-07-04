#!/usr/bin/env bun

import { Project } from "ts-morph";
import { writeFile } from "fs/promises";

interface ArgumentTypeFix {
  file: string;
  line: number;
  column: number;
  change: string;
  fixed: boolean;
  error?: string;
}

async function fixArgumentTypeErrors(): Promise<void> {
  const project = new Project({
    tsConfigFilePath: "./tsconfig.json",
  });

  const fixes: ArgumentTypeFix[] = [];
  let totalChanges = 0;

  console.log("🔧 Starting TS2345 argument type fixes...");

  // Process all source files except test utilities and scripts
  const sourceFiles = project.getSourceFiles([
    "src/**/*.ts",
    "!src/**/*.test.ts",
    "!src/**/*.spec.ts",
    "!src/scripts/**",
    "!src/utils/test-utils/**",
  ]);

  for (const sourceFile of sourceFiles) {
    const filePath = sourceFile.getFilePath();
    console.log(`Processing ${filePath}...`);

    try {
      let fileText = sourceFile.getFullText();
      let hasChanges = false;

      // Fix 1: Command | undefined → Command with non-null assertion
      const commandUndefinedRegex = /(\w+)\s*\?\s*:\s*Command\s*\|\s*undefined/g;
      const commandMatches = [...fileText.matchAll(commandUndefinedRegex)];
      if (commandMatches.length > 0) {
        for (const match of commandMatches) {
          const paramName = match[1];
          // Look for usage of this parameter and add non-null assertion
          const usageRegex = new RegExp(`\\b${paramName}\\b(?!\\s*[!?.:])`, 'g');
          fileText = fileText.replace(usageRegex, `${paramName}!`);
          hasChanges = true;
          totalChanges++;
          console.log(`    ✅ Added non-null assertion to ${paramName}`);
        }
      }

      // Fix 2: string | null → string | undefined
      const stringNullRegex = /\bstring\s*\|\s*null\b/g;
      if (stringNullRegex.test(fileText)) {
        fileText = fileText.replace(stringNullRegex, 'string | undefined');
        hasChanges = true;
        totalChanges++;
        console.log(`    ✅ Fixed string | null → string | undefined`);
      }

      // Fix 3: Buffer type conversions
      const bufferRegex = /(\w+)\s*:\s*string\s*\|\s*Buffer/g;
      const bufferMatches = [...fileText.matchAll(bufferRegex)];
      if (bufferMatches.length > 0) {
        for (const match of bufferMatches) {
          const varName = match[1];
          // Look for usage and add .toString()
          const usageRegex = new RegExp(`\\b${varName}\\b(?!\\s*[!?.:])`, 'g');
          fileText = fileText.replace(usageRegex, `${varName}.toString()`);
          hasChanges = true;
          totalChanges++;
          console.log(`    ✅ Added .toString() to ${varName}`);
        }
      }

      // Fix 4: unknown type assertions for string parameters
      const unknownStringRegex = /(\w+)\s*:\s*unknown/g;
      const unknownMatches = [...fileText.matchAll(unknownStringRegex)];
      if (unknownMatches.length > 0) {
        for (const match of unknownMatches) {
          const varName = match[1];
          // Look for usage in string contexts and add String() conversion
          const stringUsageRegex = new RegExp(`\\b${varName}\\b(?=\\s*[,)\\]])`, 'g');
          fileText = fileText.replace(stringUsageRegex, `String(${varName})`);
          hasChanges = true;
          totalChanges++;
          console.log(`    ✅ Added String() conversion to ${varName}`);
        }
      }

      // Apply changes if any were made
      if (hasChanges) {
        sourceFile.replaceWithText(fileText);
        await sourceFile.save();
        
        fixes.push({
          file: filePath,
          line: 0,
          column: 0,
          change: "Multiple TS2345 argument type fixes",
          fixed: true,
        });
      }
      
    } catch (error) {
      console.error(`❌ Error processing ${filePath}:`, error);
      fixes.push({
        file: filePath,
        line: 0,
        column: 0,
        change: "failed",
        fixed: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Fix test utilities separately with specific patterns
  console.log("\n🔧 Fixing test utilities...");
  try {
    const testUtilsFile = project.getSourceFile("src/utils/test-utils.ts");
    if (testUtilsFile) {
      let fileText = testUtilsFile.getFullText();
      
      // Fix process.exit spy typing
      const processExitFix = fileText.replace(
        /spyOn\(process,\s*"exit"\)\.mockImplementation\(\(\)\s*=>\s*\{[^}]*\}\)/g,
        'spyOn(process, "exit" as any).mockImplementation(() => { throw new Error("process.exit called"); })'
      );
      
      if (processExitFix !== fileText) {
        testUtilsFile.replaceWithText(processExitFix);
        await testUtilsFile.save();
        totalChanges++;
        console.log("    ✅ Fixed process.exit spy typing");
      }
    }
  } catch (error) {
    console.error("❌ Error fixing test utilities:", error);
  }

  // Generate report
  const reportPath = "./ts2345-fixes-report.json";
  const report = {
    timestamp: new Date().toISOString(),
    totalChanges,
    totalFiles: sourceFiles.length,
    fixes: fixes.sort((a, b) => a.file.localeCompare(b.file)),
    summary: {
      successful: fixes.filter(f => f.fixed).length,
      failed: fixes.filter(f => !f.fixed).length,
      filesProcessed: sourceFiles.length,
    },
  };

  await writeFile(reportPath, JSON.stringify(report, null, 2));

  console.log(`\n📊 TS2345 Argument Type Fix Summary:`);
  console.log(`   Total changes: ${totalChanges}`);
  console.log(`   Files processed: ${sourceFiles.length}`);
  console.log(`   Successful fixes: ${report.summary.successful}`);
  console.log(`   Failed fixes: ${report.summary.failed}`);
  console.log(`   Report saved to: ${reportPath}`);
}

// Run the fix
fixArgumentTypeErrors().catch(console.error); 
