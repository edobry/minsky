import { VariableNamingFixer } from "./codemods/variable-naming-fixer-consolidated";
import { writeFileSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";

// Create test directory
const testDir = "/tmp/debug-variable-naming";
mkdirSync(testDir, { recursive: true });

// Create test file
const testFile = join(testDir, "test.ts");
const originalCode = `
const _result = fetchData();
console.log(result.status);
return result.data;`;

writeFileSync(testFile, originalCode);

console.log("Original code:");
console.log(originalCode);

// Run the fixer
const fixer = new VariableNamingFixer();
fixer.processFiles(`${testDir}/**/*.ts`).then(() => {
  const fixedCode = readFileSync(testFile, "utf-8");
  console.log("\nFixed code:");
  console.log(fixedCode);

  console.log("\nComparison:");
  console.log("Expected: const result = fetchData();");
  console.log(`Got:      ${  fixedCode.split("\n")[1]}`);
});
