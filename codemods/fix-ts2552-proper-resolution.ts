#!/usr/bin/env bun

import { Project } from "ts-morph";
import { writeFile } from "fs/promises";

interface NameResolutionFix {
  file: string;
  line: number;
  column: number;
  change: string;
  fixed: boolean;
  error?: string;
}

async function fixNameResolutionProper(): Promise<void> {
  const project = new Project({
    tsConfigFilePath: "./tsconfig.json",
  });

  const fixes: NameResolutionFix[] = [];
  let totalChanges = 0;

  console.log("🔧 Starting proper TS2552 name resolution fixes...");

  // Fix 1: SessionDB → SessionProviderInterface (import issue)
  try {
    const workspaceFile = project.getSourceFileOrThrow("src/domain/workspace.ts");
    const fileText = workspaceFile.getFullText();
    
    // Replace SessionDB with SessionProviderInterface in type annotations
    const newText = fileText.replace(
      /sessionDbOverride\?: \{ getSession: SessionDB\["getSession"\] \}/g,
      'sessionDbOverride?: { getSession: SessionProviderInterface["getSession"] }'
    );
    
    if (newText !== fileText) {
      workspaceFile.replaceWithText(newText);
      await workspaceFile.save();
      fixes.push({
        file: "src/domain/workspace.ts",
        line: 272,
        column: 48,
        change: "SessionDB → SessionProviderInterface",
        fixed: true,
      });
      totalChanges++;
      console.log("  ✅ Fixed SessionDB → SessionProviderInterface");
    }
  } catch (error) {
    console.error("❌ Error fixing SessionDB:", error);
  }

  // Fix 2: Remove underscores from variable usage (not parameters)
  try {
    const testUtilsFile = project.getSourceFileOrThrow("src/utils/test-utils.ts");
    const fileText = testUtilsFile.getFullText();
    
    // Replace _console with console and _process with process
    const newText = fileText
      .replace(/\b_console\b/g, 'console')
      .replace(/\b_process\b/g, 'process');
    
    if (newText !== fileText) {
      testUtilsFile.replaceWithText(newText);
      await testUtilsFile.save();
      fixes.push({
        file: "src/utils/test-utils.ts",
        line: 40,
        column: 31,
        change: "_console → console, _process → process",
        fixed: true,
      });
      totalChanges++;
      console.log("  ✅ Fixed _console → console, _process → process");
    }
  } catch (error) {
    console.error("❌ Error fixing test-utils:", error);
  }

  // Fix 3: Remove underscores from parameter definitions (not usage)
  try {
    const testGitServiceFile = project.getSourceFileOrThrow("src/utils/test-utils/test-git-service.ts");
    
    // Find the method with parameter issues
    const classes = testGitServiceFile.getClasses();
    for (const classDeclaration of classes) {
      const methods = classDeclaration.getMethods();
      for (const method of methods) {
        if (method.getName() === "execInRepository") {
          const params = method.getParameters();
          
          // Change __workdir parameter to workdir
          const workdirParam = params.find(p => p.getName() === "__workdir");
          if (workdirParam) {
            workdirParam.rename("workdir");
            fixes.push({
              file: "src/utils/test-utils/test-git-service.ts",
              line: 51,
              column: 51,
              change: "parameter __workdir → workdir",
              fixed: true,
            });
            totalChanges++;
            console.log("  ✅ Fixed parameter __workdir → workdir");
          }
        }
        
        if (method.getName() === "execAsync") {
          const params = method.getParameters();
          
          // Change __command parameter to command  
          const commandParam = params.find(p => p.getName() === "__command");
          if (commandParam) {
            commandParam.rename("command");
            fixes.push({
              file: "src/utils/test-utils/test-git-service.ts", 
              line: 38,
              column: 11,
              change: "parameter __command → command",
              fixed: true,
            });
            totalChanges++;
            console.log("  ✅ Fixed parameter __command → command");
          }
        }
      }
    }
    
    await testGitServiceFile.save();
  } catch (error) {
    console.error("❌ Error fixing test-git-service:", error);
  }

  // Generate report
  const reportPath = "./ts2552-proper-fixes-report.json";
  const report = {
    timestamp: new Date().toISOString(),
    totalChanges,
    fixes: fixes.sort((a, b) => a.file.localeCompare(b.file)),
    summary: {
      successful: fixes.filter(f => f.fixed).length,
      failed: fixes.filter(f => !f.fixed).length,
      principleApplied: "Remove underscores from parameter definitions, not usage",
    },
  };

  await writeFile(reportPath, JSON.stringify(report, null, 2));

  console.log(`\n📊 Proper TS2552 Name Resolution Fix Summary:`);
  console.log(`   Total changes: ${totalChanges}`);
  console.log(`   Successful fixes: ${report.summary.successful}`);
  console.log(`   Failed fixes: ${report.summary.failed}`);
  console.log(`   Principle: ${report.summary.principleApplied}`);
  console.log(`   Report saved to: ${reportPath}`);
}

// Run the fix
fixNameResolutionProper().catch(console.error); 
