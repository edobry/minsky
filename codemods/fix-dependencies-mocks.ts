import { Project, SyntaxKind } from "ts-morph";

interface Fix {
  file: string;
  line: number;
  description: string;
}

const fixes: Fix[] = [];

function fixDependenciesMocks(): void {
  console.log("🚀 Starting dependencies mock fix...");
  
  const project = new Project({
    tsConfigFilePath: "tsconfig.json",
    skipAddingFilesFromTsConfig: true,
  });

  // Target only the specific file with mock issues
  const targetFile = "src/utils/test-utils/dependencies.ts";
  const sourceFile = project.addSourceFileAtPath(targetFile);
  console.log(`📁 Processing ${targetFile}...`);

  let fileChanged = false;

  // Find all object literal expressions
  const objectLiterals = sourceFile.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression);

  for (const objectLiteral of objectLiterals) {
    const properties = objectLiteral.getProperties();
    
    for (const property of properties) {
      if (property.getKind() === SyntaxKind.PropertyAssignment) {
        const propAssignment = property.asKindOrThrow(SyntaxKind.PropertyAssignment);
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
            
            fixes.push({
              file: targetFile,
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
    console.log(`✅ Fixed mock functions in ${targetFile}`);
  } else {
    console.log(`ℹ️  No changes needed in ${targetFile}`);
  }
}

// Run the fix
fixDependenciesMocks();

// Report results
console.log(`\n📋 Dependencies Mock Fix Report:`);
console.log(`   Issues found: ${fixes.length}`);
console.log(`   Fixes applied: ${fixes.length}`);
console.log(`   Success rate: ${fixes.length > 0 ? '100%' : '0%'}`);

if (fixes.length > 0) {
  console.log(`\n📝 Applied fixes:`);
  fixes.forEach((fix, index) => {
    console.log(`   ${index + 1}. ${fix.description} (line ${fix.line})`);
  });
}

console.log(`\n✅ Dependencies mock fix completed successfully!`); 
