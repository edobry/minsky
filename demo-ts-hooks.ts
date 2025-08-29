#!/usr/bin/env bun

/**
 * Demo: TypeScript Git Hooks vs Bash Implementation
 * 
 * Shows the differences between the old bash approach and new TypeScript approach
 */

import { ProjectConfigReader } from "./src/domain/project/config-reader";
import { execAsync } from "./src/utils/exec";

async function demoTSHooks() {
  console.log("🎯 TypeScript Git Hooks Demo\n");
  
  console.log("📊 COMPARISON: Bash vs TypeScript Implementation\n");
  
  // 1. Configuration Loading
  console.log("1️⃣ Configuration Loading:");
  console.log("   ❌ Bash: Hardcoded 'bun run lint' command");
  console.log("   ✅ TypeScript: Config-aware via ProjectConfigReader");
  
  const configReader = new ProjectConfigReader(process.cwd());
  const config = await configReader.getConfiguration();
  const lintJsonCommand = await configReader.getLintJsonCommand();
  
  console.log(`   📋 Detected config source: ${config.configSource}`);
  console.log(`   📋 Lint command: ${lintJsonCommand}`);
  
  // 2. JSON Parsing
  console.log("\n2️⃣ JSON Parsing:");
  console.log("   ❌ Bash: grep -o '\"errorCount\":[0-9]*' | cut -d: -f2 | awk");
  console.log("   ✅ TypeScript: JSON.parse() with proper error handling");
  
  // Demonstrate the TypeScript approach
  try {
    const { stdout } = await execAsync(lintJsonCommand, { timeout: 10000 });
    const lintResults = JSON.parse(stdout || "[]");
    
    // Type-safe aggregation
    const totalErrors = lintResults.reduce((sum: number, result: any) => sum + result.errorCount, 0);
    const totalWarnings = lintResults.reduce((sum: number, result: any) => sum + result.warningCount, 0);
    
    console.log(`   📊 Results: ${totalErrors} errors, ${totalWarnings} warnings`);
    console.log(`   📝 Files analyzed: ${lintResults.length}`);
    
  } catch (error) {
    console.log(`   ⚠️ Lint execution failed: ${error}`);
  }
  
  // 3. Error Handling
  console.log("\n3️⃣ Error Handling:");
  console.log("   ❌ Bash: Basic exit codes, limited error context");
  console.log("   ✅ TypeScript: Structured HookResult with detailed messages");
  
  // 4. Maintainability
  console.log("\n4️⃣ Maintainability:");
  console.log("   ❌ Bash: 176 lines of complex shell script");
  console.log("   ✅ TypeScript: ~400 lines of well-structured, testable code");
  
  // 5. Type Safety
  console.log("\n5️⃣ Type Safety:");
  console.log("   ❌ Bash: Runtime failures from shell parsing errors");
  console.log("   ✅ TypeScript: Compile-time error detection");
  
  // 6. Infrastructure Reuse
  console.log("\n6️⃣ Infrastructure Reuse:");
  console.log("   ❌ Bash: Reinvents JSON parsing, config loading");
  console.log("   ✅ TypeScript: Leverages ProjectConfigReader, execAsync, logger");
  
  console.log("\n🎉 KEY BENEFITS:");
  console.log("   • No more fragile grep/awk/cut string manipulation");
  console.log("   • Uses same config loading as CLI commands");
  console.log("   • Type-safe ESLint result processing");
  console.log("   • Better error messages and debugging");
  console.log("   • Easier to test and maintain");
  console.log("   • Consistent with Minsky's TypeScript architecture");
}

demoTSHooks().catch(console.error);
