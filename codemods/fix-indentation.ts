import { execSync } from "child_process";

console.log("Running ESLint with --fix to automatically correct indentation and other fixable issues...");

try {
  // Run ESLint with --fix flag to automatically correct fixable issues
  const result = execSync("bun run lint --fix", { 
    encoding: "utf8",
    cwd: process.cwd()
  });
  
  console.log("ESLint --fix completed successfully");
  console.log(result);
} catch (error: any) {
  // ESLint returns non-zero exit code even when fixes are applied, so check the output
  if (error.stdout) {
    console.log("ESLint --fix applied fixes:");
    console.log(error.stdout);
  }
  if (error.stderr) {
    console.log("ESLint stderr:");
    console.log(error.stderr);
  }
  
  console.log("ESLint --fix process completed (may have fixed issues despite non-zero exit)");
} 
