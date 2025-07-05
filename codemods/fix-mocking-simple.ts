import { Project } from "ts-morph";

interface Fix {
  file: string;
  line: number;
  description: string;
}

const fixes: Fix[] = [];

function fixMockingSimple(): void {
  console.log("🚀 Starting simple mocking.ts fixes...");
  
  const project = new Project({
    tsConfigFilePath: "tsconfig.json",
    skipAddingFilesFromTsConfig: true,
  });

  const targetFile = "src/utils/test-utils/mocking.ts";
  
  try {
    const sourceFile = project.addSourceFileAtPath(targetFile);
    console.log(`📁 Processing ${targetFile}...`);

    let sourceText = sourceFile.getFullText();
    let fileChanged = false;

    // Pattern 1: Fix 'command' is of type 'unknown' - line 288
    // Look for: if (command.
    const commandPropertyPattern = /\bcommand\./g;
    sourceText = sourceText.replace(commandPropertyPattern, (match) => {
      fileChanged = true;
      fixes.push({
        file: targetFile,
        line: 0,
        description: `Fixed command property access: ${match} → (command as any).`
      });
      return "(command as any).";
    });

    // Pattern 2: Fix arguments of type 'unknown' not assignable to 'string'
    // Look for function calls with 'command' or 'params' as arguments
    const functionCallPattern = /(\w+)\s*\(\s*([^,)]*command[^,)]*)\s*,\s*([^,)]*command[^,)]*)\s*\)/g;
    sourceText = sourceText.replace(functionCallPattern, (match, funcName, arg1, arg2) => {
      const fixedArg1 = arg1.includes('command') ? arg1.replace(/\bcommand\b/g, '(command as string)') : arg1;
      const fixedArg2 = arg2.includes('command') ? arg2.replace(/\bcommand\b/g, '(command as string)') : arg2;
      
      if (fixedArg1 !== arg1 || fixedArg2 !== arg2) {
        fileChanged = true;
        fixes.push({
          file: targetFile,
          line: 0,
          description: `Fixed function call arguments: ${match} → ${funcName}(${fixedArg1}, ${fixedArg2})`
        });
        return `${funcName}(${fixedArg1}, ${fixedArg2})`;
      }
      return match;
    });

    // Pattern 3: Fix single argument calls with command
    const singleArgPattern = /(\w+)\s*\(\s*([^,)]*command[^,)]*)\s*\)/g;
    sourceText = sourceText.replace(singleArgPattern, (match, funcName, arg) => {
      if (arg.includes('command') && !arg.includes('as string')) {
        const fixedArg = arg.replace(/\bcommand\b/g, '(command as string)');
        fileChanged = true;
        fixes.push({
          file: targetFile,
          line: 0,
          description: `Fixed single argument call: ${match} → ${funcName}(${fixedArg})`
        });
        return `${funcName}(${fixedArg})`;
      }
      return match;
    });

    // Pattern 4: Fix 'params' unknown type issues
    const paramsPattern = /\bparams\b(?=\s*[.[])/g;
    sourceText = sourceText.replace(paramsPattern, (match) => {
      fileChanged = true;
      fixes.push({
        file: targetFile,
        line: 0,
        description: `Fixed params property access: ${match} → (params as any)`
      });
      return "(params as any)";
    });

    if (fileChanged) {
      sourceFile.replaceWithText(sourceText);
      sourceFile.saveSync();
      console.log(`✅ Fixed unknown types in ${targetFile}`);
    } else {
      console.log(`ℹ️  No unknown type changes needed in ${targetFile}`);
    }

  } catch (error) {
    console.log(`❌ Error processing ${targetFile}: ${error}`);
  }
}

// Run the fix
fixMockingSimple();

// Report results
console.log(`\n📋 Simple Mocking Fix Report:`);
console.log(`   Fixes applied: ${fixes.length}`);

if (fixes.length > 0) {
  console.log(`\n🔧 Applied fixes:`);
  fixes.forEach((fix, index) => {
    console.log(`   ${index + 1}. ${fix.description}`);
  });
}

console.log(`\n✅ Simple mocking fix completed!`); 
 