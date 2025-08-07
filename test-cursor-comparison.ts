/**
 * Test to compare Cursor's built-in edit_file with our Morph implementation
 * This will establish the ground truth for expected behavior
 */

// Create test fixture file
const testContent = `export class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }
}`;

// The edit pattern we're sending to Morph
const editPattern = `export class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }
  
  // ... existing code ...
  
  multiply(a: number, b: number): number {
    return a * b;
  }
}`;

console.log("=== CURSOR BUILT-IN EDIT_FILE COMPARISON TEST ===");
console.log("");
console.log("📋 Original Content:");
console.log(JSON.stringify(testContent));
console.log("");
console.log("📝 Edit Pattern:");
console.log(JSON.stringify(editPattern));
console.log("");
console.log("🎯 Instructions:");
console.log("1. Create a new file 'calculator-test.ts' with the original content above");
console.log("2. Use Cursor's built-in edit_file tool with this exact edit pattern:");
console.log("3. Copy the result here to compare with our Morph output");
console.log("");
console.log("📊 Our Morph Output (155 chars):");
console.log(JSON.stringify(`export class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }
  
  multiply(a: number, b: number): number {
    return a * b;
  }
}`));
console.log("");
console.log("❓ Question: Does Cursor's output match our Morph output?");