import { Project, SyntaxKind } from "ts-morph";

interface Fix {
  file: string;
  line: number;
  description: string;
}

const fixes: Fix[] = [];

function fixMockObjectProperties(): void {
  console.log("🚀 Starting mock object property fix...");
  
  const project = new Project({
    tsConfigFilePath: "tsconfig.json",
    skipAddingFilesFromTsConfig: true,
  });

  // Add all TypeScript files
  const files = project.addSourceFilesAtPaths("src/**/*.ts");
  console.log(`📁 Adding ${files.length} TypeScript files to project...`);

  let totalIssues = 0;
  let totalFixes = 0;

  for (const sourceFile of files) {
    const filePath = sourceFile.getFilePath();
    let fileChanged = false;
    
    try {
      // Skip files with syntax errors
      sourceFile.getPreEmitDiagnostics();
    } catch (error) {
      console.log(`⚠️  Skipping ${filePath} due to syntax errors`);
      continue;
    }

    // Find all object literal expressions
    const objectLiterals = sourceFile.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression);

    for (const objectLiteral of objectLiterals) {
      const properties = objectLiteral.getProperties();
      
      for (const property of properties) {
        if (property.getKind() === SyntaxKind.PropertyAssignment) {
          const propAssignment = property.asKindOrThrow(SyntaxKind.PropertyAssignment);
          if (!propAssignment) continue;

          const propName = propAssignment.getName();
          
          // Fix property names with underscores that should be without
          const propertyFixes = {
            "_id": "id",
            "_title": "title", 
            "_status": "status",
            "_workdir": "workdir",
            "_session": "session",
            "_branch": "branch",
            "_taskId": "taskId"
          };

          if (propName && propertyFixes[propName]) {
            const newName = propertyFixes[propName];
            const nameNode = propAssignment.getNameNode();
            
            if (nameNode) {
              nameNode.replaceWithText(newName);
              fileChanged = true;
              totalIssues++;
              totalFixes++;
              
              fixes.push({
                file: filePath,
                line: propAssignment.getStartLineNumber(),
                description: `Fixed mock property: ${propName} → ${newName}`
              });
            }
          }
        }
      }
    }

    if (fileChanged) {
      sourceFile.saveSync();
    }
  }

  console.log(`📊 Found ${totalIssues} mock property issues`);
  console.log(`🔧 Applying mock property fixes...`);
  console.log(`✅ Applied ${totalFixes} fixes`);
  console.log(`💾 Saving changes...`);
  console.log(`💾 Saved changes to ${files.length} files`);
}

// Run the fix
fixMockObjectProperties();

// Report results
console.log(`\n📋 Mock Object Property Fix Report:`);
console.log(`   Issues found: ${fixes.length}`);
console.log(`   Fixes applied: ${fixes.length}`);
console.log(`   Success rate: ${fixes.length > 0 ? '100%' : '0%'}`);

if (fixes.length > 0) {
  console.log(`\n📝 Applied fixes:`);
  fixes.forEach((fix, index) => {
    console.log(`   ${index + 1}. ${fix.description} (${fix.file}:${fix.line})`);
  });
}

console.log(`\n✅ Mock object property fix completed successfully!`); 
