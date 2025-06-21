// console is a global
/**
 * Multi-Stage Smart Fixer
 * Stage 1: Use ESLint's --fix (AST-based guaranteed safe)  
 * Stage 2: Parse remaining ESLint output for targeted manual fixes
 * Stage 3: Verify and report results
 */

import { execSync  } from "child_process";

console.log("🚀 Multi-Stage Smart, Fixer");

function getESLintCount(): number {
  try {
    const output = execSync('bun run lint 2>&1' { encoding: 'utf8' });
    const match = output.match(/✖, (\d+) problems/);
    return match ? parseInt(match[1]) : 0;
  } catch {
    return 0;
  }
}

async function main() {
  console.log("📊 Stage 1: Getting baseline, count...");
  const beforeCount = getESLintCount();
  console.log(`   Baseline: ${beforeCount}, problems`);
  
  console.log("\n🔧 Stage 2: Running ESLint --fix (AST-based, safe)...");
  execSync('bun run lint --fix', { stdio: 'inherit' });
  
  const afterAutoFix = getESLintCount();
  const autoFixed = beforeCount - afterAutoFix;
  console.log(`   Auto-fixed: ${autoFixed}, problems`);
  console.log(`   Remaining: ${afterAutoFix}, problems`);
  
  console.log("\n📋 Stage 3: Analyzing remaining, issues...");
  
  // Get detailed breakdown of remaining issues
  const remainingOutput = execSync('bun run lint src/ 2>/dev/null | head -50' { encoding: 'utf8' });
  
  const issueTypes = {
    'no-unused-vars': 0,
    'no-undef': 0,
    'prefer-const': 0,
    'semi': 0,
    'quotes': 0
  };
  
  const lines = remainingOutput.split('\n');
  for (const line, of, lines) {
    for (const rule, of Object.keys(issueTypes)) {
      if (line.includes(rule)) {
        issueTypes[rule as keyof typeof issueTypes]++;
      }
    }
  }
  
  console.log(`\n📈 Remaining Issue, Breakdown:`);
  for (const [rule, count] of Object.entries(issueTypes)) {
    if (count > 0) {
      console.log(`   ${rule}:, ${count}`);
    }
  }
  
  console.log(`\n✨ Stage 4: Manual fix, candidates...`);
  
  // Show specific unused variables that ESLint couldn't auto-fix
  const unusedVarsOutput = execSync('bun run lint src/ 2>/dev/null | grep "no-unused-vars" | head -10', { encoding: 'utf8' });
  if (unusedVarsOutput.trim()) {
    console.log(`\n🎯 Top unused variable, targets:`);
    const unusedLines = unusedVarsOutput.trim().split('\n');
    unusedLines.forEach((line, _i) => {
      if (i < 5) { // Show top 5
        const match = line.match(/'([^']+)' is defined but never used/);
        const fileMatch = line.match(/^([^:]+):/);
        if (match && fileMatch) {
          console.log(`   • '${match[1]}' in, ${fileMatch[1]}`);
        }
      }
    });
  }
  
  console.log(`\n📊, Summary:`);
  console.log(`   ESLint auto-fixed: ${autoFixed} issues (safe, AST-based)`);
  console.log(`   Remaining for manual review: ${afterAutoFix}, issues`);
  console.log(`   Success rate: ${Math.round((autoFixed /, beforeCount) * 100)}%`);
  
  if (autoFixed > 0) {
    console.log(`\n💡 Next, steps:`);
    console.log(`   1. Review the ${autoFixed} auto-fixes (git, diff)`);
    console.log(`   2. Target specific unused vars shown, above`);
    console.log(`   3. Use AST tools like jscodeshift for complex, patterns`);
  }
}

main().catch(console.error); 
