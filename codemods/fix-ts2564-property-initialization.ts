#!/usr/bin/env bun

import { Project } from "ts-morph";
import { writeFile } from "fs/promises";

interface PropertyInitializationFix {
  file: string;
  line: number;
  column: number;
  property: string;
  fixed: boolean;
  error?: string;
}

// TS2564 error patterns we need to fix
const TS2564_PROPERTIES = [
  { className: "GitHubBackend", properties: ["repoUrl", "repoName"] },
  { className: "LocalGitBackend", properties: ["repoUrl", "repoName"] }, 
  { className: "RemoteGitBackend", properties: ["repoUrl", "repoName"] },
  { className: "SpecialWorkspaceManager", properties: ["repoUrl"] },
  { className: "StorageError", properties: ["type"] },
];

async function fixPropertyInitialization(): Promise<void> {
  const project = new Project({
    tsConfigFilePath: "./tsconfig.json",
  });

  const fixes: PropertyInitializationFix[] = [];
  let totalChanges = 0;

  console.log("🔧 Starting TS2564 property initialization fixes...");

  // Process each file that contains the problematic classes
  const sourceFiles = project.getSourceFiles([
    "src/domain/repository/github.ts",
    "src/domain/repository/local.ts", 
    "src/domain/repository/remote.ts",
    "src/domain/workspace/special-workspace-manager.ts",
    "src/domain/storage/backends/error-handling.ts",
  ]);

  for (const sourceFile of sourceFiles) {
    const filePath = sourceFile.getFilePath();
    console.log(`Processing ${filePath}...`);

    try {
      // Find classes that need property initialization fixes
      const classes = sourceFile.getClasses();
      
      for (const classDeclaration of classes) {
        const className = classDeclaration.getName();
        if (!className) continue;

        // Find the configuration for this class
        const config = TS2564_PROPERTIES.find(c => c.className === className);
        if (!config) continue;

        console.log(`  Found class: ${className}`);

        // Fix each property that needs definite assignment assertion
        for (const propertyName of config.properties) {
          const property = classDeclaration.getProperty(propertyName);
          if (!property) continue;

          const propertyStructure = property.getStructure();
          
          // Check if property already has definite assignment assertion
          if (propertyStructure.hasExclamationToken) {
            console.log(`    Property ${propertyName} already has definite assignment assertion`);
            continue;
          }

          // Add definite assignment assertion
          property.setHasExclamationToken(true);
          
          const startPos = property.getStart();
          const lineNumber = sourceFile.getLineAndColumnAtPos(startPos).line;
          
          fixes.push({
            file: filePath,
            line: lineNumber,
            column: 0,
            property: `${className}.${propertyName}`,
            fixed: true,
          });

          totalChanges++;
          console.log(`    ✅ Added definite assignment assertion to ${propertyName}`);
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
        property: "unknown",
        fixed: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Generate report
  const reportPath = "./ts2564-fixes-report.json";
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

  console.log(`\n📊 TS2564 Property Initialization Fix Summary:`);
  console.log(`   Total changes: ${totalChanges}`);
  console.log(`   Files processed: ${sourceFiles.length}`);
  console.log(`   Successful fixes: ${report.summary.successful}`);
  console.log(`   Failed fixes: ${report.summary.failed}`);
  console.log(`   Report saved to: ${reportPath}`);
}

// Run the fix
fixPropertyInitialization().catch(console.error); 
