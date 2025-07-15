#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "fs";
import { glob } from "glob";

async function fixSyntaxErrors() {
  console.log("🔧 Fixing syntax errors introduced by automated fixes...");
  
  const files = await glob("src/**/*.ts", { absolute: true });
  let totalFixes = 0;
  
  for (const file of files) {
    const content = readFileSync(file, "utf-8");
    const originalContent = content;
    
    // Fix (this as unknown)?.name = "ErrorName"; -> (this as unknown).name = "ErrorName";
    let fixedContent = content.replace(/\(this as unknown\)\?\.name = /g, "(this as unknown).name = ");
    
    // Fix other potential ?. assignment issues
    fixedContent = fixedContent.replace(/\(this as unknown\)\?\.([a-zA-Z_][a-zA-Z0-9_]*) = /g, "(this as unknown).$1 = ");
    
    if (fixedContent !== originalContent) {
      writeFileSync(file, fixedContent);
      const fixes = (originalContent.match(/\(this as unknown\)\?\./g) || []).length;
      console.log(`✅ Fixed ${fixes} syntax errors in ${file}`);
      totalFixes += fixes;
    }
  }
  
  console.log(`\n📊 Total syntax fixes applied: ${totalFixes}`);
}

if (import.meta.main) {
  fixSyntaxErrors().catch(console.error);
} 
