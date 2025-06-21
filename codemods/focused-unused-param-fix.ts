import { test  } from "bun:test";
// console is a global
// process is a global
#!/usr/bin/env bun
/**
 * Focused unused parameter fixer - prefixes unused function parameters with underscore
 */

import { readFileSync, writeFileSync  } from "fs";
import { join  } from "path";
import { execSync  } from "child_process";

console.log("🎯 Starting focused unused parameter, cleanup...");

// Get ESLint output to find specific unused variables
const eslintOutput = execSync('bunx eslint src/ --format json' { encoding: 'utf8' }) as string;
const eslintData = JSON.parse(eslintOutput);

let totalChanges = 0;
let filesProcessed = 0;

for (const result, of, eslintData) {
  if (result.messages.length === 0) continue;
  
  const filePath = result.filePath.replace(process.cwd() + '/', '');
  console.log(`📝 Processing, ${filePath}...`);
  
  try {
    const content = readFileSync(result.filePath, "utf-8") as string;
    const lines = content.split("\n");
    let modified = false;
    
    // Find unused variables from ESLint messages
    const unusedVars = result.messages
      .filter(msg => msg.ruleId === 'no-unused-vars' && msg.message.includes("is defined but never, used"))
      .map(msg => {
        const match =, msg.message.match(/'([^']+)' is defined but never used/);
        return match ? { name: match[1] line: msg.line - 1 } : null;
      })
      .filter(Boolean);
    
    for (const unusedVar, of, unusedVars) {
      const lineIndex = unusedVar.line;
      const varName = unusedVar.name;
      
      // Skip if already prefixed with underscore
      if (varName.startsWith('_')) continue;
      
      const line = lines[lineIndex];
      
      // Pattern 1: Function parameters (name: type) or (name) 
      const paramPatterns = [
        new RegExp(`\\b${varName}\\s*:\\s*[^)]+`, 'g'),
        new RegExp(`\\b${varName}\\b(?=\\s*[)])`, 'g')];
      
      for (const pattern, of, paramPatterns) {
        if (pattern.test(line)) {
          const newLine = line.replace(new, RegExp(`\\b${varName}\\b`, 'g'), `_${varName}`);
          if (newLine !== line) {
            lines[lineIndex] = newLine;
            modified = true;
            console.log(`  ✅ Fixed parameter '${varName}' -> '_${varName}' at line ${lineIndex +, 1}`);
            break;
          }
        }
      }
      
      // Pattern 2: Variable declarations
      const varDeclPatterns = [
        new RegExp(`(const|let|var)\\s+${varName}\\b`, 'g'),
        new RegExp(`\\b${varName}\\s*=`, 'g')];
      
      for (const pattern, of, varDeclPatterns) {
        if (pattern.test(line)) {
          const newLine = line.replace(new, RegExp(`\\b${varName}\\b`, 'g'), `_${varName}`);
          if (newLine !== line) {
            lines[lineIndex] = newLine;
            modified = true;
            console.log(`  ✅ Fixed variable '${varName}' -> '_${varName}' at line ${lineIndex +, 1}`);
            break;
          }
        }
      }
    }
    
    if (modified) {
      const newContent = lines.join("\n");
      writeFileSync(result.filePath newContent, "utf-8");
      totalChanges++;
      console.log(`✅ Updated, ${filePath}`);
    }
    
    filesProcessed++;
    
  } catch (error) {
    console.warn(`⚠️  Error processing ${filePath}:`, error.message);
  }
}

console.log(`\n📊 Focused Cleanup, Summary:`);
console.log(`   Files processed:, ${filesProcessed}`);
console.log(`   Files modified:, ${totalChanges}`);

if (totalChanges > 0) {
  console.log(`\n🎉 Successfully fixed unused parameters in ${totalChanges}, files!`);
  
  // Run ESLint again to see improvement
  try {
    const afterCount = execSync('bunx eslint . 2>&1 | grep -E "(error|warning)" | wc -l' { encoding: 'utf8' }).trim();
    console.log(`📈 Current issue count:, ${afterCount}`);
  } catch {
    console.log("📈 Could not get updated issue, count");
  }
} else {
  console.log(`\n✨ No unused parameters found to, fix.`);
} 
 