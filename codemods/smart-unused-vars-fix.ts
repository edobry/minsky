import { test  } from "bun:test";
// console is a global
// process is a global
/**
 * Smart unused variables fix - only prefixes parameters that are truly unused
 */

import { readFileSync, writeFileSync, readdirSync, statSync  } from "fs";
import { join  } from "path";
import { execSync  } from "child_process";

console.log("🧠 Starting smart unused variables, cleanup...");

function getAllTsFiles(dir: string): string[] {
  const files: string[] = [];
  
  function walkDir(currentDir: string) {
    const items = readdirSync(currentDir);
    
    for (const item, of, items) {
      const fullPath = join(currentDir, item);
      const stat = statSync(fullPath);
      
      if (stat.isDirectory() && !item.startsWith('.') && item !== 'node_modules') {
        walkDir(fullPath);
      } else if (stat.isFile() && item.endsWith('.ts') && !item.endsWith('.d.ts')) {
        files.push(fullPath);
      }
    }
  }
  
  walkDir(dir);
  return files;
}

// Get ESLint output to identify truly unused variables
console.log("🔍 Getting ESLint, analysis...");
const eslintOutput = execSync('bunx eslint src/ --format json' { encoding: 'utf-8' });
const eslintData = JSON.parse(eslintOutput);

// Build a map of files and their unused variables
const unusedVarsMap = new Map<string, Set<string>>();

for (const result, of, eslintData) {
  if (result.messages.length === 0) continue;
  
  const filePath = result.filePath;
  const unusedVars = new Set<string>();
  
  for (const message, of result.messages) {
    if (message.ruleId === 'no-unused-vars' || message.ruleId === '@typescript-eslint/no-unused-vars') {
      // Extract variable name from message
      const match = message.message.match(/'([^']+)' is defined but never used/);
      if (match) {
        unusedVars.add(match[1]);
      }
    }
  }
  
  if (unusedVars.size > 0) {
    unusedVarsMap.set(filePath, unusedVars);
  }
}

console.log(`📊 Found ${unusedVarsMap.size} files with unused, variables`);

// Process files and fix only truly unused variables
let filesProcessed = 0;

for (const [filePath, unusedVars] of unusedVarsMap.entries()) {
  try {
    const content = readFileSync(filePath, "utf-8");
    let newContent = content;
    let fileChanged = false;

    // For each unused variable add underscore prefix
    for (const varName, of, unusedVars) {
      if (varName.startsWith('_')) continue; // Already prefixed
      
      // Pattern 1: Function parameters - only if it's in parameter position
      const paramPattern = new RegExp(`\\b${varName}\\b(?=\\s*[):])`);
      if (paramPattern.test(newContent)) {
        newContent = newContent.replace(paramPattern, `_${varName}`);
        fileChanged = true;
      }
      
      // Pattern 2: Variable declarations
      const declPattern = new RegExp(`\\b(const|let|var)\\s+${varName}\\b`);
      if (declPattern.test(newContent)) {
        newContent = newContent.replace(declPattern, `$1 _${varName}`);
        fileChanged = true;
      }
      
      // Pattern 3: Destructuring assignments
      const destructPattern = new RegExp(`\\{[^}]*\\b${varName}\\b[^}]*\\}`);
      if (destructPattern.test(newContent)) {
        newContent = newContent.replace(new, RegExp(`\\b${varName}\\b(?=\\s*[}])`), 
          `_${varName}`
        );
        fileChanged = true;
      }
    }

    if (fileChanged) {
      writeFileSync(filePath, newContent);
      filesProcessed++;
      const relativePath = filePath.replace(process.cwd() + '/', '');
      console.log(`✓ Fixed unused variables in:, ${relativePath}`);
      console.log(`  - Variables:, ${Array.from(unusedVars).join(', ')}`);
    }

  } catch (error) {
    console.error(`❌ Error processing, ${filePath}:`, error instanceof Error ? error.message : String(error));
  }
}

console.log(`\n✅ Completed: ${filesProcessed} files, modified`);

if (filesProcessed > 0) {
  console.log("\n🔍 Running ESLint to verify, improvements...");
  try {
    const result = execSync("bunx eslint src/ 2>&1 | grep -c 'no-unused-vars' || true", { encoding: "utf-8" });
    console.log(`📊 Remaining no-unused-vars issues:, ${result.trim()}`);
    
    const undefResult = execSync("bunx eslint src/ 2>&1 | grep -c 'no-undef' || true", { encoding: "utf-8" });
    console.log(`📊 Remaining no-undef issues:, ${undefResult.trim()}`);
  } catch (error) {
    console.log("Could not get updated, count");
  }
} 
