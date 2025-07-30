#!/usr/bin/env bun
/**
 * XML Format Demonstration
 *
 * Shows the exact difference between incorrect and correct Morph API format
 */

const testCode = `function example() {
  console.log("hello");
}`;

const testEdit = `function example() {
  // ... existing code ...
  console.log("hello world!");
  // ... existing code ...
}`;

const testInstructions = "I am updating the console log message";

console.log("🔧 **Morph API Format Correction**\n");

console.log("❌ **INCORRECT FORMAT (What we had before):**");
const incorrectFormat = `${testInstructions}
\`${testCode}\`
${testEdit}`;

console.log('"""');
console.log(incorrectFormat);
console.log('"""\n');

console.log("✅ **CORRECT XML FORMAT (What Morph actually expects):**");
const correctFormat = `<instruction>${testInstructions}</instruction>
<code>${testCode}</code>
<update>${testEdit}</update>`;

console.log('"""');
console.log(correctFormat);
console.log('"""\n');

console.log("🎯 **Key Differences:**");
console.log("1. ✅ Instructions wrapped in <instruction> tags (not raw text)");
console.log("2. ✅ Original code wrapped in <code> tags (not backticks)");
console.log("3. ✅ Edit pattern wrapped in <update> tags (not raw text)");
console.log("4. ✅ Structured XML format for better model parsing");

console.log("\n📡 **HTTP Request Content (Corrected):**");
const httpContent = {
  role: "user",
  content: correctFormat,
};

console.log(JSON.stringify(httpContent, null, 2));

console.log("\n✅ **Now correctly matches Morph's official specification!**");

if (import.meta.main) {
  // This runs when executed directly
}
